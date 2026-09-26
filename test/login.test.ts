import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { randomToken } from "../src/auth/tokens.js";
import { WorldRejectedError, type WorldVerifier } from "../src/auth/world.js";
import { ACCOUNT_ACTION } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { testConfig } from "./helpers/config.js";
import { createTestDb } from "./helpers/pglite.js";

const CALLBACK = "http://localhost:51938/callback";

// Stands in for the World Verify API. The fake proofs below carry what World would answer.
const fakeWorld = {
  verify: vi.fn(async (result: unknown) => {
    const proof = result as { reject?: string; fake_nullifier?: string; session_id?: string };
    if (proof.reject) throw new WorldRejectedError(proof.reject);
    return { nullifier: proof.fake_nullifier, sessionId: proof.session_id };
  }),
} satisfies WorldVerifier;

const accountProof = (nonce: string, nullifier: string, extra: object = {}) => ({
  protocol_version: "4.0",
  nonce,
  environment: "sandbox",
  action: ACCOUNT_ACTION,
  responses: [],
  fake_nullifier: nullifier,
  ...extra,
});

const sessionProof = (nonce: string, sessionId: string, extra: object = {}) => ({
  protocol_version: "4.0",
  nonce,
  environment: "sandbox",
  session_id: sessionId,
  responses: [],
  ...extra,
});

// The format World App uses, and IDKit.proveSession requires.
const newSessionId = () => `session_${randomBytes(64).toString("hex")}`;

