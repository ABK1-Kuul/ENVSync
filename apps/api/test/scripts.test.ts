import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
// @ts-expect-error - plain JavaScript script modules, tested directly
import { redact } from "../scripts/env.mjs";
// @ts-expect-error - plain JavaScript script modules, tested directly
import { scramVerifier } from "../scripts/scram.mjs";

describe("scramVerifier (review L9/M3)", () => {
  test("matches the RFC 7677 SCRAM-SHA-256 example: it verifies the client's proof and reproduces the server's signature", () => {
    // RFC 7677, section 3: user "user", password "pencil".
    const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
    const verifier: string = scramVerifier("pencil", salt, 4096);
    const [, rest] = verifier.split("SCRAM-SHA-256$") as [string, string];
    const [iterationsAndSalt, keys] = rest.split("$") as [string, string];
    expect(iterationsAndSalt).toBe("4096:W22ZaJ0SNY7soEsUEjb6gQ==");
    const [storedKey, serverKey] = keys.split(":").map((key) => Buffer.from(key, "base64")) as [Buffer, Buffer];

    const clientFirstBare = "n=user,r=rOprNGfwEbeRWgbNEkqO";
    const serverFirst = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
    const clientFinalWithoutProof = "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;

    const serverSignature = createHmac("sha256", serverKey).update(authMessage).digest("base64");
    expect(serverSignature).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");

    const proof = Buffer.from("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=", "base64");
    const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(proof.map((byte, index) => byte ^ (clientSignature[index] as number)));
    expect(createHash("sha256").update(clientKey).digest().equals(storedKey)).toBe(true);
  });

  test("uses a fresh random salt each time, and refuses non-ASCII passwords", () => {
    expect(scramVerifier("same-password")).not.toBe(scramVerifier("same-password"));
    expect(() => scramVerifier("pässword")).toThrow();
  });
});

describe("redact (review L10, Low 3)", () => {
  const env = {
    SUPABASE_DB_URL: "postgresql://postgres.abcdefghij:pa%25ss%2Fword@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
    ENVSYNC_API_DB_URL: "postgresql://envsync_api.abcdefghij:Zm9vYmFyYmF6@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
    SUPABASE_URL: "https://abcdefghij.supabase.co",
  };

  test("removes passwords (raw and decoded), user names and hosts", () => {
    const message = "password authentication failed for user postgres.abcdefghij (pa%ss/word) at aws-0-eu-west-1.pooler.supabase.com; also Zm9vYmFyYmF6 and envsync_api.abcdefghij via abcdefghij.supabase.co";
    const result = redact(message, env);
    for (const secret of ["abcdefghij", "pa%ss/word", "aws-0-eu-west-1", "Zm9vYmFyYmF6"]) expect(result).not.toContain(secret);
    expect(result).toContain("password authentication failed");
  });

  test("still redacts the raw forms when the password has malformed percent-encoding", () => {
    const broken = { SUPABASE_DB_URL: "postgresql://postgres.zyxwvutsrq:bad%zzpass@db.zyxwvutsrq.supabase.co:5432/postgres" };
    const result = redact("failed for postgres.zyxwvutsrq with bad%zzpass at db.zyxwvutsrq.supabase.co", broken);
    for (const secret of ["zyxwvutsrq", "bad%zzpass"]) expect(result).not.toContain(secret);
  });

  test("ignores unset or unparseable settings", () => {
    expect(redact("nothing to hide", {})).toBe("nothing to hide");
    expect(redact("nothing to hide", { SUPABASE_DB_URL: "not a url" })).toBe("nothing to hide");
  });
});
