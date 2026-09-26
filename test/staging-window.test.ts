import { describe, expect, it, vi } from "vitest";
import { DEVELOPER_PORTAL_MCP, setStagingWindow, upsertEnv } from "../src/auth/stagingWindow.js";

const rpcAnswer = (text: string, isError = false) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } });
const opened = JSON.stringify({ staging_verification_token: "tok-123", staging_verification_expires_at: "2026-09-27T10:00:00Z" });
const fakeFetch = (status: number, body: string) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status }));

describe("setStagingWindow", () => {
  it("calls the Developer Portal tool with the team key and returns the token", async () => {
    const fetch = fakeFetch(200, JSON.stringify(rpcAnswer(opened)));
    const result = await setStagingWindow({ apiKey: "team-key", appId: "app_test", enabled: true }, fetch);
    expect(result).toEqual({ token: "tok-123", expiresAt: "2026-09-27T10:00:00Z" });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(DEVELOPER_PORTAL_MCP);
    expect(init?.headers).toMatchObject({ authorization: "Bearer team-key" });
    expect(JSON.parse(String(init?.body)).params).toEqual({
      name: "set_world_id_staging_verification",
      arguments: { app_id: "app_test", enabled: true },
    });
  });

  it("reads an SSE answer", async () => {
    const body = `event: message\ndata: ${JSON.stringify(rpcAnswer(opened))}\n\n`;
    expect(await setStagingWindow({ apiKey: "k", appId: "app_test", enabled: true }, fakeFetch(200, body))).toMatchObject({
      token: "tok-123",
    });
  });

  it("returns null when closing", async () => {
    const fetch = fakeFetch(200, JSON.stringify(rpcAnswer('{"ok":true}')));
    expect(await setStagingWindow({ apiKey: "k", appId: "app_test", enabled: false }, fetch)).toBeNull();
  });

  it.each([
    ["an HTTP error", fakeFetch(401, "unauthorized"), /HTTP 401/],
    ["a tool error", fakeFetch(200, JSON.stringify(rpcAnswer("app not found", true))), /refused: app not found/],
    ["a JSON-RPC error", fakeFetch(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "nope" } })), /refused: nope/],
  ])("fails on %s without echoing the key", async (_label, fetch, message) => {
    const call = setStagingWindow({ apiKey: "secret-team-key", appId: "app_test", enabled: true }, fetch);
    await expect(call).rejects.toThrow(message);
    await expect(call).rejects.not.toThrow(/secret-team-key/);
  });
});

describe("upsertEnv", () => {
  it("replaces the existing line only", () => {
    const env = "A=1\nWORLD_STAGING_TOKEN=old\nB=2\n";
    expect(upsertEnv(env, "WORLD_STAGING_TOKEN", "new")).toBe("A=1\nWORLD_STAGING_TOKEN=new\nB=2\n");
  });

  it("appends when missing, with a newline if needed", () => {
    expect(upsertEnv("A=1", "WORLD_STAGING_TOKEN", "t")).toBe("A=1\nWORLD_STAGING_TOKEN=t\n");
    expect(upsertEnv("", "WORLD_STAGING_TOKEN", "t")).toBe("WORLD_STAGING_TOKEN=t\n");
  });

  it("does not touch a key that merely ends the same way", () => {
    expect(upsertEnv("OLD_WORLD_STAGING_TOKEN=x\n", "WORLD_STAGING_TOKEN", "t")).toBe(
      "OLD_WORLD_STAGING_TOKEN=x\nWORLD_STAGING_TOKEN=t\n",
    );
  });
});
