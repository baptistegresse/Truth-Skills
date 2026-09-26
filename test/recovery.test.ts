import { describe, expect, it } from "vitest";
import { parseRecoveryInput, recoveryUrl } from "../src/auth/recovery.js";

const SESSION = `session_${"ab".repeat(64)}`;

describe("recoveryUrl", () => {
  it("puts the session id in the fragment, never in the path or query", () => {
    const url = new URL(recoveryUrl("http://localhost:3000", SESSION));
    expect(url.pathname).toBe("/login/recover");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${SESSION}`);
  });

  it("follows PUBLIC_URL", () => {
    expect(recoveryUrl("https://truth-skills.example/", SESSION)).toBe(`https://truth-skills.example/login/recover#${SESSION}`);
  });
});

describe("parseRecoveryInput", () => {
  it.each([
    ["a full link", `http://localhost:3000/login/recover#${SESSION}`],
    ["a bare id", SESSION],
    ["an id with whitespace", `\n  ${SESSION}  `],
  ])("reads %s", (_label, input) => {
    expect(parseRecoveryInput(input)).toBe(SESSION);
  });

  it.each([
    ["an empty string", ""],
    ["a link without session", "http://localhost:3000/login/recover"],
    ["a too-short id", "session_abc123"],
    ["uppercase hex", `session_${"AB".repeat(64)}`],
  ])("returns null for %s", (_label, input) => {
    expect(parseRecoveryInput(input)).toBeNull();
  });
});
