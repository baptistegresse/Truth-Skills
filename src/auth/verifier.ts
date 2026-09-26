import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

// Stand-in until the OAuth provider issues tokens: every token is refused, so every /mcp call gets
// the 401 that starts discovery. It must throw InvalidTokenError: requireBearerAuth turns any
// other error into a 500, and a client only re-authenticates on a 401.
export const rejectAllTokens: OAuthTokenVerifier = {
  async verifyAccessToken() {
    throw new InvalidTokenError("Invalid or expired access token");
  },
};
