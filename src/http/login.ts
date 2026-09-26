import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ACCOUNT_ACTION, type Config } from "../config.js";
import {
  attachWorldSession,
  createAccountWithNullifier,
  findAccountByNullifier,
  hasWorldSession,
} from "../auth/accounts.js";
import {
  ALLOWED_FROM,
  awaitSession,
  consumeNonce,
  enterStep,
  loadLoginRequest,
  type LoginRequest,
} from "../auth/loginRequests.js";
import type { TruthSkillsAuthProvider } from "../auth/provider.js";
import { createRpContext, WorldRejectedError, type WorldVerifier } from "../auth/world.js";
import type { Connectable, Queryable } from "../db/pool.js";
import { readCookie } from "./cookies.js";

export const SESSION_COOKIE = "hr_world_session";
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// An error the sign-in page can show as is.
export class LoginError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const RequestId = z.uuid();

const RpContextBody = z.object({
  req: RequestId,
  kind: z.enum(["account", "session"]),
});

// The IDKit result is forwarded to World untouched; we only read the fields we check.
const VerifyBody = z.object({
  req: RequestId,
  result: z.looseObject({
    nonce: z.string(),
    environment: z.string(),
    action: z.string().optional(),
    session_id: z.string().optional(),
  }),
});
type ProofResult = z.infer<typeof VerifyBody>["result"];

export interface LoginDeps {
  db: Queryable & Connectable;
  config: Pick<
    Config,
    "PUBLIC_URL" | "WORLD_APP_ID" | "WORLD_RP_ID" | "WORLD_SIGNING_KEY" | "WORLD_ENVIRONMENT" | "WORLD_CREDENTIALS" | "WORLD_INVITE_CODE" | "WORLD_STAGING_TOKEN"
  >;
  provider: TruthSkillsAuthProvider;
  world: WorldVerifier;
}

export const createLoginRouter = ({ db, config, provider, world }: LoginDeps) => {
  const router = express.Router();
  const secureCookie = new URL(config.PUBLIC_URL).protocol === "https:";

  const requireLoginRequest = async (id: string) => {
    const request = await loadLoginRequest(db, id);
    if (!request) throw new LoginError("This sign-in has expired. Start again from Claude Code.", 410);
    return request;
  };

  const verifyOrThrow = async (result: ProofResult) => {
    try {
      return await world.verify(result);
    } catch (error) {
      if (error instanceof WorldRejectedError) {
        if (config.WORLD_ENVIRONMENT !== "production") console.warn(`World verify: ${error.code}`);
        throw new LoginError("World ID could not verify this proof.", 401);
      }
      throw error;
    }
  };

  // The World ID session is remembered in this browser, for the sign-in routes only.
  const rememberSession = (res: Response, sessionId: string) =>
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie,
      maxAge: COOKIE_MAX_AGE_MS,
      path: "/login",
    });

  // Scan 1: a uniqueness proof for our action. Its nullifier is the same for a given human, so it
  // either finds their account or creates it. An account without a World ID session (scan 2 was
  // abandoned) goes through scan 2 again: without a session, its owner could never come back.
  const handleAccountProof = async (request: LoginRequest, result: ProofResult) => {
    if (result.action !== ACCOUNT_ACTION || result.session_id) throw new LoginError("Unexpected proof type.");
    const { nullifier } = await verifyOrThrow(result);
    if (!nullifier) throw new LoginError("World ID returned no nullifier.", 502);

    const accountId =
      (await findAccountByNullifier(db, nullifier, ACCOUNT_ACTION)) ??
      (await createAccountWithNullifier(db, nullifier, ACCOUNT_ACTION)).accountId;
    if (await hasWorldSession(db, accountId)) {
      return { redirect: await provider.completeAuthorization(request.id, accountId) };
    }
    await awaitSession(db, request.id, accountId);
    return { next: "create_session" as const };
  };

  // Scan 2: a new World ID session, the only way to recognise this human later, since World App
  // will not produce the signup nullifier twice.
  const handleSessionProof = async (request: LoginRequest, result: ProofResult, res: Response) => {
    if (!request.account_id || !result.session_id || result.action) throw new LoginError("Unexpected proof type.");
    const { sessionId } = await verifyOrThrow(result);
    if (!sessionId) throw new LoginError("World ID returned no session.", 502);
    if (sessionId !== result.session_id) throw new LoginError("Unexpected session.");
    if (!(await attachWorldSession(db, request.account_id, sessionId))) {
      throw new LoginError("This World ID session is already linked.", 409);
    }
    rememberSession(res, sessionId);
    return { redirect: await provider.completeAuthorization(request.id, request.account_id) };
  };

  // What the sign-in page shows: who is asking, and how to talk to World ID.
  router.get("/login/context", async (req, res) => {
    const request = await requireLoginRequest(RequestId.parse(req.query.req));
    const client = await provider.clientsStore.getClient(request.client_id);
    res.json({
      client_name: client?.client_name ?? "Unknown application",
      redirect_host: new URL(request.redirect_uri).host,
      app_id: config.WORLD_APP_ID,
      environment: config.WORLD_ENVIRONMENT,
      credentials: config.WORLD_CREDENTIALS,
      invite_code: config.WORLD_INVITE_CODE,
      returning: readCookie(req, SESSION_COOKIE) !== undefined,
    });
  });

  router.use("/login", express.json({ limit: "64kb" }));

  // A freshly signed World ID request for the next step. Its nonce is stored: only a proof
  // answering this exact request will be accepted.
  router.post("/login/rp-context", async (req, res) => {
    const { req: requestId, kind } = RpContextBody.parse(req.body);
    await requireLoginRequest(requestId);
    const action = kind === "account" ? ACCOUNT_ACTION : undefined;
    const rpContext = createRpContext(config, action);
    if (!(await enterStep(db, requestId, ALLOWED_FROM[kind], kind, rpContext.nonce))) {
      throw new LoginError("Login step out of order.", 409);
    }
    res.json({ rp_context: rpContext, action });
  });

  router.post("/login/verify", async (req, res) => {
    const { req: requestId, result } = VerifyBody.parse(req.body);
    await requireLoginRequest(requestId);
    if (result.environment !== config.WORLD_ENVIRONMENT) throw new LoginError("Wrong World ID environment.");
    const request = await consumeNonce(db, requestId, result.nonce);
    if (!request) throw new LoginError("Stale proof, try again.", 409);

    if (request.step === "account") return void res.json(await handleAccountProof(request, result));
    if (request.step === "session") return void res.json(await handleSessionProof(request, result, res));
    throw new LoginError("Login step out of order.", 409);
  });

  router.use("/login", (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof LoginError) return void res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError) return void res.status(400).json({ error: "Invalid request." });
    if (error instanceof SyntaxError) return void res.status(400).json({ error: "Invalid JSON." });
    console.error(error);
    res.status(500).json({ error: "Something went wrong. Try again." });
  });

  return router;
};