const setup = async (overrides: Record<string, string> = {}) => {
  const db = await createTestDb();
  await runMigrations(db);
  const config = testConfig(overrides);
  const app = createApp({ config, db, world: fakeWorld });
  const client = await request(app)
    .post("/register")
    .send({ client_name: "Claude Code (truth-skills)", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" });

  const verifier = randomToken();
  const startLogin = async () => {
    const res = await request(app)
      .get("/authorize")
      .query({
        response_type: "code",
        client_id: client.body.client_id,
        redirect_uri: CALLBACK,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: "state-1",
        resource: new URL("/mcp", config.PUBLIC_URL).href,
      });
    return new URL(res.headers.location!).searchParams.get("req")!;
  };
  const rp = (req: string, kind: string, extra: object = {}, cookie?: string) => {
    const call = request(app).post("/login/rp-context");
    return (cookie ? call.set("cookie", cookie) : call).send({ req, kind, ...extra });
  };
  const verify = (req: string, result: object) => request(app).post("/login/verify").send({ req, result });

  // Scan 1 then scan 2, as the page does it. Returns both answers.
  const signUp = async (req: string, nullifier: string, sessionId = newSessionId()) => {
    const first = await rp(req, "account");
    const account = await verify(req, accountProof(first.body.rp_context.nonce, nullifier));
    const second = await rp(req, "session");
    const session = await verify(req, sessionProof(second.body.rp_context.nonce, sessionId));
    return { account, session, sessionId };
  };

  return { db, app, clientId: client.body.client_id as string, verifier, startLogin, rp, verify, signUp };
};

describe("World ID sign-in", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    t = await setup();
  });
  afterAll(async () => {
    await t.db.close();
  });
  beforeEach(() => {
    fakeWorld.verify.mockClear();
  });

  const stepOf = async (req: string) =>
    (await t.db.query<{ step: string }>("select step from auth_requests where id = $1", [req])).rows[0]?.step;

  describe("GET /login/context", () => {
    it("tells the page who is asking and how to reach World ID", async () => {
      const res = await request(t.app).get("/login/context").query({ req: await t.startLogin() });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        client_name: "Claude Code (truth-skills)",
        redirect_host: "localhost:51938",
        app_id: "app_test",
        environment: "sandbox",
        credentials: ["proof_of_human", "selfie"],
        invite_code: false,
        returning: false,
      });
    });

    it("notices a returning browser by its session cookie", async () => {
      const res = await request(t.app)
        .get("/login/context")
        .query({ req: await t.startLogin() })
        .set("cookie", "hr_world_session=session_ab");
      expect(res.body.returning).toBe(true);
    });

    it("answers 400 to a malformed id and 410 to an unknown one", async () => {
      expect((await request(t.app).get("/login/context").query({ req: "nope" })).status).toBe(400);
      const res = await request(t.app).get("/login/context").query({ req: "00000000-0000-4000-8000-000000000000" });
      expect(res.status).toBe(410);
      expect(res.body.error).toMatch(/expired/);
    });
  });

  describe("a first sign-in", () => {
    it("creates the account, links the session, and ends at Claude Code's callback", async () => {
      const req = await t.startLogin();

      const first = await t.rp(req, "account");
      expect(first.status).toBe(200);
      expect(first.body.action).toBe(ACCOUNT_ACTION);
      expect(first.body.rp_context).toMatchObject({ rp_id: "rp_test", nonce: expect.stringMatching(/^0x/) });
      expect(await stepOf(req)).toBe("account");

      const account = await t.verify(req, accountProof(first.body.rp_context.nonce, "0xaaa"));
      expect(account.body).toEqual({ next: "create_session" });
      expect(await stepOf(req)).toBe("awaiting_session");

      const second = await t.rp(req, "session");
      expect(second.body.action).toBeUndefined();

      const sessionId = newSessionId();
      const session = await t.verify(req, sessionProof(second.body.rp_context.nonce, sessionId));
      expect(session.status).toBe(200);
      const callback = new URL(session.body.redirect);
      expect(callback.origin + callback.pathname).toBe(CALLBACK);
      expect(callback.searchParams.get("state")).toBe("state-1");

      const cookie = session.headers["set-cookie"]![0]!;
      expect(cookie).toContain(`hr_world_session=${sessionId}`);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/login/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).not.toMatch(/Secure/);

      const { rows } = await t.db.query<{ world_session_id: string; nullifier: string }>(
        `select a.world_session_id, n.nullifier from accounts a join world_nullifiers n on n.account_id = a.id
         where n.nullifier = $1`,
        ["0xaaa"],
      );
      expect(rows).toEqual([{ world_session_id: sessionId, nullifier: "0xaaa" }]);
      expect(await stepOf(req)).toBeUndefined(); // the login request is closed

      const tokens = await request(t.app).post("/token").type("form").send({
        grant_type: "authorization_code",
        client_id: t.clientId,
        code: callback.searchParams.get("code"),
        code_verifier: t.verifier,
        redirect_uri: CALLBACK,
      });
      expect(tokens.status).toBe(200);
      expect(tokens.body.token_type).toBe("Bearer");
    });

    it("signs a human with an account straight in, without a second account", async () => {
      await t.signUp(await t.startLogin(), "0xbbb");
      const req = await t.startLogin();
      const first = await t.rp(req, "account");
      const res = await t.verify(req, accountProof(first.body.rp_context.nonce, "0xbbb"));
      expect(new URL(res.body.redirect).searchParams.get("code")).toBeTruthy();
      const { rows } = await t.db.query("select 1 from world_nullifiers where nullifier = $1", ["0xbbb"]);
      expect(rows).toHaveLength(1);
    });

    it("sends an account whose scan 2 was abandoned through scan 2 again", async () => {
      const abandoned = await t.startLogin();
      const first = await t.rp(abandoned, "account");
      await t.verify(abandoned, accountProof(first.body.rp_context.nonce, "0x777"));

      const req = await t.startLogin();
      const again = await t.rp(req, "account");
      expect((await t.verify(req, accountProof(again.body.rp_context.nonce, "0x777"))).body).toEqual({
        next: "create_session",
      });
      const second = await t.rp(req, "session");
      const session = await t.verify(req, sessionProof(second.body.rp_context.nonce, newSessionId()));
      expect(session.body.redirect).toContain("code=");
      const { rows } = await t.db.query("select 1 from world_nullifiers where nullifier = $1", ["0x777"]);
      expect(rows).toHaveLength(1);
    });
  });

  describe("the step order", () => {
    it("refuses scan 2 before scan 1", async () => {
      const res = await t.rp(await t.startLogin(), "session");
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Login step out of order.");
    });

    it("refuses scan 1 again once the account exists", async () => {
      const req = await t.startLogin();
      const first = await t.rp(req, "account");
      await t.verify(req, accountProof(first.body.rp_context.nonce, "0xccc"));
      expect((await t.rp(req, "account")).status).toBe(409);
    });

    it("allows retrying scan 1 with a new request", async () => {
      const req = await t.startLogin();
      const first = await t.rp(req, "account");
      const retry = await t.rp(req, "account");
      expect(retry.status).toBe(200);
      // Only the latest request can be answered.
      expect((await t.verify(req, accountProof(first.body.rp_context.nonce, "0xddd"))).status).toBe(409);
      expect((await t.verify(req, accountProof(retry.body.rp_context.nonce, "0xddd"))).status).toBe(200);
    });

    it("lets a pasted recovery link interrupt scan 1, and scan 1 follow a failed prove", async () => {
    const { session: done } = await t.signUp(await t.startLogin(), "0x888");
    const req = await t.startLogin();
    await t.rp(req, "account");
    expect((await t.rp(req, "prove", { recovery: done.body.recovery_url })).status).toBe(200);
    expect((await t.rp(req, "account")).status).toBe(200);
  });

  it("refuses an unknown kind", async () => {
      expect((await t.rp(await t.startLogin(), "admin")).status).toBe(400);
    });
  });

  describe("POST /login/verify", () => {
    it("refuses a proof for a request it never signed, without asking World", async () => {
      const req = await t.startLogin();
      await t.rp(req, "account");
      const res = await t.verify(req, accountProof("0xforged", "0xeee"));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Stale proof, try again.");
      expect(fakeWorld.verify).not.toHaveBeenCalled();
    });

    it("burns the nonce: a proof cannot be submitted twice", async () => {
      const req = await t.startLogin();
      const first = await t.rp(req, "account");
      const proof = accountProof(first.body.rp_context.nonce, "0xfff", { reject: "invalid_proof" });
      expect((await t.verify(req, proof)).status).toBe(401);
      expect((await t.verify(req, proof)).status).toBe(409);
      expect(fakeWorld.verify).toHaveBeenCalledTimes(1);
    });

    it("refuses a proof from another World ID environment", async () => {
      const req = await t.startLogin();
      const first = await t.rp(req, "account");
      const res = await t.verify(req, accountProof(first.body.rp_context.nonce, "0x111", { environment: "production" }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Wrong World ID environment.");
      expect(fakeWorld.verify).not.toHaveBeenCalled();
    });

    it.each([
      ["another action", { action: "other-action" }],
      ["a session proof", { session_id: "session_ab" }],
    ])("refuses %s at the account step", async (_label, extra) => {
      const req = await t.startLogin();
      const first = await t.rp(req, "account");
      const res = await t.verify(req, accountProof(first.body.rp_context.nonce, "0x222", extra));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Unexpected proof type.");
    });

    it("answers 401 when World rejects the proof", async () => {
      const req = await t.startLogin();
      const first = await t.rp(req, "account");
      const res = await t.verify(req, accountProof(first.body.rp_context.nonce, "0x333", { reject: "invalid_proof" }));
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("World ID could not verify this proof.");
    });

    it("answers 502 when World returns no nullifier", async () => {
      const req = await t.startLogin();
      const first = await t.rp(req, "account");
      const res = await t.verify(req, { ...accountProof(first.body.rp_context.nonce, ""), fake_nullifier: undefined });
      expect(res.status).toBe(502);
    });

    it("refuses a World ID session already linked to another account", async () => {
      const { sessionId } = await t.signUp(await t.startLogin(), "0x444");
      const req = await t.startLogin();
      const { session } = await t.signUp(req, "0x555", sessionId);
      expect(session.status).toBe(409);
      expect(session.body.error).toBe("This World ID session is already linked.");
    });

    it("answers 410 once the login request expired", async () => {
      const req = await t.startLogin();
      await t.db.query("update auth_requests set expires_at = now() - interval '1 second' where id = $1", [req]);
      expect((await t.rp(req, "account")).status).toBe(410);
    });

    it("answers 400 to malformed JSON", async () => {
      const res = await request(t.app).post("/login/verify").set("content-type", "application/json").send("{nope");
      expect(res.status).toBe(400);
    });
  });
});

