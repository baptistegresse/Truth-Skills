import request from "supertest";
import { describe, expect, it } from "vitest";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { createApp } from "../src/app.js";

const config = { PUBLIC_URL: "http://localhost:3000" };
const RESOURCE_METADATA = "http://localhost:3000/.well-known/oauth-protected-resource/mcp";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

// Accepts one token, with the given scopes; refuses everything else like a real verifier would.
const verifierFor = (scopes: string[]): OAuthTokenVerifier => ({
  async verifyAccessToken(token) {
    if (token !== "good") throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: "client", scopes, expiresAt: Math.floor(Date.now() / 1000) + 60 };
  },
});

const postMcp = (app: ReturnType<typeof createApp>, token?: string) => {
  const req = request(app).post("/mcp").set("accept", "application/json, text/event-stream");
  return token ? req.set("authorization", `Bearer ${token}`) : req;
};

describe("POST /mcp without a valid token", () => {
  const app = createApp({ config });

  it("answers 401 and points to the protected resource metadata", async () => {
    const res = await postMcp(app).send(initialize);
    expect(res.status).toBe(401);
    const header = res.headers["www-authenticate"];
    expect(header).toMatch(/^Bearer error="invalid_token"/);
    expect(header).toContain('scope="skills:vote"');
    expect(header).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
  });

  it("answers 401, not 500, to a forged token", async () => {
    const res = await postMcp(app, "forged.jwt.value").send(initialize);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("answers 401 to a non-Bearer scheme", async () => {
    const res = await request(app).post("/mcp").set("authorization", "Basic dXNlcjpwYXNz").send(initialize);
    expect(res.status).toBe(401);
  });

  it("rejects before parsing the body", async () => {
    const res = await postMcp(app).set("content-type", "application/json").send("{not json");
    expect(res.status).toBe(401);
  });
});

describe("POST /mcp with a token", () => {
  it("answers 403 insufficient_scope without skills:vote", async () => {
    const app = createApp({ config, verifier: verifierFor([]) });
    const res = await postMcp(app, "good").send(initialize);
    expect(res.status).toBe(403);
    expect(res.headers["www-authenticate"]).toContain('error="insufficient_scope"');
  });

  it("reaches the MCP server statelessly with skills:vote", async () => {
    const app = createApp({ config, verifier: verifierFor(["skills:vote"]) });
    const res = await postMcp(app, "good").send(initialize);
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe("truth-skills");
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });
});

describe("other methods on /mcp", () => {
  it.each(["get", "delete"] as const)("%s answers 405 with Allow: POST", async (method) => {
    const res = await request(createApp({ config }))[method]("/mcp");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });
});

describe("GET /.well-known/oauth-protected-resource/mcp", () => {
  it("serves the RFC 9728 metadata", async () => {
    const res = await request(createApp({ config })).get("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resource: "http://localhost:3000/mcp",
      authorization_servers: ["http://localhost:3000/"],
      scopes_supported: ["skills:vote"],
      resource_name: "Truth-Skills",
    });
  });

  it("follows PUBLIC_URL", async () => {
    const app = createApp({ config: { PUBLIC_URL: "https://truth-skills.example" } });
    const res = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(res.body.resource).toBe("https://truth-skills.example/mcp");
    const unauthorized = await postMcp(app).send(initialize);
    expect(unauthorized.headers["www-authenticate"]).toContain(
      'resource_metadata="https://truth-skills.example/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
