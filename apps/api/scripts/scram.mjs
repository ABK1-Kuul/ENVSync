// SCRAM-SHA-256 password verifier in PostgreSQL's format (RFC 5802 / RFC 7677):
//   SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
// Sent instead of the password, so the password itself never reaches the database or its logs.
// The password must be ASCII (no SASLprep is applied).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error("scramVerifier expects a printable ASCII password");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
