import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pglite.js";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const tableNames = async (db: TestDb) => {
  const { rows } = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  return rows.map((row) => row.table_name);
};

describe("runMigrations", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("applies the project migrations on an empty database", async () => {
    expect(await runMigrations(db)).toEqual(["001_accounts.sql", "002_oauth.sql", "003_skill_grades.sql", "004_skill_grades_by_name.sql"]);
    expect(await tableNames(db)).toEqual([
      "accounts",
      "auth_codes",
      "auth_requests",
      "oauth_clients",
      "refresh_tokens",
      "schema_migrations",
      "skill_grades",
      "world_nullifiers",
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db);
    expect(await runMigrations(db)).toEqual([]);
    const { rows } = await db.query("select name from schema_migrations");
    expect(rows).toHaveLength(4);
  });

  describe("with a custom directory", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "migrations-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("applies files in name order and only new ones", async () => {
      await writeFile(join(dir, "002_b.sql"), "create table b (id int references a(id));");
      await writeFile(join(dir, "001_a.sql"), "create table a (id int primary key);");
      await writeFile(join(dir, "notes.txt"), "not a migration");
      expect(await runMigrations(db, dir)).toEqual(["001_a.sql", "002_b.sql"]);

      await writeFile(join(dir, "003_c.sql"), "create table c (id int);");
      expect(await runMigrations(db, dir)).toEqual(["003_c.sql"]);
    });

    it("rolls back a failing file and names it", async () => {
      await writeFile(join(dir, "001_ok.sql"), "create table ok (id int);");
      await writeFile(join(dir, "002_bad.sql"), "create table half (id int);\nselect * from missing_table;");
      await expect(runMigrations(db, dir)).rejects.toThrow("Migration 002_bad.sql failed");

      expect(await tableNames(db)).toEqual(["ok", "schema_migrations"]);
      const { rows } = await db.query<{ name: string }>("select name from schema_migrations");
      expect(rows.map((row) => row.name)).toEqual(["001_ok.sql"]);
    });
  });
});
