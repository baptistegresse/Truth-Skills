import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachWorldSession,
  createAccountWithNullifier,
  findAccountByNullifier,
  findAccountBySession,
} from "../src/auth/accounts.js";
import { runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pglite.js";

const ACTION = "truth-skills-account-v1";

describe("accounts", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    db = await createTestDb();
    await runMigrations(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("creates one account per nullifier", async () => {
    const first = await createAccountWithNullifier(db, "0x01", ACTION);
    expect(first.created).toBe(true);
    expect(await findAccountByNullifier(db, "0x01", ACTION)).toBe(first.accountId);

    const second = await createAccountWithNullifier(db, "0x01", ACTION);
    expect(second).toEqual({ accountId: first.accountId, created: false });
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from accounts");
    expect(rows[0]!.n).toBe(1); // the losing account row was rolled back
  });

  it("scopes nullifiers by action", async () => {
    expect(await findAccountByNullifier(db, "0x01", "another-action")).toBeNull();
  });

  it("links a World ID session once, to one account", async () => {
    const { accountId } = await createAccountWithNullifier(db, "0x02", ACTION);
    const other = await createAccountWithNullifier(db, "0x03", ACTION);

    expect(await attachWorldSession(db, accountId, "session_aa")).toBe(true);
    expect(await findAccountBySession(db, "session_aa")).toBe(accountId);
    expect(await attachWorldSession(db, accountId, "session_bb")).toBe(false); // already has one
    expect(await attachWorldSession(db, other.accountId, "session_aa")).toBe(false); // taken
  });

  it("ignores deleted accounts", async () => {
    const { accountId } = await createAccountWithNullifier(db, "0x04", ACTION);
    await attachWorldSession(db, accountId, "session_cc");
    await db.query("update accounts set deleted_at = now() where id = $1", [accountId]);
    expect(await findAccountByNullifier(db, "0x04", ACTION)).toBeNull();
    expect(await findAccountBySession(db, "session_cc")).toBeNull();
  });
});
