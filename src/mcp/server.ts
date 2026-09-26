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

// Sent to the client at connection; Claude Code puts it in the model's context. The whole idea
// rests on it: the agent read the skill and saw how it went, so the agent is the judge, and the
// user, who delegated grading by signing in, is never asked.
export const INSTRUCTIONS = `Truth-Skills ranks agent skills by how well they actually work for real, verified humans.
The user connected this server with World ID and, by doing so, delegated skill grading to you.

A skill counts as used when you invoked it (the Skill tool) or followed its SKILL.md in this conversation.

Checkpoint: every time the user sends a message, before you reply, check each skill used so far:
- The outcome is clear and the skill is not graded yet, or the outcome changed: call grade_skill now,
  without asking the user.
- The outcome is not clear yet: do nothing, and check again at the next message.

liked: true when the skill got the user what they needed, e.g. the task worked, the user moved on, or said thanks.
liked: false when the user struggled with it, e.g. errors, retries, workarounds, corrections, or giving up.

Pass the skill's bare name ("find-skills", "docx"): the plugin prefix is ignored.
Never ask the user whether they liked a skill or whether to grade it; you read the skill and saw how
it went, so you are the judge.
Grade silently; a short mention after grading is enough.
When unsure between grading now and waiting, grade: a later grade replaces the earlier one.`;

const textResult = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError,
});

// A fresh server per request (the endpoint is stateless). Tools act for the account named by the
// access token, which the transport hands over as extra.authInfo. The account is never a tool
// argument: if the model could pass one, any caller could act for anyone.
export const createMcpServer = (db: Queryable) => {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "grade_skill",
    {
      title: "Grade a skill",
      description:
        "Grade a skill used in this conversation, on your own judgement: liked true if it helped the user, " +
        "false if they struggled with it. Call it at the checkpoint in the server instructions (each new user " +
        "message), as soon as a used skill's outcome is clear. The user already consented when connecting; " +
        "never ask them. " +
        "One grade per human per skill: grading again replaces the earlier grade. Returns the skill's " +
        "number of likes and dislikes.",
      inputSchema: {
        skill_name: SkillName.describe('The skill\'s name, e.g. "docx" (a plugin prefix such as "anthropic-skills:" is ignored).'),
        liked: z.boolean().describe("true if the skill helped the user, false if they struggled with it."),
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
