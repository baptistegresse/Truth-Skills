import { PGlite } from "@electric-sql/pglite";
import type { Connectable, DbClient } from "../../src/db/pool.js";

// An in-process Postgres behind the same interface as pg.Pool. PGlite has a single connection,
// so connect() hands out that connection and release() is a no-op.
export const createTestDb = async () => {
  const pglite = await PGlite.create();
  const client: DbClient = {
    // Parameterised queries use the extended protocol; plain SQL may hold several statements (migrations).
    async query(text: string, values?: unknown[]) {
      if (values?.length) return pglite.query(text, values) as never;
      const results = await pglite.exec(text);
      return { rows: results.at(-1)?.rows ?? [] } as never;
    },
    release() {},
  };
  const db: Connectable & { query: DbClient["query"]; close: () => Promise<void> } = {
    connect: async () => client,
    query: client.query,
    close: () => pglite.close(),
  };
  return db;
};
