import { describe, expect, it, vi } from "vitest";
import { createRpContext, createWorldVerifier, verifyHeaders, WorldRejectedError } from "../src/auth/world.js";

const config = {
  WORLD_RP_ID: "rp_test",
  WORLD_SIGNING_KEY: "11".repeat(32),
  WORLD_ENVIRONMENT: "sandbox" as const,
  WORLD_STAGING_TOKEN: "staging-token",
};

const fakeFetch = (status: number, body: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );

describe("createRpContext", () => {
  it("signs a short-lived request for our RP", () => {
    const context = createRpContext(config, "truth-skills-account-v1");
    expect(context.rp_id).toBe("rp_test");
    expect(context.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(context.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(context.expires_at - context.created_at).toBe(300);
  });

  it("uses a fresh nonce every time", () => {
    expect(createRpContext(config).nonce).not.toBe(createRpContext(config).nonce);
  });
});

describe("verifyHeaders", () => {
  it("sends the staging token outside production", () => {
    expect(verifyHeaders(config)["x-staging-verification-token"]).toBe("staging-token");
  });

  it("never sends it in production", () => {
    expect(verifyHeaders({ ...config, WORLD_ENVIRONMENT: "production" })).toEqual({ "content-type": "application/json" });
  });
});

describe("createWorldVerifier", () => {
  const result = { protocol_version: "4.0", nonce: "0x01", action: "truth-skills-account-v1", responses: [] };

  it("forwards the IDKit result untouched to the Verify API of our RP", async () => {
    const fetch = fakeFetch(200, { success: true, nullifier: "0xabc", action: "truth-skills-account-v1" });
    expect(await createWorldVerifier(config, fetch).verify(result)).toEqual({ nullifier: "0xabc", sessionId: undefined });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://developer.world.org/api/v4/verify/rp_test");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(result);
    expect(init?.headers).toMatchObject({ "x-staging-verification-token": "staging-token" });
  });

  it("returns the session id of a session proof", async () => {
    const fetch = fakeFetch(200, { success: true, session_id: "session_ab" });
    expect(await createWorldVerifier(config, fetch).verify(result)).toMatchObject({ sessionId: "session_ab" });
  });

  it.each([
    ["an error answer", 400, { success: false, code: "environment_not_allowed" }, "environment_not_allowed"],
    ["success: false", 200, { success: false, code: "invalid_proof" }, "invalid_proof"],
    ["an answer without code", 500, { success: false }, "http_500"],
    ["a non-JSON answer", 502, "<html>", "malformed_response"],
  ])("rejects %s", async (_label, status, body, code) => {
    const verify = createWorldVerifier(config, fakeFetch(status, body)).verify(result);
    await expect(verify).rejects.toBeInstanceOf(WorldRejectedError);
    await expect(verify).rejects.toMatchObject({ code });
  });
});
