import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db/pool.js";
import { createTestDb } from "./helpers/pglite.js";

describe("withTransaction", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    db = await createTestDb();
    await db.query("create table t (id int primary key)");
  });
  afterEach(async () => {
    await db.close();
  });

  const count = async () => (await db.query<{ n: number }>("select count(*)::int as n from t")).rows[0]!.n;

  it("commits when the callback succeeds", async () => {
    const result = await withTransaction(db, async (client) => {
      await client.query("insert into t values ($1)", [1]);
      return "done";
    });
    expect(result).toBe("done");
    expect(await count()).toBe(1);
  });

  it("rolls back and rethrows when the callback fails", async () => {
    await expect(
      withTransaction(db, async (client) => {
        await client.query("insert into t values ($1)", [1]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count()).toBe(0);
  });
});
