import { createHash } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { TruthSkillsAuthProvider } from "../src/auth/provider.js";
import { hashToken, randomToken, signAccessToken } from "../src/auth/tokens.js";
import { runMigrations } from "../src/db/migrate.js";
import { testConfig } from "./helpers/config.js";
import { createTestDb } from "./helpers/pglite.js";

const config = testConfig();
const RESOURCE = "http://localhost:3000/mcp";
const CALLBACK = "http://localhost:51938/callback";

const pkce = () => {
  const verifier = randomToken();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

// The whole OAuth flow against a real (in-process) Postgres, with the World ID sign-in replaced by
// a direct call to completeAuthorization, which is what the sign-in page ends with.
describe("OAuth flow", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: ReturnType<typeof createApp>;
  let provider: TruthSkillsAuthProvider;
  let clientId: string;

  beforeAll(async () => {
    db = await createTestDb();
    await runMigrations(db);
    app = createApp({ config, db });
    provider = new TruthSkillsAuthProvider(db, config, new URL(RESOURCE));
    const res = await request(app)
      .post("/register")
      .send({ client_name: "Claude Code (truth-skills)", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" });
    clientId = res.body.client_id;
  });
  afterAll(async () => {
    await db.close();
  });

  const createAccount = async () =>
    (await db.query<{ id: string }>("insert into accounts default values returning id")).rows[0]!.id;

  const authorize = (challenge: string, params: Record<string, string> = {}) =>
    request(app)
      .get("/authorize")
      .query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "state-1",
        scope: "skills:vote",
        resource: RESOURCE,
        ...params,
      });

  const startLogin = async (challenge: string) => {
    const res = await authorize(challenge);
    return new URL(res.headers.location!).searchParams.get("req")!;
  };

  // /authorize, then a finished sign-in for the account. Returns the code from the callback URL.
  const signIn = async (accountId: string, challenge: string) => {
    const callback = new URL(await provider.completeAuthorization(await startLogin(challenge), accountId));
    return callback.searchParams.get("code")!;
  };

  const token = (body: Record<string, string>) =>
    request(app)
      .post("/token")
      .type("form")
      .send({ client_id: clientId, ...body });

  const exchange = (code: string, verifier: string, extra: Record<string, string> = {}) =>
    token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK, resource: RESOURCE, ...extra });

  const refresh = (refreshToken: string, extra: Record<string, string> = {}) =>
    token({ grant_type: "refresh_token", refresh_token: refreshToken, resource: RESOURCE, ...extra });

  const callMcp = (accessToken: string) =>
    request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("authorization", `Bearer ${accessToken}`)
      .send(initialize);

  const connect = async (accountId?: string) => {
    const account = accountId ?? (await createAccount());
    const { verifier, challenge } = pkce();
    const res = await exchange(await signIn(account, challenge), verifier);
    return { accountId: account, tokens: res.body as { access_token: string; refresh_token: string } };
  };

  describe("GET /authorize", () => {
    it("saves the login request and redirects to the sign-in page", async () => {
      const { challenge } = pkce();
      const res = await authorize(challenge);
      expect(res.status).toBe(302);
      const requestId = new URL(res.headers.location!).searchParams.get("req");

      const { rows } = await db.query<Record<string, unknown>>(
        `select client_id, redirect_uri, code_challenge, state, scopes, resource, step, account_id,
                extract(epoch from expires_at - now())::int as ttl
         from auth_requests where id = $1`,
        [requestId],
      );
      expect(rows[0]).toMatchObject({
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: challenge,
        state: "state-1",
        scopes: ["skills:vote"],
        resource: RESOURCE,
        step: "start",
        account_id: null,
      });
      expect(rows[0]!.ttl).toBeGreaterThan(590);
      expect(rows[0]!.ttl).toBeLessThanOrEqual(600);
    });

    it("defaults to skills:vote when no scope is asked", async () => {
      const res = await authorize(pkce().challenge, { scope: "" });
      const requestId = new URL(res.headers.location!).searchParams.get("req");
      const { rows } = await db.query<{ scopes: string[] }>("select scopes from auth_requests where id = $1", [requestId]);
      expect(rows[0]!.scopes).toEqual(["skills:vote"]);
    });

    it.each([
      ["another resource", { resource: "https://other.example/mcp" }, "invalid_target"],
      ["an unknown scope", { scope: "skills:vote admin" }, "invalid_scope"],
    ])("sends %s back to the client as an error", async (_label, params, error) => {
      const res = await authorize(pkce().challenge, params);
      const location = new URL(res.headers.location!);
      expect(location.origin + location.pathname).toBe(CALLBACK);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("state")).toBe("state-1");
    });
  });

  describe("completeAuthorization", () => {
    it("closes the login request and returns the callback with a code and the state", async () => {
      const accountId = await createAccount();
      const requestId = await startLogin(pkce().challenge);
      const callback = new URL(await provider.completeAuthorization(requestId, accountId));

      expect(callback.origin + callback.pathname).toBe(CALLBACK);
      expect(callback.searchParams.get("state")).toBe("state-1");
      const code = callback.searchParams.get("code")!;
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

      expect((await db.query("select 1 from auth_requests where id = $1", [requestId])).rows).toHaveLength(0);
      const stored = await db.query<{ code_hash: string; ttl: number }>(
        "select code_hash, extract(epoch from expires_at - now())::int as ttl from auth_codes where account_id = $1",
        [accountId],
      );
      expect(stored.rows[0]!.code_hash).toBe(hashToken(code)); // never the code itself
      expect(stored.rows[0]!.ttl).toBeLessThanOrEqual(60);
    });

    it("yields at most one code per login request", async () => {
      const accountId = await createAccount();
      const requestId = await startLogin(pkce().challenge);
      await provider.completeAuthorization(requestId, accountId);
      await expect(provider.completeAuthorization(requestId, accountId)).rejects.toThrow(/expired or unknown/);
    });

    it("refuses an expired login request", async () => {
      const requestId = await startLogin(pkce().challenge);
      await db.query("update auth_requests set expires_at = now() - interval '1 second' where id = $1", [requestId]);
      await expect(provider.completeAuthorization(requestId, await createAccount())).rejects.toThrow(/expired/);
    });
  });

  describe("POST /token with an authorization code", () => {
    it("issues a 1-hour Bearer token and a refresh token that open /mcp", async () => {
      const { verifier, challenge } = pkce();
      const res = await exchange(await signIn(await createAccount(), challenge), verifier);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "skills:vote" });
      expect(res.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const mcp = await callMcp(res.body.access_token);
      expect(mcp.status).toBe(200);
      expect(mcp.body.result.serverInfo.name).toBe("truth-skills");
    });

    it("accepts a code only once", async () => {
      const { verifier, challenge } = pkce();
      const code = await signIn(await createAccount(), challenge);
      expect((await exchange(code, verifier)).status).toBe(200);
      const again = await exchange(code, verifier);
      expect(again.status).toBe(400);
      expect(again.body.error).toBe("invalid_grant");
    });

    it("refuses a wrong PKCE verifier", async () => {
      const code = await signIn(await createAccount(), pkce().challenge);
      const res = await exchange(code, pkce().verifier);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("refuses a code issued to another client", async () => {
      const other = await request(app)
        .post("/register")
        .send({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" });
      const { verifier, challenge } = pkce();
      const code = await signIn(await createAccount(), challenge);
      const res = await exchange(code, verifier, { client_id: other.body.client_id });
      expect(res.body.error).toBe("invalid_grant");
    });

    it("refuses an expired code", async () => {
      const { verifier, challenge } = pkce();
      const code = await signIn(await createAccount(), challenge);
      await db.query("update auth_codes set expires_at = now() - interval '1 second' where code_hash = $1", [
        hashToken(code),
      ]);
      expect((await exchange(code, verifier)).body.error).toBe("invalid_grant");
    });

    it("refuses a different redirect_uri", async () => {
      const { verifier, challenge } = pkce();
      const code = await signIn(await createAccount(), challenge);
      const res = await exchange(code, verifier, { redirect_uri: "http://localhost:51938/other" });
      expect(res.body.error).toBe("invalid_grant");
    });

    it("refuses another resource", async () => {
      const { verifier, challenge } = pkce();
      const code = await signIn(await createAccount(), challenge);
      const res = await exchange(code, verifier, { resource: "https://other.example/mcp" });
      expect(res.body.error).toBe("invalid_target");
    });
  });

  describe("POST /token with a refresh token", () => {
    it("rotates: a new pair for the same account, and the old refresh token is dead", async () => {
      const { accountId, tokens } = await connect();
      const res = await refresh(tokens.refresh_token);
      expect(res.status).toBe(200);
      expect(res.body.refresh_token).not.toBe(tokens.refresh_token);
      expect((await callMcp(res.body.access_token)).status).toBe(200);

      const reuse = await refresh(tokens.refresh_token);
      expect(reuse.body.error).toBe("invalid_grant");

      const { rows } = await db.query<{ active: number }>(
        "select count(*)::int as active from refresh_tokens where account_id = $1 and revoked_at is null",
        [accountId],
      );
      expect(rows[0]!.active).toBe(1);
    });

    it("refuses a wider scope without consuming the refresh token", async () => {
      const { tokens } = await connect();
      const res = await refresh(tokens.refresh_token, { scope: "skills:vote admin" });
      expect(res.body.error).toBe("invalid_scope");
      expect((await refresh(tokens.refresh_token)).status).toBe(200);
    });

    it("refuses an expired refresh token", async () => {
      const { tokens } = await connect();
      await db.query("update refresh_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [
        hashToken(tokens.refresh_token),
      ]);
      expect((await refresh(tokens.refresh_token)).body.error).toBe("invalid_grant");
    });
  });

  describe("POST /revoke", () => {
    it("is advertised in the metadata", async () => {
      const res = await request(app).get("/.well-known/oauth-authorization-server");
      expect(res.body.revocation_endpoint).toBe("http://localhost:3000/revoke");
    });

    it("revokes a refresh token of the client", async () => {
      const { tokens } = await connect();
      const res = await request(app).post("/revoke").type("form").send({ client_id: clientId, token: tokens.refresh_token });
      expect(res.status).toBe(200);
      expect((await refresh(tokens.refresh_token)).body.error).toBe("invalid_grant");
    });

    it("ignores an unknown token (RFC 7009)", async () => {
      const res = await request(app).post("/revoke").type("form").send({ client_id: clientId, token: "unknown" });
      expect(res.status).toBe(200);
    });
  });

  describe("access token checks on /mcp", () => {
    it("stops a deleted account at its next call and refresh", async () => {
      const { accountId, tokens } = await connect();
      await db.query("update accounts set deleted_at = now() where id = $1", [accountId]);
      const res = await callMcp(tokens.access_token);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
      expect((await refresh(tokens.refresh_token)).body.error).toBe("invalid_grant");
    });

    it("refuses a well-signed token for an unknown account", async () => {
      const forged = await signAccessToken(
        { accountId: "00000000-0000-0000-0000-000000000000", clientId, scopes: ["skills:vote"], resource: RESOURCE },
        config.JWT_SECRET,
        "http://localhost:3000/",
        3600,
      );
      expect((await callMcp(forged)).status).toBe(401);
    });

    it("hands the account id to MCP handlers through authInfo", async () => {
      const { accountId, tokens } = await connect();
      const info = await provider.verifyAccessToken(tokens.access_token);
      expect(info).toMatchObject({ clientId, scopes: ["skills:vote"], extra: { accountId } });
      expect(info.resource?.href).toBe(RESOURCE);
    });
  });
});
