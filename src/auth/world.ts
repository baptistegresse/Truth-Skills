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

const VerifyResponse = z.object({
  success: z.boolean(),
  nullifier: z.string().optional(),
  session_id: z.string().optional(),
  code: z.string().optional(),
});

export interface VerifiedProof {
  nullifier?: string;
  sessionId?: string;
}

export class WorldRejectedError extends Error {
  constructor(readonly code: string) {
    super(`World ID rejected the proof: ${code}`);
  }
}

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
    const parsed = VerifyResponse.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success || !parsed.data.success) {
      throw new WorldRejectedError(parsed.success ? (parsed.data.code ?? `http_${response.status}`) : "malformed_response");
    }
    return { nullifier: parsed.data.nullifier, sessionId: parsed.data.session_id };
  },
});
