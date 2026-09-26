import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { INSTRUCTIONS } from "../src/mcp/server.js";
import { testConfig } from "./helpers/config.js";
import { accountIdVerifier, mcpClient } from "./helpers/mcp.js";
import { createTestDb } from "./helpers/pglite.js";

describe("check_skill", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let client: ReturnType<typeof mcpClient>;
  let alice: string;
  let bob: string;
  let carol: string;

  beforeAll(async () => {
    db = await createTestDb();
    await runMigrations(db);
    client = mcpClient(createApp({ config: testConfig(), db, verifier: accountIdVerifier }));
    const create = async () => (await db.query<{ id: string }>("insert into accounts default values returning id")).rows[0]!.id;
    alice = await create();
    bob = await create();
    carol = await create();
    const grade = (accountId: string, skillName: string, liked: boolean) =>
      db.query("insert into skill_grades (account_id, skill_name, liked) values ($1, $2, $3)", [accountId, skillName, liked]);
    await grade(alice, "docx", true);
    await grade(bob, "docx", true);
    await grade(carol, "docx", false);
  });
  afterAll(async () => {
    await db.close();
  });

  const check = (accountId: string, args: object) => client.callTool(accountId, "check_skill", args);

  it("tells the agent to check a skill when it is recommended or installed, and to show raw counts", () => {
    expect(INSTRUCTIONS).toMatch(/check_skill/);
    expect(INSTRUCTIONS).toMatch(/install/);
    expect(INSTRUCTIONS).toMatch(/recommend/);
    expect(INSTRUCTIONS).toMatch(/no percentage/i);
    expect(INSTRUCTIONS).toMatch(/probably new/);
  });

  it("is listed as read-only, with the skill name as its only argument", async () => {
    const { result } = await client.rpc(alice, "tools/list", {});
    const tool = result.tools.find((t: { name: string }) => t.name === "check_skill");
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["skill_name"]);
    expect(tool.inputSchema.required).toEqual(["skill_name"]);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("returns how many verified humans liked and disliked a known skill", async () => {
    const res = await check(alice, { skill_name: "docx" });
    expect(res).toEqual({ isError: false, value: { skill_name: "docx", found: true, likes: 2, dislikes: 1 } });
  });

  it("says a skill nobody graded is not found", async () => {
    const res = await check(alice, { skill_name: "brand-new-skill" });
    expect(res).toEqual({
      isError: false,
      value: { skill_name: "brand-new-skill", found: false, likes: 0, dislikes: 0 },
    });
  });

  it("identifies a skill by its name alone, whatever its prefix or case", async () => {
    const res = await check(alice, { skill_name: " anthropic-skills:DOCX " });
    expect(res.value).toMatchObject({ skill_name: "docx", found: true, likes: 2, dislikes: 1 });
  });

  it("changes nothing", async () => {
    const before = await db.query("select * from skill_grades order by account_id, skill_name");
    await check(alice, { skill_name: "docx" });
    await check(alice, { skill_name: "xlsx" });
    const after = await db.query("select * from skill_grades order by account_id, skill_name");
    expect(after.rows).toEqual(before.rows);
  });

  it("stops counting a deleted account, and a skill only it graded is not found", async () => {
    const dave = (await db.query<{ id: string }>("insert into accounts default values returning id")).rows[0]!.id;
    await db.query("insert into skill_grades (account_id, skill_name, liked) values ($1, 'pptx', true)", [dave]);
    await db.query("update accounts set deleted_at = now() where id = $1", [dave]);
    expect((await check(alice, { skill_name: "pptx" })).value).toMatchObject({ found: false, likes: 0, dislikes: 0 });
  });

  it.each([
    ["a missing name", {}],
    ["an empty name", { skill_name: "  " }],
    ["a name with odd characters", { skill_name: "pdf; drop table" }],
  ])("refuses %s", async (_label, args) => {
    const res = await check(alice, args);
    expect(res.isError).toBe(true);
    expect(res.value).toMatch(/Input validation error/);
  });

  it("refuses to answer without an account in the token", async () => {
    const res = await check("no-account", { skill_name: "docx" });
    expect(res).toEqual({ isError: true, value: { error: "unauthorized" } });
  });
});
