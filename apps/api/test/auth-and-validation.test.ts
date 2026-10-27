import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { bearerToken, createTokenVerifier, type TokenVerifier } from "../src/auth.js";
import type { Database } from "../src/db.js";

const SUPABASE_URL = "https://example-project.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const USER = "4f1c2a3b-5d6e-4f70-8a91-b2c3d4e5f607";
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
    expect(await verify(await sign({ sub: USER, role: "authenticated" }))).toBe(USER);
  });

  test("rejects wrong issuer, wrong audience, expired, anon role, missing or malformed sub", async () => {
    const rejected = [
      await sign({ sub: USER, role: "authenticated" }, { issuer: "https://evil.example/auth/v1" }),
      await sign({ sub: USER, role: "authenticated" }, { audience: "anon" }),
      await sign({ sub: USER, role: "authenticated" }, { expiresIn: "-1m" }),
      await sign({ sub: USER, role: "anon" }),
      await sign({ role: "authenticated" }),
      await sign({ sub: "not-a-uuid", role: "authenticated" }),
      "not.a.token",
    ];
    for (const token of rejected) expect(await verify(token)).toBeUndefined();
  });

  test("rejects a token signed with a shared secret (HS256), even with valid claims", async () => {
    const hs256 = await new SignJWT({ sub: USER, role: "authenticated" })
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
  const app = () => buildApp({ verifyToken: verify, db: untouchable });

  test("no or invalid token: 401 with a fixed message", async () => {
    for (const headers of [{}, { authorization: "Bearer x.y.z" }, { authorization: `Bearer ${"a".repeat(10)}` }]) {
      const response = await app().inject({ method: "GET", url: "/v1/projects", headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized", message: "Sign in again." });
    }
  });

  test("invalid input: 400 with a fixed message that never echoes the request", async () => {
    const authorization = `Bearer ${await sign({ sub: USER, role: "authenticated" })}`;
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
    const authorization = `Bearer ${await sign({ sub: USER, role: "authenticated" })}`;
    const response = await app().inject({
      method: "PUT",
      url: `/v1/projects/${USER}/environments/production/variables/BIG/value`,
      headers: { authorization },
      payload: { value: "x".repeat(100_000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.body).not.toContain("xxxx");
  });

  test("an unexpected failure: 500 with a fixed message, never the error's text", async () => {
    const leaky: Database = {
      withUser: async () => {
        throw new Error(`connection to postgres://user:${FAKE_SECRET}@db failed`);
      },
      close: async () => undefined,
    };
    const authorization = `Bearer ${await sign({ sub: USER, role: "authenticated" })}`;
    const response = await buildApp({ verifyToken: verify, db: leaky }).inject({ method: "GET", url: "/v1/projects", headers: { authorization } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error", message: "Something went wrong." });
  });
});
