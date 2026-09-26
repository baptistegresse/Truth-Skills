import pg from "pg";

export type Db = pg.Pool;

// The only part of a pg client the app relies on, so tests can substitute an in-process Postgres.
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface DbClient extends Queryable {
  release(): void;
}

export interface Connectable {
  connect(): Promise<DbClient>;
}

export const createPool = (databaseUrl: string, max = 10): Db => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on("error", (error) => console.error(`Postgres pool error: ${error.message}`));
  return pool;
};

// Runs fn on one connection inside a transaction: commit on success, rollback on any error.
export const withTransaction = async <T>(db: Connectable, fn: (client: Queryable) => Promise<T>): Promise<T> => {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
