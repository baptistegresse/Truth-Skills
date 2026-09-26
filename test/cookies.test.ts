import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { readCookie } from "../src/http/cookies.js";

const withCookie = (cookie?: string) => ({ headers: { cookie } }) as Request;

describe("readCookie", () => {
  it("finds a cookie among others", () => {
    expect(readCookie(withCookie("a=1; hr_world_session=session_ab; b=2"), "hr_world_session")).toBe("session_ab");
  });

  it("does not match on a suffix", () => {
    expect(readCookie(withCookie("xhr_world_session=nope"), "hr_world_session")).toBeUndefined();
  });

  it.each([undefined, "", "hr_world_session=", "hr_world_session=%E0%A4%A"])("returns undefined for %j", (cookie) => {
    expect(readCookie(withCookie(cookie), "hr_world_session")).toBeUndefined();
  });
});
