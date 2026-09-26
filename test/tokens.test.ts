import { decodeProtectedHeader, SignJWT, UnsecuredJWT } from "jose";
import { describe, expect, it } from "vitest";
import { hashToken, randomToken, signAccessToken, verifyAccessToken } from "../src/auth/tokens.js";

const SECRET = "a".repeat(64);
const ISSUER = "http://localhost:3000/";
const AUDIENCE = "http://localhost:3000/mcp";
const claims = { accountId: "acct-1", clientId: "client-1", scopes: ["skills:vote"], resource: AUDIENCE };

const sign = (overrides: Partial<typeof claims> = {}, ttl = 3600) =>
  signAccessToken({ ...claims, ...overrides }, SECRET, ISSUER, ttl);

// Builds a token by hand, to test what verify refuses that signAccessToken would never produce.
const forge = (payload: Record<string, unknown>, header: { alg: string; typ?: string }, secret = SECRET) =>
  new SignJWT(payload)
    .setProtectedHeader(header)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));

describe("randomToken", () => {
  it("is 32 bytes of base64url", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not repeat", () => {
    expect(new Set(Array.from({ length: 100 }, randomToken)).size).toBe(100);
  });
});

describe("hashToken", () => {
  it("is deterministic SHA-256 hex", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abd")).not.toBe(hashToken("abc"));
  });
});

describe("signAccessToken / verifyAccessToken", () => {
  it("round-trips the account, client, scopes and expiry", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await sign({ scopes: ["skills:vote", "extra"] });
    const verified = await verifyAccessToken(token, SECRET, ISSUER, AUDIENCE);
    expect(verified).toMatchObject({ accountId: "acct-1", clientId: "client-1", scopes: ["skills:vote", "extra"] });
    expect(verified.expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(verified.expiresAt).toBeLessThanOrEqual(before + 3601);
  });

  it("uses an HS256 at+jwt header", async () => {
    expect(decodeProtectedHeader(await sign())).toEqual({ alg: "HS256", typ: "at+jwt" });
  });

  it("returns no scopes for an empty scope claim", async () => {
    const verified = await verifyAccessToken(await sign({ scopes: [] }), SECRET, ISSUER, AUDIENCE);
    expect(verified.scopes).toEqual([]);
  });

  it("refuses a wrong secret", async () => {
    await expect(verifyAccessToken(await sign(), "b".repeat(64), ISSUER, AUDIENCE)).rejects.toThrow();
  });

  it("refuses a token for another resource", async () => {
    const token = await sign({ resource: "http://localhost:3000/other" });
    await expect(verifyAccessToken(token, SECRET, ISSUER, AUDIENCE)).rejects.toThrow(/aud/);
  });

  it("refuses another issuer", async () => {
    await expect(verifyAccessToken(await sign(), SECRET, "https://evil.example/", AUDIENCE)).rejects.toThrow(/iss/);
  });

  it("refuses an expired token", async () => {
    await expect(verifyAccessToken(await sign({}, -10), SECRET, ISSUER, AUDIENCE)).rejects.toThrow(/exp/);
  });

  it("refuses a tampered payload", async () => {
    const [header, , signature] = (await sign()).split(".");
    const payload = Buffer.from(JSON.stringify({ sub: "someone-else", client_id: "client-1" })).toString("base64url");
    await expect(verifyAccessToken(`${header}.${payload}.${signature}`, SECRET, ISSUER, AUDIENCE)).rejects.toThrow();
  });

  it("refuses alg none", async () => {
    const token = new UnsecuredJWT({ sub: "acct-1", client_id: "client-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .encode();
    await expect(verifyAccessToken(token, SECRET, ISSUER, AUDIENCE)).rejects.toThrow();
  });

  it("refuses another HMAC algorithm", async () => {
    const token = await forge({ sub: "acct-1", client_id: "client-1" }, { alg: "HS512", typ: "at+jwt" });
    await expect(verifyAccessToken(token, SECRET, ISSUER, AUDIENCE)).rejects.toThrow(/alg/);
  });

  it("refuses a JWT that is not an access token", async () => {
    const token = await forge({ sub: "acct-1", client_id: "client-1" }, { alg: "HS256", typ: "JWT" });
    await expect(verifyAccessToken(token, SECRET, ISSUER, AUDIENCE)).rejects.toThrow(/typ/);
  });

  it("refuses a token without subject or client_id", async () => {
    const noSub = await forge({ client_id: "client-1" }, { alg: "HS256", typ: "at+jwt" });
    await expect(verifyAccessToken(noSub, SECRET, ISSUER, AUDIENCE)).rejects.toThrow(/sub/);
    const noClient = await forge({ sub: "acct-1" }, { alg: "HS256", typ: "at+jwt" });
    await expect(verifyAccessToken(noClient, SECRET, ISSUER, AUDIENCE)).rejects.toThrow("Malformed access token");
  });
});
