import { loadConfig } from "../../src/config.js";

// A complete, valid configuration for tests. The signing key is a throwaway secp256k1 key.
export const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    WORLD_APP_ID: "app_test",
    WORLD_RP_ID: "rp_test",
    WORLD_SIGNING_KEY: "11".repeat(32),
    DATABASE_URL: "postgresql://localhost/truth-skills",
    JWT_SECRET: "a".repeat(64),
    ...overrides,
  });
