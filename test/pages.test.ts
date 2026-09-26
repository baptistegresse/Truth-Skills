import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { testConfig } from "./helpers/config.js";

const unexpected = async (): Promise<never> => {
  throw new Error("unexpected database call");
};
const app = createApp({ config: testConfig(), db: { query: unexpected, connect: unexpected } });

describe("sign-in pages", () => {
  it.each(["/login", "/login/recover"])("serves %s locked down", async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("has no inline script on the sign-in page", async () => {
    const res = await request(app).get("/login");
    expect(res.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(res.text).toContain('src="/login/assets/idkit.global.js"');
  });

  it.each([
    ["login.js", /javascript/],
    ["login.css", /text\/css/],
    ["idkit.global.js", /javascript/],
    ["idkit_wasm_bg.wasm", /application\/wasm/],
    ["qrcode.js", /javascript/],
  ])("serves the asset %s", async (name, type) => {
    const res = await request(app).get(`/login/assets/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(type);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it.each(["package.json", "..%2F..%2Fpackage.json", "index.js"])("serves nothing else (%s)", async (name) => {
    expect((await request(app).get(`/login/assets/${name}`)).status).toBe(404);
  });
});
