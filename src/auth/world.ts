import { signRequest } from "@worldcoin/idkit-core/signing";
import { z } from "zod";
import type { Config } from "../config.js";

export type WorldConfig = Pick<
  Config,
  "WORLD_RP_ID" | "WORLD_SIGNING_KEY" | "WORLD_ENVIRONMENT" | "WORLD_STAGING_TOKEN"
>;

export interface RpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

// World ID only accepts proof requests signed with the RP signing key, which never leaves the
// server. Uniqueness proofs sign the action in; session proofs have none.
export const createRpContext = (config: WorldConfig, action?: string): RpContext => {
  const signed = signRequest({ signingKeyHex: config.WORLD_SIGNING_KEY, action });
  return {
    rp_id: config.WORLD_RP_ID,
    nonce: signed.nonce,
    created_at: signed.createdAt,
    expires_at: signed.expiresAt,
    signature: signed.sig,
  };
};

// The sandbox verification token only ever goes to World outside production.
export const verifyHeaders = (config: WorldConfig): Record<string, string> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.WORLD_ENVIRONMENT !== "production" && config.WORLD_STAGING_TOKEN) {
    headers["x-staging-verification-token"] = config.WORLD_STAGING_TOKEN;
  }
  return headers;
};

// A field a proof type does not have may come back as null (a session proof has no uniqueness
// nullifier, a success has no error code).
// An error answer carries no success field, only a code and a human-readable detail.
const VerifyError = z.object({ code: z.string(), detail: z.string().nullish() });

const VerifyResponse = z.object({
  success: z.boolean(),
  nullifier: z.string().nullish(),
  session_id: z.string().nullish(),
  code: z.string().nullish(),
});

export interface VerifiedProof {
  nullifier?: string;
  sessionId?: string;
}

export class WorldRejectedError extends Error {
  // detail: World's explanation of an error answer. shape: for an unreadable answer, its HTTP
  // status and field types, to debug without logging values.
  constructor(
    readonly code: string,
    readonly shape?: string,
    readonly detail?: string,
  ) {
    super(`World ID rejected the proof: ${code}`);
  }
}

const typeOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

// "HTTP 200 {success: boolean, nullifier: null}": names and types only, never values.
export const describeShape = (status: number, body: unknown) => {
  if (typeOf(body) !== "object") return `HTTP ${status} ${typeOf(body)}`;
  const fields = Object.entries(body as Record<string, unknown>).map(([key, value]) => `${key}: ${typeOf(value)}`);
  return `HTTP ${status} {${fields.join(", ")}}`;
};

export interface WorldVerifier {
  // Throws WorldRejectedError when World says no.
  verify(result: unknown): Promise<VerifiedProof>;
}

// Forwards the IDKit result untouched to the World Verify API: only World can check the proof.
export const createWorldVerifier = (config: WorldConfig, fetchImpl: typeof fetch = fetch): WorldVerifier => ({
  async verify(result) {
    const response = await fetchImpl(`https://developer.world.org/api/v4/verify/${config.WORLD_RP_ID}`, {
      method: "POST",
      headers: verifyHeaders(config),
      body: JSON.stringify(result),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = VerifyResponse.safeParse(body);
    if (!parsed.success) {
      const error = VerifyError.safeParse(body);
      if (!response.ok && error.success) {
        throw new WorldRejectedError(error.data.code, undefined, error.data.detail ?? undefined);
      }
      throw new WorldRejectedError("malformed_response", describeShape(response.status, body));
    }
    if (!response.ok || !parsed.data.success) {
      throw new WorldRejectedError(parsed.data.code ?? `http_${response.status}`);
    }
    return { nullifier: parsed.data.nullifier ?? undefined, sessionId: parsed.data.session_id ?? undefined };
  },
});
