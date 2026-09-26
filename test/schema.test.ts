import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pglite.js";

// The constraints below are the database's share of the security model; the app relies on them.
describe("schema", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let accountId: string;

  beforeAll(async () => {
    db = await createTestDb();
    await runMigrations(db);
    const { rows } = await db.query<{ id: string }>("insert into accounts (world_session_id) values ($1) returning id", [
      "session_a",
    ]);
    accountId = rows[0]!.id;
    await db.query("insert into oauth_clients (client_id, info) values ($1, $2)", ["client_1", { client_name: "test" }]);
  });
  afterAll(async () => {
    await db.close();
  });

  it("generates account ids", () => {
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("allows one account per World ID session", async () => {
    await expect(
      db.query("insert into accounts (world_session_id) values ($1)", ["session_a"]),
    ).rejects.toThrow(/unique/);
  });

  it("allows one account per nullifier", async () => {
    const insert = "insert into world_nullifiers (nullifier, action, account_id) values ($1, $2, $3)";
    await db.query(insert, ["0xabc", "truth-skills-account-v1", accountId]);
    await expect(db.query(insert, ["0xabc", "truth-skills-account-v1", accountId])).rejects.toThrow(/unique|duplicate/);
  });

  it("refuses a nullifier for an unknown account", async () => {
    await expect(
      db.query("insert into world_nullifiers (nullifier, action, account_id) values ($1, $2, gen_random_uuid())", [
        "0xdef",
        "truth-skills-account-v1",
      ]),
    ).rejects.toThrow(/foreign key/);
  });

  it("starts login requests at step 'start' and rejects unknown steps", async () => {
    const insert = `insert into auth_requests (client_id, redirect_uri, code_challenge, scopes, expires_at)
                    values ($1, $2, $3, $4, now() + interval '10 minutes') returning step`;
    const { rows } = await db.query<{ step: string }>(insert, ["client_1", "http://localhost:1/cb", "c", ["skills:vote"]]);
    expect(rows[0]!.step).toBe("start");

    await expect(
      db.query("update auth_requests set step = $1", ["done"]),
    ).rejects.toThrow(/check constraint/);
  });

  it("round-trips client registrations as jsonb and scopes as text[]", async () => {
    const { rows } = await db.query<{ info: { client_name: string } }>(
      "select info from oauth_clients where client_id = $1",
      ["client_1"],
    );
    expect(rows[0]!.info.client_name).toBe("test");

    await db.query(
      `insert into refresh_tokens (token_hash, account_id, client_id, scopes, expires_at)
       values ($1, $2, $3, $4, now() + interval '90 days')`,
      ["hash", accountId, "client_1", ["skills:vote"]],
    );
    const tokens = await db.query<{ scopes: string[] }>("select scopes from refresh_tokens where token_hash = $1", ["hash"]);
    expect(tokens.rows[0]!.scopes).toEqual(["skills:vote"]);
  });
});