describe("returning humans", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let sessionId: string;
  let recoveryUrl: string;
  let accountId: string;
  beforeAll(async () => {
    t = await setup();
    const { session, sessionId: id } = await t.signUp(await t.startLogin(), "0xreturning");
    sessionId = id;
    recoveryUrl = session.body.recovery_url;
    accountId = (await t.db.query<{ id: string }>("select id from accounts where world_session_id = $1", [id])).rows[0]!.id;
  });
  afterAll(async () => {
    await t.db.close();
  });

  const cookie = () => `hr_world_session=${sessionId}`;
  const accountOfCode = async (redirect: string) => {
    const code = new URL(redirect).searchParams.get("code")!;
    const { rows } = await t.db.query<{ account_id: string }>("select account_id from auth_codes where code_hash = $1", [
      createHash("sha256").update(code).digest("hex"),
    ]);
    return rows[0]!.account_id;
  };

  it("gets a recovery link after sign-up, with the session in the fragment", () => {
    expect(recoveryUrl).toBe(`http://localhost:3000/login/recover#${sessionId}`);
  });

  it("signs back in with one scan in the same browser", async () => {
    const req = await t.startLogin();
    const rp = await t.rp(req, "prove", {}, cookie());
    expect(rp.status).toBe(200);
    expect(rp.body.session_id).toBe(sessionId);
    expect(rp.body.action).toBeUndefined();

    const res = await t.verify(req, sessionProof(rp.body.rp_context.nonce, sessionId));
    expect(res.status).toBe(200);
    expect(await accountOfCode(res.body.redirect)).toBe(accountId);
    expect(res.headers["set-cookie"]![0]).toContain(`hr_world_session=${sessionId}`);
  });

  it.each([
    ["the full link", () => recoveryUrl],
    ["the bare id, with spaces", () => `  ${sessionId}\n`],
  ])("signs in on a new machine with %s", async (_label, input) => {
    const req = await t.startLogin();
    const rp = await t.rp(req, "prove", { recovery: input() });
    expect(rp.body.session_id).toBe(sessionId);
    const res = await t.verify(req, sessionProof(rp.body.rp_context.nonce, sessionId));
    expect(await accountOfCode(res.body.redirect)).toBe(accountId);
    const { rows } = await t.db.query<{ n: number }>("select count(*)::int as n from world_nullifiers where nullifier = $1", [
      "0xreturning",
    ]);
    expect(rows[0]!.n).toBe(1); // still one account
  });

  it("prefers a pasted link over the cookie", async () => {
    const req = await t.startLogin();
    const rp = await t.rp(req, "prove", { recovery: "not a link" }, cookie());
    expect(rp.status).toBe(404);
    expect(rp.body.error).toBe("This is not a valid recovery link.");
  });

  it.each([
    ["no cookie", {}, undefined, "No previous World ID session in this browser."],
    ["an unknown session", { recovery: `session_${"0".repeat(128)}` }, undefined, "No account matches this recovery link."],
  ])("answers 404 to %s, before asking the phone", async (_label, extra, cookieHeader, error) => {
    const res = await t.rp(await t.startLogin(), "prove", extra, cookieHeader);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(error);
  });

  it("refuses a proof for another session than the one asked", async () => {
    const req = await t.startLogin();
    const rp = await t.rp(req, "prove", {}, cookie());
    const res = await t.verify(req, sessionProof(rp.body.rp_context.nonce, newSessionId()));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unexpected session.");
    expect(fakeWorld.verify).not.toHaveBeenCalledWith(expect.objectContaining({ nonce: rp.body.rp_context.nonce }));
  });

  it("refuses prove once scan 2 is under way", async () => {
    const req = await t.startLogin();
    const first = await t.rp(req, "account");
    await t.verify(req, accountProof(first.body.rp_context.nonce, "0xnew"));
    expect((await t.rp(req, "prove", {}, cookie())).status).toBe(409);
  });
});

describe("World ID sign-in over https", () => {
  it("marks the session cookie Secure", async () => {
    const t = await setup({ PUBLIC_URL: "https://truth-skills.example" });
    const { session } = await t.signUp(await t.startLogin(), "0x666");
    expect(session.headers["set-cookie"]![0]).toMatch(/; Secure/);
    await t.db.close();
  });
});
