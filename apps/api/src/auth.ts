import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verifies Supabase Auth access tokens. The user id always comes from the verified token's `sub`,
 * never from the request, so a client cannot act as someone else.
 */

export type TokenVerifier = (token: string) => Promise<string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `keys` defaults to the project's published signing keys (JWKS); tests pass local keys. */
export function createTokenVerifier(supabaseUrl: string, keys?: JWTVerifyGetKey): TokenVerifier {
  const base = supabaseUrl.replace(/\/$/, "");
  const getKey = keys ?? createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: `${base}/auth/v1`,
        audience: "authenticated",
        // Asymmetric algorithms only: a shared-secret (HS*) token is never accepted.
        algorithms: ["ES256", "RS256", "EdDSA"],
        clockTolerance: 5,
      });
      return typeof payload.sub === "string" && UUID.test(payload.sub) && payload.role === "authenticated" ? payload.sub : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The token from an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header ?? "");
  return match?.[1];
}
