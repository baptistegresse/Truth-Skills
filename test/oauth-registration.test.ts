import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pglite.js";

describe("OAuth authorization server", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    db = await createTestDb();
    await runMigrations(db);
    app = createApp({ config: { PUBLIC_URL: "http://localhost:3000", JWT_SECRET: "a".repeat(64) }, db });
  });
  afterAll(async () => {
    await db.close();
  });

  const register = (body: object) => request(app).post("/register").send(body);

  describe("GET /.well-known/oauth-authorization-server", () => {
    it("serves the RFC 8414 metadata an MCP client needs", async () => {
      const res = await request(app).get("/.well-known/oauth-authorization-server");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        issuer: "http://localhost:3000/",
        authorization_endpoint: "http://localhost:3000/authorize",
        token_endpoint: "http://localhost:3000/token",
        registration_endpoint: "http://localhost:3000/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        // Mandatory for MCP: a client must refuse to go on without it.
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        scopes_supported: ["skills:vote"],
      });
    });

    it("keeps serving the protected resource metadata", async () => {
      const res = await request(app).get("/.well-known/oauth-protected-resource/mcp");
      expect(res.body).toMatchObject({
        resource: "http://localhost:3000/mcp",
        authorization_servers: ["http://localhost:3000/"],
        scopes_supported: ["skills:vote"],
        resource_name: "Truth-Skills",
      });
    });

    it("refuses a plain-http issuer outside localhost", () => {
      expect(() => createApp({ config: { PUBLIC_URL: "http://truth-skills.example", JWT_SECRET: "a".repeat(64) }, db })).toThrow(/HTTPS/);
    });
  });

  describe("POST /register", () => {
    it("registers a public client like Claude Code and stores it", async () => {
      const res = await register({
        client_name: "Claude Code (truth-skills)",
        redirect_uris: ["http://localhost:51938/callback"],
        token_endpoint_auth_method: "none",
      });
      expect(res.status).toBe(201);
      expect(res.body.client_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.client_secret).toBeUndefined();

      const { rows } = await db.query<{ info: { client_name: string } }>(
        "select info from oauth_clients where client_id = $1",
        [res.body.client_id],
      );
      expect(rows[0]!.info.client_name).toBe("Claude Code (truth-skills)");
    });

    it("rejects metadata without redirect_uris", async () => {
      const res = await register({ client_name: "no redirect" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
    });

    it("only accepts POST", async () => {
      const res = await request(app).get("/register");
      expect(res.status).toBe(405);
    });
  });

  describe("GET /authorize with a registered client", () => {
    let clientId: string;
    beforeAll(async () => {
      const res = await register({ redirect_uris: ["http://localhost:51938/callback"], token_endpoint_auth_method: "none" });
      clientId = res.body.client_id;
    });

    const authorize = (params: Record<string, string>) =>
      request(app)
        .get("/authorize")
        .query({ response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", ...params });

    it("rejects an unknown client without redirecting", async () => {
      const res = await authorize({ client_id: "nobody", redirect_uri: "http://localhost:51938/callback" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client");
    });

    it("rejects an unregistered redirect_uri without redirecting", async () => {
      const res = await authorize({ client_id: clientId, redirect_uri: "https://attacker.example/callback" });
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it("hands the browser to the sign-in page", async () => {
      const res = await authorize({ client_id: clientId, redirect_uri: "http://localhost:51938/callback", state: "s1" });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^http:\/\/localhost:3000\/login\?req=[0-9a-f-]{36}$/);
    });
  });
});
