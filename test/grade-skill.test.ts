import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { INSTRUCTIONS } from "../src/mcp/server.js";
import { testConfig } from "./helpers/config.js";
import { createTestDb } from "./helpers/pglite.js";

// The bearer token is the account id; the real JWT path is covered in oauth-flow.test.ts.
const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    const extra = token === "no-account" ? {} : { accountId: token };
    return { token, clientId: "c", scopes: ["skills:vote"], expiresAt: Date.now() / 1000 + 60, extra };
  },
};

describe("grade_skill", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: ReturnType<typeof createApp>;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    db = await createTestDb();
    await runMigrations(db);
    app = createApp({ config: testConfig(), db, verifier });
    const create = async () => (await db.query<{ id: string }>("insert into accounts default values returning id")).rows[0]!.id;
    alice = await create();
    bob = await create();
  });
  afterAll(async () => {
    await db.close();
  });

  let id = 0;
  const rpc = async (accountId: string, method: string, params: object) => {
    const res = await request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("authorization", `Bearer ${accountId}`)
      .send({ jsonrpc: "2.0", id: ++id, method, params });
    expect(res.status).toBe(200);
    return res.body;
  };
  const grade = async (accountId: string, args: object) => {
    const { result } = await rpc(accountId, "tools/call", { name: "grade_skill", arguments: args });
    const text: string = result.content[0].text;
    // Our results are JSON; the SDK reports invalid arguments as plain text ("MCP error -32602 …").
    return { isError: result.isError as boolean, value: text.startsWith("{") ? JSON.parse(text) : text };
  };

  const docx = { skill_name: "docx" };

  it("tells the agent at connection to grade on its own, without asking the user", async () => {
    const { result } = await rpc(alice, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(result.instructions).toBe(INSTRUCTIONS);
    expect(result.instructions).toMatch(/without asking the user/);
    expect(result.instructions).toMatch(/Never ask the user/);
  });

  it("describes the tool as the agent's own judgement", async () => {
    const { result } = await rpc(alice, "tools/list", {});
    const tool = result.tools.find((t: { name: string }) => t.name === "grade_skill");
    expect(tool.description).toMatch(/on your own judgement/);
    expect(tool.description).toMatch(/never ask them/);
  });

  it("is listed with its input schema and no account parameter", async () => {
    const { result } = await rpc(alice, "tools/list", {});
    const tool = result.tools.find((t: { name: string }) => t.name === "grade_skill");
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["liked", "skill_name"]);
    expect(tool.inputSchema.required.sort()).toEqual(["liked", "skill_name"]);
    expect(tool.annotations).toMatchObject({ idempotentHint: true, destructiveHint: false });
  });

  it("records the grade for the token's account and returns the skill's totals", async () => {
    const res = await grade(alice, { skill_name: "pdf", liked: true });
    expect(res).toEqual({ isError: false, value: { skill_name: "pdf", likes: 1, dislikes: 0 } });
    const { rows } = await db.query("select account_id, skill_name, liked from skill_grades where skill_name = 'pdf'");
    expect(rows).toEqual([{ account_id: alice, skill_name: "pdf", liked: true }]);
  });

  it("counts one grade per human: grading again replaces it", async () => {
    await grade(alice, { ...docx, liked: true });
    await grade(alice, { ...docx, liked: false });
    const res = await grade(bob, { ...docx, liked: true });
    expect(res.value).toMatchObject({ likes: 1, dislikes: 1 });

    const { rows } = await db.query<{ created_at: Date; updated_at: Date }>(
      "select created_at, updated_at from skill_grades where account_id = $1 and skill_name = 'docx'",
      [alice],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(rows[0]!.created_at.getTime());
  });

  it("identifies a skill by its name alone: a plugin prefix is the same skill", async () => {
    const res = await grade(alice, { skill_name: "anthropic-skills:docx", liked: true });
    expect(res.value).toEqual({ skill_name: "docx", likes: 2, dislikes: 0 });
    const { rows } = await db.query("select 1 from skill_grades where account_id = $1 and skill_name = 'docx'", [alice]);
    expect(rows).toHaveLength(1);
  });

  it("ignores a provider sent by an older client", async () => {
    const res = await grade(bob, { skill_name: "pdf", skill_provider: "anthropic-skills", liked: true });
    expect(res).toEqual({ isError: false, value: { skill_name: "pdf", likes: 2, dislikes: 0 } });
  });

  it("normalises names", async () => {
    const res = await grade(bob, { skill_name: "  XLSX ", liked: false });
    expect(res.value).toMatchObject({ skill_name: "xlsx" });
  });

  it("stops counting a deleted account", async () => {
    const pptx = { skill_name: "pptx" };
    const carol = (await db.query<{ id: string }>("insert into accounts default values returning id")).rows[0]!.id;
    await grade(carol, { ...pptx, liked: false });
    await db.query("update accounts set deleted_at = now() where id = $1", [carol]);
    expect((await grade(alice, { ...pptx, liked: true })).value).toMatchObject({ likes: 1, dislikes: 0 });
  });

  it.each([
    ["a missing name", { liked: true }],
    ["a missing liked", { skill_name: "pdf" }],
    ["liked as a string", { skill_name: "pdf", liked: "true" }],
    ["an empty name", { skill_name: "  ", liked: true }],
    ["an empty name after its prefix", { skill_name: "anthropic-skills:", liked: true }],
    ["a name with odd characters", { skill_name: "pdf; drop table", liked: true }],
  ])("refuses %s", async (_label, args) => {
    const res = await grade(alice, args);
    expect(res.isError).toBe(true);
    expect(res.value).toMatch(/Input validation error/);
  });

  it("refuses to act without an account in the token", async () => {
    const res = await grade("no-account", { skill_name: "pdf", liked: true });
    expect(res).toEqual({ isError: true, value: { error: "unauthorized" } });
  });
});
