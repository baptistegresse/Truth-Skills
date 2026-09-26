import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  WORLD_APP_ID: "app_test",
  WORLD_RP_ID: "rp_test",
  WORLD_SIGNING_KEY: "deadbeef",
  DATABASE_URL: "postgresql://localhost/truth-skills",
  JWT_SECRET: "a".repeat(64),
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(validEnv);
    expect(config.WORLD_ENVIRONMENT).toBe("sandbox");
    expect(config.WORLD_CREDENTIALS).toEqual(["proof_of_human", "selfie"]);
    expect(config.WORLD_INVITE_CODE).toBe(false);
    expect(config.PUBLIC_URL).toBe("http://localhost:3000");
    expect(config.PORT).toBe(3000);
  });

  it("parses credentials, booleans and port", () => {
    const config = loadConfig({ ...validEnv, WORLD_CREDENTIALS: " selfie , ", WORLD_INVITE_CODE: "true", PORT: "8080" });
    expect(config.WORLD_CREDENTIALS).toEqual(["selfie"]);
    expect(config.WORLD_INVITE_CODE).toBe(true);
    expect(config.PORT).toBe(8080);
  });

  it("names missing variables", () => {
    const { JWT_SECRET: _omit, ...env } = validEnv;
    expect(() => loadConfig(env)).toThrow("Invalid or missing configuration: JWT_SECRET");
  });

  it("names malformed variables without leaking their values", () => {
    const secret = "too-short-secret";
    const error = captureError(() => loadConfig({ ...validEnv, JWT_SECRET: secret, WORLD_APP_ID: "nope" }));
    expect(error.message).toContain("WORLD_APP_ID");
    expect(error.message).toContain("JWT_SECRET");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("nope");
  });

  it("requires https in production", () => {
    expect(() => loadConfig({ ...validEnv, WORLD_ENVIRONMENT: "production" })).toThrow("PUBLIC_URL");
    const config = loadConfig({ ...validEnv, WORLD_ENVIRONMENT: "production", PUBLIC_URL: "https://truth-skills.example" });
    expect(config.PUBLIC_URL).toBe("https://truth-skills.example");
  });
});

const captureError = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
};
