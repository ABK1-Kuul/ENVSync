import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verifies Supabase Auth access tokens. The user id always comes from the verified token's `sub`,
 * never from the request, so a client cannot act as someone else.
 */

export type VerifiedToken = { userId: string; sessionId: string };
export type TokenVerifier = (token: string) => Promise<VerifiedToken | undefined>;

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
        requiredClaims: ["exp", "sub", "session_id"],
      });
      if (payload.is_anonymous === true) return undefined; // anonymous sign-ins have no account to protect
      const { sub, session_id: sessionId, role } = payload;
      if (typeof sub !== "string" || !UUID.test(sub) || role !== "authenticated" || typeof sessionId !== "string" || sessionId === "") return undefined;
      return { userId: sub, sessionId };
    } catch {
      return undefined;
    }
  };
}

/** Whether the token's session is still live (not signed out or revoked). */
export type SessionChecker = (token: string) => Promise<boolean>;

/**
 * Asks Supabase Auth whether the session behind a token is still valid. Access tokens stay
 * cryptographically valid until they expire, even after sign-out; this closes that window.
 * Fails closed: an error, a timeout or any non-2xx answer means "not live".
 */
export function createSessionChecker(supabaseUrl: string, anonKey: string, timeoutMs = 5_000, fetcher: typeof fetch = fetch): SessionChecker {
  const base = supabaseUrl.replace(/\/$/, "");
  return async (token) => {
    try {
      const response = await fetcher(`${base}/auth/v1/user`, {
        headers: { apikey: anonKey, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

/**
 * Remembers live sessions for a few seconds so ordinary requests do not each call Supabase Auth.
 * Only positive answers are cached; a signed-out session is refused within `ttlMs`.
 */
export function cachedSessionChecker(check: SessionChecker, ttlMs = 15_000): (token: string, sessionId: string, fresh?: boolean) => Promise<boolean> {
  const liveUntil = new Map<string, number>();
  return async (token, sessionId, fresh = false) => {
    const now = Date.now();
    if (!fresh && (liveUntil.get(sessionId) ?? 0) > now) return true;
    const live = await check(token);
    if (live) {
      liveUntil.set(sessionId, now + ttlMs);
      if (liveUntil.size > 10_000) for (const [key, until] of liveUntil) if (until <= now) liveUntil.delete(key);
    } else {
      liveUntil.delete(sessionId);
    }
    return live;
  };
}

/** The token from an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header ?? "");
  return match?.[1];
}
