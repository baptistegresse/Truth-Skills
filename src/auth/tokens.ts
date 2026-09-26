import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const ALG = "HS256";
const TYP = "at+jwt"; // RFC 9068: a JWT that is an OAuth access token, not an ID token

const key = (secret: string) => new TextEncoder().encode(secret);

// 32 random bytes, base64url: authorization codes and refresh tokens.
export const randomToken = () => randomBytes(32).toString("base64url");

// Codes and refresh tokens are stored as SHA-256 hex only, so a database leak leaks nothing usable.
// No salt is needed: the input is already 256 bits of randomness.
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface AccessTokenClaims {
  accountId: string;
  clientId: string;
  scopes: string[];
  resource: string; // the canonical /mcp URL, checked as the audience
}

export interface VerifiedAccessToken {
  accountId: string;
  clientId: string;
  scopes: string[];
  expiresAt: number; // seconds since epoch
}

export const signAccessToken = (claims: AccessTokenClaims, secret: string, issuer: string, ttlSeconds: number) =>
  new SignJWT({ client_id: claims.clientId, scope: claims.scopes.join(" ") })
    .setProtectedHeader({ alg: ALG, typ: TYP })
    .setSubject(claims.accountId)
    .setIssuer(issuer)
    .setAudience(claims.resource)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));

// Throws on a bad signature, another algorithm, another typ, a wrong issuer or audience, an
// expired token, or missing claims. Callers turn any throw into a 401.
export const verifyAccessToken = async (
  token: string,
  secret: string,
  issuer: string,
  audience: string,
): Promise<VerifiedAccessToken> => {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer,
    audience,
    algorithms: [ALG],
    typ: TYP,
    requiredClaims: ["sub", "exp", "iat"],
  });
  if (typeof payload.sub !== "string" || typeof payload.client_id !== "string" || typeof payload.exp !== "number") {
    throw new Error("Malformed access token");
  }
  return {
    accountId: payload.sub,
    clientId: payload.client_id,
    scopes: String(payload.scope ?? "").split(" ").filter(Boolean),
    expiresAt: payload.exp,
  };
};
