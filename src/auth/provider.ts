import { TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Queryable } from "../db/pool.js";
import { PgClientsStore } from "./clientsStore.js";
import { rejectAllTokens } from "./verifier.js";

const notYet = (step: string) => new TemporarilyUnavailableError(`${step} is not available yet`);

// The authorization server behind mcpAuthRouter. Client registration works; sign-in, codes and
// tokens are implemented in later branches. Until then every flow stops with an OAuth error the
// client understands, and every access token is refused with a 401.
export class TruthSkillsAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PgClientsStore;

  constructor(db: Queryable) {
    this.clientsStore = new PgClientsStore(db);
  }

  async authorize(): Promise<void> {
    throw notYet("Sign-in");
  }

  async challengeForAuthorizationCode(): Promise<string> {
    throw notYet("Code exchange");
  }

  async exchangeAuthorizationCode(): Promise<OAuthTokens> {
    throw notYet("Code exchange");
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw notYet("Token refresh");
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    return rejectAllTokens.verifyAccessToken(token);
  }
}
