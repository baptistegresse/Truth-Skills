import type { Queryable } from "../db/pool.js";

// The steps of one sign-in, stored on auth_requests.step. Each World ID proof request moves the
// login request to a new step, and may only start from the steps listed.
export type Step = "start" | "account" | "awaiting_session" | "session" | "prove";
export type ProofKind = "account" | "session";

export const ALLOWED_FROM: Record<ProofKind, readonly Step[]> = {
  account: ["start", "account"], // retrying scan 1 is allowed
  session: ["awaiting_session", "session"], // scan 2 needs an account first
};

export interface LoginRequest {
  id: string;
  client_id: string;
  redirect_uri: string;
  account_id: string | null;
  step: Step;
  expected_nonce: string | null;
  expected_session_id: string | null;
}

const COLUMNS = "id, client_id, redirect_uri, account_id, step, expected_nonce, expected_session_id";

// Null if unknown or older than 10 minutes.
export const loadLoginRequest = async (db: Queryable, id: string) => {
  const { rows } = await db.query<LoginRequest>(
    `select ${COLUMNS} from auth_requests where id = $1 and expires_at > now()`,
    [id],
  );
  return rows[0] ?? null;
};

// Enters `step` with a fresh nonce, only if the login request is still in one of `from`.
// Checked and written in one statement, so two tabs cannot both start a step.
export const enterStep = async (db: Queryable, id: string, from: readonly Step[], step: Step, nonce: string) => {
  const { rows } = await db.query(
    `update auth_requests set step = $3, expected_nonce = $4
     where id = $1 and step = any($2::text[]) and expires_at > now() returning id`,
    [id, from, step, nonce],
  );
  return rows.length > 0;
};

// Burns the nonce of the proof request currently shown. Returns the login request as it was, or
// null if the nonce does not match: a proof can be submitted once, for this login request only.
export const consumeNonce = async (db: Queryable, id: string, nonce: string) => {
  const { rows } = await db.query<LoginRequest>(
    `update auth_requests set expected_nonce = null
     where id = $1 and expected_nonce = $2 and expires_at > now() returning ${COLUMNS}`,
    [id, nonce],
  );
  return rows[0] ?? null;
};

export const awaitSession = async (db: Queryable, id: string, accountId: string) => {
  await db.query("update auth_requests set step = 'awaiting_session', account_id = $2 where id = $1", [id, accountId]);
};
