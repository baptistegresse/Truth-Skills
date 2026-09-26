import request from "supertest";
import { expect } from "vitest";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { createApp } from "../../src/app.js";

// The bearer token is the account id; the real JWT path is covered in oauth-flow.test.ts.
export const accountIdVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    const extra = token === "no-account" ? {} : { accountId: token };
    return { token, clientId: "c", scopes: ["skills:vote"], expiresAt: Date.now() / 1000 + 60, extra };
  },
};

// JSON-RPC over POST /mcp as the given account, and tools/call with its result decoded.
export const mcpClient = (app: ReturnType<typeof createApp>) => {
  let id = 0;
  const rpc = async (accountId: string, method: string, params: object) => {
    const res = await request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("authorization", `Bearer ${accountId}`)
      .send({ jsonrpc: "2.0", id: ++id, method, params });
    expect(res.status).toBe(200);
    return res.body;
  };
  const callTool = async (accountId: string, name: string, args: object) => {
    const { result } = await rpc(accountId, "tools/call", { name, arguments: args });
    const text: string = result.content[0].text;
    // Our results are JSON; the SDK reports invalid arguments as plain text ("MCP error -32602 …").
    return { isError: result.isError as boolean, value: text.startsWith("{") ? JSON.parse(text) : text };
  };
  return { rpc, callTool };
};
