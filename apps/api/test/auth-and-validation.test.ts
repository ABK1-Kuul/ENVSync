import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { bearerToken, cachedSessionChecker, createSessionChecker, createTokenVerifier, type TokenVerifier } from "../src/auth.js";
import type { Database } from "../src/db.js";

const SUPABASE_URL = "https://example-project.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const USER = "4f1c2a3b-5d6e-4f70-8a91-b2c3d4e5f607";
const SESSION = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const FAKE_SECRET = "ENVSYNC_FAKE_SECRET_DO_NOT_LEAK";

let verify: TokenVerifier;
let sign: (claims: Record<string, unknown>, options?: { issuer?: string; audience?: string; expiresIn?: string }) => Promise<string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", kid: "k1" }] });
  verify = createTokenVerifier(SUPABASE_URL, jwks);
  sign = (claims, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? "authenticated")
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(privateKey);
});

describe("token verification", () => {
  test("accepts a valid Supabase access token and returns the user id from `sub`", async () => {
    expect(await verify(await sign({ sub: USER, role: "authenticated", session_id: SESSION }))).toEqual({ userId: USER, sessionId: SESSION });
  });

  test("rejects wrong issuer, wrong audience, expired, anon role, missing or malformed sub", async () => {
    const rejected = [
      await sign({ sub: USER, role: "authenticated", session_id: SESSION }, { issuer: "https://evil.example/auth/v1" }),
      await sign({ sub: USER, role: "authenticated", session_id: SESSION }, { audience: "anon" }),
      await sign({ sub: USER, role: "authenticated", session_id: SESSION }, { expiresIn: "-1m" }),
      await sign({ sub: USER, role: "anon" }),
      await sign({ role: "authenticated" }),
      await sign({ sub: "not-a-uuid", role: "authenticated" }),
      "not.a.token",
    ];
    for (const token of rejected) expect(await verify(token)).toBeUndefined();
  });

  test("rejects a token without a session id, and anonymous sign-ins (review M4)", async () => {
    expect(await verify(await sign({ sub: USER, role: "authenticated" }))).toBeUndefined();
    expect(await verify(await sign({ sub: USER, role: "authenticated", session_id: SESSION, is_anonymous: true }))).toBeUndefined();
  });

  test("rejects a token signed with a shared secret (HS256), even with valid claims", async () => {
    const hs256 = await new SignJWT({ sub: USER, role: "authenticated", session_id: SESSION })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-shared-secret-that-is-long-enough-123"));
    expect(await verify(hs256)).toBeUndefined();
  });

  test("bearerToken accepts only a well-formed Bearer header", () => {
    expect(bearerToken("Bearer aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
    for (const header of [undefined, "", "bearer aaa.bbb.ccc", "Bearer aaa.bbb", "Bearer aaa.bbb.ccc extra", "Basic dXNlcjpwYXNz"]) {
      expect(bearerToken(header)).toBeUndefined();
    }
  });
});

describe("requests are rejected before reaching the database", () => {
  const untouchable: Database = {
    withUser: async () => {
      throw new Error("the database must not be reached");
    },
    close: async () => undefined,
  };
  const app = () => buildApp({ verifyToken: verify, checkSession: async () => true, db: untouchable });

  test("no or invalid token: 401 with a fixed message", async () => {
    for (const headers of [{}, { authorization: "Bearer x.y.z" }, { authorization: `Bearer ${"a".repeat(10)}` }]) {
      const response = await app().inject({ method: "GET", url: "/v1/projects", headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized", message: "Sign in again." });
    }
  });

  test("invalid input: 400 with a fixed message that never echoes the request", async () => {
    const authorization = `Bearer ${await sign({ sub: USER, role: "authenticated", session_id: SESSION })}`;
    const cases = [
      { method: "GET" as const, url: "/v1/projects/not-a-uuid" },
      { method: "PUT" as const, url: `/v1/projects/${USER}/variables/1BAD`, payload: { visibility: "secret" } },
      { method: "PUT" as const, url: `/v1/projects/${USER}/variables/OK`, payload: { visibility: "public" } },
      { method: "PUT" as const, url: `/v1/projects/${USER}/variables/OK`, payload: { visibility: "plain", extra: FAKE_SECRET } },
      { method: "PUT" as const, url: `/v1/projects/${USER}/environments/staging/variables/OK/value`, payload: { value: FAKE_SECRET } },
      { method: "PUT" as const, url: `/v1/projects/${USER}/environments/production/variables/OK/value`, payload: { value: 42 } },
      { method: "POST" as const, url: "/v1/projects", payload: { name: "" } },
    ];
    for (const { method, url, payload } of cases) {
      const response = await app().inject({ method, url, headers: { authorization }, ...(payload ? { payload } : {}) });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request", message: "The request is not valid." });
      expect(response.body).not.toContain(FAKE_SECRET);
    }
  });

  test("an oversized body: 413", async () => {
    const authorization = `Bearer ${await sign({ sub: USER, role: "authenticated", session_id: SESSION })}`;
    const response = await app().inject({
      method: "PUT",
      url: `/v1/projects/${USER}/environments/production/variables/BIG/value`,
      headers: { authorization },
      payload: { value: "x".repeat(100_000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.body).not.toContain("xxxx");
  });

  test("every response says no-store (it may carry values) (review L8)", async () => {
    const response = await app().inject({ method: "GET", url: "/v1/projects" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("a signed-out session is refused on every route, before the database (review M-B)", async () => {
    const authorization = `Bearer ${await sign({ sub: USER, role: "authenticated", session_id: SESSION })}`;
    const signedOut = buildApp({ verifyToken: verify, checkSession: async () => false, db: untouchable });
    for (const [method, url] of [
      ["GET", "/v1/projects"],
      ["GET", `/v1/projects/${USER}`],
      ["DELETE", `/v1/projects/${USER}`],
      ["POST", `/v1/projects/${USER}/environments/production/variables/KEY/value/reveal`],
    ] as const) {
      expect((await signedOut.inject({ method, url, headers: { authorization } })).statusCode, url).toBe(401);
    }
  });

  test("reveals check the session afresh, and only then count against the rate limit (review M4/L8, Low 5)", async () => {
    const authorization = `Bearer ${await sign({ sub: USER, role: "authenticated", session_id: SESSION })}`;
    const url = `/v1/projects/${USER}/environments/production/variables/KEY/value/reveal`;
    let live = true;
    let checks = 0;
    const app = buildApp({
      verifyToken: verify,
      checkSession: async () => {
        checks++;
        return live;
      },
      db: untouchable,
      revealsPerMinute: 2,
    });
    // Past the session check and the limit, the untouchable database answers 500.
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await app.inject({ method: "POST", url, headers: { authorization } })).statusCode);
    expect(statuses).toEqual([500, 500, 429]);
    // One check for the first request's onRequest (then cached), plus one fresh check per reveal.
    expect(checks).toBe(4);
    // Signed out: the reveal's fresh check refuses it at once, even though onRequest's answer is cached.
    live = false;
    expect((await app.inject({ method: "POST", url, headers: { authorization } })).statusCode).toBe(401);
  });

  test("an unexpected failure: 500 with a fixed message, never the error's text", async () => {
    const leaky: Database = {
      withUser: async () => {
        throw new Error(`connection to postgres://user:${FAKE_SECRET}@db failed`);
      },
      close: async () => undefined,
    };
    const authorization = `Bearer ${await sign({ sub: USER, role: "authenticated", session_id: SESSION })}`;
    const response = await buildApp({ verifyToken: verify, checkSession: async () => true, db: leaky }).inject({ method: "GET", url: "/v1/projects", headers: { authorization } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error", message: "Something went wrong." });
  });
});

describe("session checks (review M-B, Low 2)", () => {
  test("fails closed: a network error, a non-2xx answer or a timeout all mean 'not live'", async () => {
    const throwing = createSessionChecker(SUPABASE_URL, "anon", 50, async () => {
      throw new Error("network down");
    });
    const unauthorized = createSessionChecker(SUPABASE_URL, "anon", 50, async () => new Response("{}", { status: 401 }));
    const hanging = createSessionChecker(SUPABASE_URL, "anon", 50, (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const ok = createSessionChecker(SUPABASE_URL, "anon", 50, async () => new Response("{}", { status: 200 }));
    expect(await throwing("t")).toBe(false);
    expect(await unauthorized("t")).toBe(false);
    expect(await hanging("t")).toBe(false);
    expect(await ok("t")).toBe(true);
  });

  test("only live answers are cached, briefly, per session; `fresh` bypasses the cache", async () => {
    let live = true;
    let calls = 0;
    const cached = cachedSessionChecker(async () => {
      calls++;
      return live;
    }, 60_000);
    expect(await cached("t", "s1")).toBe(true);
    expect(await cached("t", "s1")).toBe(true);
    expect(calls).toBe(1);
    live = false;
    expect(await cached("t", "s1")).toBe(true); // still cached
    expect(await cached("t", "s1", true)).toBe(false); // fresh check sees the sign-out
    expect(await cached("t", "s1")).toBe(false); // and the cached answer is gone
    expect(calls).toBe(3);
  });
});
