import express from "express";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VOTE_SCOPE, type Config } from "./config.js";
import { rejectAllTokens } from "./auth/verifier.js";
import { createMcpServer } from "./mcp/server.js";

export interface AppOptions {
  config: Pick<Config, "PUBLIC_URL">;
  verifier?: OAuthTokenVerifier;
}

export const createApp = ({ config, verifier = rejectAllTokens }: AppOptions) => {
  const app = express();
  app.disable("x-powered-by");

  // The canonical URL of the MCP server: the RFC 8707 resource and the aud of every access token.
  const resourceUrl = new URL("/mcp", config.PUBLIC_URL);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

  // Protected Resource Metadata (RFC 9728): tells the client which authorization server to use.
  app.use(
    new URL(resourceMetadataUrl).pathname,
    metadataHandler({
      resource: resourceUrl.href,
      authorization_servers: [new URL(config.PUBLIC_URL).href],
      scopes_supported: [VOTE_SCOPE],
      resource_name: "Truth-Skills",
    }),
  );

  const bearer = requireBearerAuth({ verifier, requiredScopes: [VOTE_SCOPE], resourceMetadataUrl });

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
