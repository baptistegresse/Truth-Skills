import type { Response } from "express";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  ACCESS_TOKEN_TTL_S,
  AUTH_CODE_TTL_S,
  AUTH_REQUEST_TTL_S,
  REFRESH_TOKEN_TTL_S,
  VOTE_SCOPE,
  type Config,
} from "../config.js";
import type { Queryable } from "../db/pool.js";
import { PgClientsStore } from "./clientsStore.js";
import { hashToken, randomToken, signAccessToken, verifyAccessToken } from "./tokens.js";

const SUPPORTED_SCOPES = new Set([VOTE_SCOPE]);

// Accounts that may still receive tokens; a deleted account stops working at its next call.
const LIVE_ACCOUNT = "account_id in (select id from accounts where deleted_at is null)";

// The SDK splits the scope parameter on spaces, so "scope=" arrives as [""].
const nonEmpty = (scopes?: string[]) => (scopes ?? []).filter(Boolean);

interface Grant {
  accountId: string;
  clientId: string;
  scopes: string[];
}

// Our own OAuth 2.1 authorization server. /authorize saves a login request and hands the browser
// to the World ID sign-in page; that page calls completeAuthorization once it knows the account.
export class TruthSkillsAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PgClientsStore;
  private readonly issuer: string;

  constructor(
    private readonly db: Queryable,
    private readonly config: Pick<Config, "JWT_SECRET" | "PUBLIC_URL">,
    private readonly resourceUrl: URL,
  ) {
    this.clientsStore = new PgClientsStore(db);
    this.issuer = new URL(config.PUBLIC_URL).href;
  }

  // The SDK router has already checked the client, the redirect URI and the PKCE challenge.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.assertResource(params.resource);
    const asked = nonEmpty(params.scopes);
    const scopes = asked.length ? asked : [VOTE_SCOPE];
    this.assertSupportedScopes(scopes);

    const { rows } = await this.db.query<{ id: string }>(
      `insert into auth_requests (client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) returning id`,
      [
        client.client_id,
        params.redirectUri,
        params.codeChallenge,
        params.state ?? null,
        scopes,
        this.resourceUrl.href,
        AUTH_REQUEST_TTL_S,
      ],
    );
    res.redirect(new URL(`/login?req=${rows[0]!.id}`, this.config.PUBLIC_URL).href);
  }

  // Closes the login request and issues its code in one statement, so a login request yields at
  // most one code. Returns the client's callback URL carrying the code and the original state.
  async completeAuthorization(authRequestId: string, accountId: string): Promise<string> {
    const code = randomToken();
    const { rows } = await this.db.query<{ redirect_uri: string; state: string | null }>(
      `with request as (
         delete from auth_requests where id = $1 and expires_at > now() returning *
       ), code as (
         insert into auth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, scopes, resource, expires_at)
         select $2, client_id, $3, redirect_uri, code_challenge, scopes, resource, now() + make_interval(secs => $4)
         from request
         returning 1
       )
       select request.redirect_uri, request.state from request, code`,
      [authRequestId, hashToken(code), accountId, AUTH_CODE_TTL_S],
    );
    const request = rows[0];
    if (!request) throw new Error("Authorization request expired or unknown");
    const target = new URL(request.redirect_uri);
    target.searchParams.set("code", code);
    if (request.state) target.searchParams.set("state", request.state);
    return target.href;
  }

  // The router compares base64url(SHA-256(code_verifier)) with this challenge itself.
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const { rows } = await this.db.query<{ code_challenge: string }>(
      `select code_challenge from auth_codes
       where code_hash = $1 and client_id = $2 and used_at is null and expires_at > now()`,
      [hashToken(code), client.client_id],
    );
    if (!rows[0]) throw new InvalidGrantError("Invalid authorization code");
    return rows[0].code_challenge;
  }

  // Marking the code used and reading it is one statement: two concurrent exchanges cannot both win.
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.assertResource(resource);
    const { rows } = await this.db.query<{ account_id: string; redirect_uri: string; scopes: string[] }>(
      `update auth_codes set used_at = now()
       where code_hash = $1 and client_id = $2 and used_at is null and expires_at > now() and ${LIVE_ACCOUNT}
       returning account_id, redirect_uri, scopes`,
      [hashToken(code), client.client_id],
    );
    const grant = rows[0];
    if (!grant) throw new InvalidGrantError("Invalid authorization code");
    if (redirectUri && redirectUri !== grant.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    return this.issueTokens({ accountId: grant.account_id, clientId: client.client_id, scopes: grant.scopes });
  }

  // Rotation: the presented refresh token is revoked and a new pair issued. A stolen refresh token
  // works once at most, and then breaks the legitimate client, which makes the theft visible.
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.assertResource(resource);
    const asked = nonEmpty(scopes);
    const requested = asked.length ? asked : null;
    if (requested) this.assertSupportedScopes(requested);
    // A refresh may narrow the scopes, never widen them (RFC 6749 §6). Checked in the same
    // statement, so a bad request does not consume a valid refresh token.
    const { rows } = await this.db.query<{ account_id: string; scopes: string[] }>(
      `update refresh_tokens set revoked_at = now()
       where token_hash = $1 and client_id = $2 and revoked_at is null and expires_at > now() and ${LIVE_ACCOUNT}
         and ($3::text[] is null or scopes @> $3::text[])
       returning account_id, scopes`,
      [hashToken(refreshToken), client.client_id, requested],
    );
    const grant = rows[0];
    if (!grant) throw new InvalidGrantError("Invalid refresh token");
    return this.issueTokens({
      accountId: grant.account_id,
      clientId: client.client_id,
      scopes: requested ?? grant.scopes,
    });
  }

  // RFC 7009: revokes a refresh token of this client; anything else is silently ignored. Access
  // tokens are not revocable one by one: they expire within the hour.
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.db.query(
      "update refresh_tokens set revoked_at = now() where token_hash = $1 and client_id = $2 and revoked_at is null",
      [hashToken(request.token), client.client_id],
    );
  }

  // Every failure must be an InvalidTokenError: requireBearerAuth answers 401 only for that class
  // (anything else is a 500), and a 401 is what tells the client to refresh or sign in again.
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const access = await verifyAccessToken(token, this.config.JWT_SECRET, this.issuer, this.resourceUrl.href).catch(
      () => {
        throw new InvalidTokenError("Invalid or expired access token");
      },
    );
    const { rows } = await this.db.query("select 1 from accounts where id = $1 and deleted_at is null", [
      access.accountId,
    ]);
    if (!rows[0]) throw new InvalidTokenError("Account not found");
    return {
      token,
      clientId: access.clientId,
      scopes: access.scopes,
      expiresAt: access.expiresAt,
      resource: this.resourceUrl,
      extra: { accountId: access.accountId }, // what tools read; never a tool argument
    };
  }

  private async issueTokens(grant: Grant): Promise<OAuthTokens> {
    const accessToken = await signAccessToken(
      { ...grant, resource: this.resourceUrl.href },
      this.config.JWT_SECRET,
      this.issuer,
      ACCESS_TOKEN_TTL_S,
    );
    const refreshToken = randomToken();
    await this.db.query(
      `insert into refresh_tokens (token_hash, account_id, client_id, scopes, resource, expires_at)
       values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [hashToken(refreshToken), grant.accountId, grant.clientId, grant.scopes, this.resourceUrl.href, REFRESH_TOKEN_TTL_S],
    );
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
      scope: grant.scopes.join(" "),
    };
  }

  private assertSupportedScopes(scopes: string[]) {
    const unknown = scopes.filter((scope) => !SUPPORTED_SCOPES.has(scope));
    if (unknown.length) throw new InvalidScopeError(`Unsupported scope: ${unknown.join(" ")}`);
  }

  // RFC 8707: tokens are only ever issued for our own /mcp endpoint.
  private assertResource(resource?: URL) {
    if (resource && resource.href !== this.resourceUrl.href) {
      throw new InvalidTargetError(`Unknown resource: ${resource.href}`);
    }
  }
}
