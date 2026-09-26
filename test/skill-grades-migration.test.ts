import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pglite.js";

// 004 runs on databases that already hold grades keyed by (provider, name).
describe("004_skill_grades_by_name", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), "migrations-"));
    for (const file of ["001_accounts.sql", "002_oauth.sql", "003_skill_grades.sql"]) {
      await copyFile(join(MIGRATIONS_DIR, file), join(dir, file));
    }
    await runMigrations(db, dir);
  });
  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps each account's most recent grade per skill name", async () => {
    const create = async () => (await db.query<{ id: string }>("insert into accounts default values returning id")).rows[0]!.id;
    const alice = await create();
    const bob = await create();
    await db.query(
      `insert into skill_grades (account_id, skill_provider, skill_name, liked, updated_at) values
         ($1, 'honojs', 'hono', true, now() - interval '1 hour'),
         ($1, 'hono', 'hono', false, now()),
         ($2, 'honojs', 'hono', true, now()),
         ($1, 'anthropic-skills', 'pdf', true, now())`,
      [alice, bob],
    );

    expect(await runMigrations(db)).toEqual(["004_skill_grades_by_name.sql"]);

    const { rows } = await db.query<{ account_id: string; skill_name: string; liked: boolean }>(
      "select account_id, skill_name, liked from skill_grades order by skill_name, liked",
    );
    expect(rows).toEqual([
      { account_id: alice, skill_name: "hono", liked: false },
      { account_id: bob, skill_name: "hono", liked: true },
      { account_id: alice, skill_name: "pdf", liked: true },
    ]);
  });

  it("allows one grade per account and skill name", async () => {
    const { rows } = await db.query<{ account_id: string }>("select account_id from skill_grades where skill_name = 'pdf'");
    await expect(
      db.query("insert into skill_grades (account_id, skill_name, liked) values ($1, 'pdf', false)", [rows[0]!.account_id]),
    ).rejects.toThrow(/duplicate key/);
  });
});
