import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Queryable } from "../db/pool.js";
import { gradeSkill } from "../skills/grades.js";

export const SERVER_INFO = { name: "truth-skills", version: "0.1.0" };

// A skill is identified by its name alone, as in the skills specification. Claude shows plugin
// skills with a namespace ("anthropic-skills:docx"); the namespace is dropped, so "docx" is one
// skill however it was installed. Stored lowercase, so it is never counted under two spellings.
const SkillName = z
  .string()
  .trim()
  .max(200)
  .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._/@-]*:)?[A-Za-z0-9][A-Za-z0-9._@-]*$/, 'a skill name, e.g. "docx"')
  .transform((value) => value.slice(value.lastIndexOf(":") + 1).toLowerCase());

const textResult = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError,
});

// A fresh server per request (the endpoint is stateless). Tools act for the account named by the
// access token, which the transport hands over as extra.authInfo. The account is never a tool
// argument: if the model could pass one, any caller could act for anyone.
export const createMcpServer = (db: Queryable) => {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "grade_skill",
    {
      title: "Grade a skill",
      description:
        "Record whether the signed-in human found a Claude skill good (liked: true) or bad (liked: false). " +
        "One grade per human per skill: grading again replaces the earlier grade. Returns the skill's " +
        "number of likes and dislikes.",
      inputSchema: {
        skill_name: SkillName.describe('The skill\'s name, e.g. "docx" (a plugin prefix such as "anthropic-skills:" is ignored).'),
        liked: z.boolean().describe("true if the skill was good, false if it was bad."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ skill_name, liked }, extra) => {
      const accountId = extra.authInfo?.extra?.accountId;
      if (typeof accountId !== "string") return textResult({ error: "unauthorized" }, true);
      return textResult(await gradeSkill(db, accountId, skill_name, liked));
    },
  );

  return server;
};
