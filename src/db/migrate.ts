import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withTransaction, type Connectable, type Queryable } from "./pool.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Arbitrary constant: two runners starting at once (e.g. two instances booting) take turns.
const MIGRATION_LOCK_ID = 0x7275_7468;

// Transaction-scoped, so it is released by commit or rollback. A session lock would leak behind
// Neon's pooled endpoint (PgBouncer in transaction mode), where lock and unlock can land on
// different server connections.
const lock = (client: Queryable) => client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);

// Applies every migrations/*.sql not yet recorded in schema_migrations, in file name order,
// each file and its record in one transaction. Returns the names of the files applied.
export const runMigrations = async (db: Connectable, dir = MIGRATIONS_DIR): Promise<string[]> => {
  await withTransaction(db, async (client) => {
    await lock(client);
    await client.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
  });

  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    const ran = await withTransaction(db, async (client) => {
      await lock(client);
      // Checked under the lock: another runner may have applied it since we started.
      const { rows } = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (rows.length) return false;
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      return true;
    }).catch((error: unknown) => {
      throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : error}`, { cause: error });
    });
    if (ran) applied.push(file);
  }
  return applied;
};
