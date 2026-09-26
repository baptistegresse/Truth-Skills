import express from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VOTE_SCOPE, type Config } from "./config.js";
import { TruthSkillsAuthProvider } from "./auth/provider.js";
import type { Queryable } from "./db/pool.js";
import { createMcpServer } from "./mcp/server.js";

export interface AppOptions {
  config: Pick<Config, "PUBLIC_URL" | "JWT_SECRET">;
  db: Queryable;
  // Overrides the provider's token check (tests only).
  verifier?: OAuthTokenVerifier;
}

export const createApp = ({ config, db, verifier }: AppOptions) => {
  const app = express();
  app.disable("x-powered-by");

  // The canonical URL of the MCP server: the RFC 8707 resource and the aud of every access token.
  const resourceUrl = new URL("/mcp", config.PUBLIC_URL);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

  const provider = new TruthSkillsAuthProvider(db, config, resourceUrl);

  // The authorization server: /authorize, /token, /register, the RFC 8414 metadata, and the
  // RFC 9728 protected resource metadata that tells the client which authorization server to use.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.PUBLIC_URL),
      scopesSupported: [VOTE_SCOPE],
      resourceServerUrl: resourceUrl,
      resourceName: "Truth-Skills",
    }),
  );

  const bearer = requireBearerAuth({
    verifier: verifier ?? provider,
    requiredScopes: [VOTE_SCOPE],
    resourceMetadataUrl,
  });

  // Stateless Streamable HTTP: one McpServer + transport per request, no Mcp-Session-Id.
  // bearer runs before express.json, so an unauthenticated body is never parsed.
  app.post("/mcp", bearer, express.json({ limit: "256kb" }), async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "Method not allowed" });
  });

  return app;
};
