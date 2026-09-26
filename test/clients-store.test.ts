import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClientsStore } from "../src/auth/clientsStore.js";
import { runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pglite.js";

describe("PgClientsStore", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: PgClientsStore;
  beforeAll(async () => {
    db = await createTestDb();
    await runMigrations(db);
    store = new PgClientsStore(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("returns undefined for an unknown client", async () => {
    expect(await store.getClient("nobody")).toBeUndefined();
  });

  it("stores the full registration and reads it back", async () => {
    const client = {
      client_id: "c1",
      client_id_issued_at: 1_790_000_000,
      client_name: "Claude Code (truth-skills)",
      redirect_uris: ["http://localhost:51938/callback"],
      token_endpoint_auth_method: "none",
    };
    expect(await store.registerClient(client)).toEqual(client);
    expect(await store.getClient("c1")).toEqual(client);
  });

  it("refuses a duplicate client_id", async () => {
    const client = { client_id: "c2", redirect_uris: ["http://localhost:1/cb"] };
    await store.registerClient(client);
    await expect(store.registerClient(client)).rejects.toThrow(/unique|duplicate/);
  });
});
