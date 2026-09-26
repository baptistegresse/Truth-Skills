import { withTransaction, type Connectable, type Queryable } from "../db/pool.js";

const UNIQUE_VIOLATION = "23505";

export const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;

export const findAccountByNullifier = async (db: Queryable, nullifier: string, action: string) => {
  const { rows } = await db.query<{ account_id: string }>(
    `select n.account_id from world_nullifiers n join accounts a on a.id = n.account_id
     where n.nullifier = $1 and n.action = $2 and a.deleted_at is null`,
    [nullifier, action],
  );
  return rows[0]?.account_id ?? null;
};

export const findAccountBySession = async (db: Queryable, sessionId: string) => {
  const { rows } = await db.query<{ id: string }>(
    "select id from accounts where world_session_id = $1 and deleted_at is null",
    [sessionId],
  );
  return rows[0]?.id ?? null;
};

export const hasWorldSession = async (db: Queryable, accountId: string) => {
  const { rows } = await db.query("select 1 from accounts where id = $1 and world_session_id is not null", [accountId]);
  return rows.length > 0;
};

// The account and its nullifier are created together or not at all. If another sign-in for the
// same human wins the race, the primary key on world_nullifiers refuses ours and we return theirs.
export const createAccountWithNullifier = async (
  db: Queryable & Connectable,
  nullifier: string,
  action: string,
): Promise<{ accountId: string; created: boolean }> => {
  try {
    const accountId = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: string }>("insert into accounts default values returning id");
      const id = rows[0]!.id;
      await client.query("insert into world_nullifiers (nullifier, action, account_id) values ($1, $2, $3)", [
        nullifier,
        action,
        id,
      ]);
      return id;
    });
    return { accountId, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await findAccountByNullifier(db, nullifier, action);
    if (!existing) throw error;
    return { accountId: existing, created: false };
  }
};

// Links the World ID session used to recognise this human later. Only once per account, and a
// session belongs to one account (unique column). Returns false if either is already taken.
export const attachWorldSession = async (db: Queryable, accountId: string, sessionId: string) => {
  try {
    const { rows } = await db.query(
      "update accounts set world_session_id = $2 where id = $1 and world_session_id is null returning id",
      [accountId, sessionId],
    );
    return rows.length > 0;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
};
