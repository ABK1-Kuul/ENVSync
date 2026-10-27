import { parseConfigSource } from "@envsync-internal/schema";
import { describe, expect, test } from "vitest";
import { groupFindings } from "../src/diagnostics.js";
import { decideEdit, describeEdit } from "../src/edit-handler.js";
import { parseWebviewMessage } from "../src/messages.js";
import { buildTableModel, isSafeToDisplay, revealValue } from "../src/model.js";

const FAKE_SECRET = "ENVSYNC_FAKE_SECRET_DO_NOT_LEAK";
const stripe = `sk_live_${"a1".repeat(12)}`;

const config = parseConfigSource(`export default { variables: {
  DATABASE_URL: { type: "url", visibility: "secret" },
  PORT_NUMBER: { type: "number" },
  NEXT_PUBLIC_SITE: { type: "url", secret: false, description: "Public site URL" },
  NEXT_PUBLIC_PAY: {},
} };`);

const text = [
  "# local settings",
  `DATABASE_URL=postgres://u:${FAKE_SECRET}@db/app`,
  "PORT_NUMBER=eighty",
  "NEXT_PUBLIC_SITE=https://example.com",
  `NEXT_PUBLIC_PAY=${stripe}`,
  `API_TOKEN=${FAKE_SECRET}`,
  "EXTRA_VAR=1",
  "EXTRA_VAR=2",
  "not an assignment",
  "",
].join("\n");

const model = buildTableModel({ text, version: 7, fileName: ".env.local", environment: "development", config, publicPrefix: "NEXT_PUBLIC_" });

describe("table model", () => {
  test("one row per name at the effective assignment, with config metadata and issues", () => {
    expect(model).toMatchObject({ version: 7, fileName: ".env.local", environment: "development", hasConfig: true, invalidLines: [9] });
    expect(model.rows.map((row) => [row.name, row.line, row.issues])).toEqual([
      ["DATABASE_URL", 2, []],
      ["PORT_NUMBER", 3, ["type-mismatch"]],
      ["NEXT_PUBLIC_SITE", 4, []],
      ["NEXT_PUBLIC_PAY", 5, ["credential-in-public"]],
      ["API_TOKEN", 6, ["undeclared"]],
      ["EXTRA_VAR", 8, ["duplicate", "undeclared"]],
    ]);
    expect(model.rows[2]).toMatchObject({ value: "https://example.com", masked: false, visibility: "plain", type: "url", description: "Public site URL" });
  });

  test("secret variables, credential-shaped values and private-looking names are masked and never in the model", () => {
    const masked = model.rows.filter((row) => row.masked).map((row) => [row.name, row.maskReason]);
    expect(masked).toEqual([
      ["DATABASE_URL", "Declared secret in envsync.config.ts."],
      ["NEXT_PUBLIC_PAY", "The value looks like a Stripe secret or restricted key."],
      ["API_TOKEN", "The name suggests a private value."],
    ]);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(FAKE_SECRET);
    expect(serialized).not.toContain("a1a1a1");
  });

  test("without a config, nothing is flagged as undeclared, and every value is masked (nothing says which are secret)", () => {
    const bare = buildTableModel({ text: `A_VAR=${FAKE_SECRET}\n`, version: 1, fileName: ".env", environment: "production", config: null, publicPrefix: "NEXT_PUBLIC_" });
    expect(bare).toMatchObject({ hasConfig: false, rows: [{ name: "A_VAR", masked: true, issues: [] }] });
    expect(bare.rows[0]?.maskReason).toContain("No envsync.config.ts");
    expect(JSON.stringify(bare)).not.toContain(FAKE_SECRET);
  });

  test("revealValue returns the effective value of one name, on request", () => {
    expect(revealValue(text, "EXTRA_VAR")).toBe("2");
    expect(revealValue(text, "MISSING")).toBeUndefined();
  });
});

describe("webview messages are validated as untrusted input", () => {
  test("accepts well-formed messages", () => {
    expect(parseWebviewMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebviewMessage({ type: "edit", version: 3, edit: { kind: "set", name: "A", value: "" } })).toEqual({
      type: "edit",
      version: 3,
      edit: { kind: "set", name: "A", value: "" },
    });
    expect(parseWebviewMessage({ type: "edit", version: 3, edit: { kind: "rename", from: "A", to: "B" } })).toBeDefined();
    expect(parseWebviewMessage({ type: "reveal", version: 0, name: "A" })).toBeDefined();
  });

  test("rejects anything else", () => {
    for (const raw of [
      null,
      "ready",
      [],
      { type: "eval", code: "x" },
      { type: "edit", version: "3", edit: { kind: "set", name: "A", value: "x" } },
      { type: "edit", version: -1, edit: { kind: "set", name: "A", value: "x" } },
      { type: "edit", version: 1, edit: { kind: "set", name: "", value: "x" } },
      { type: "edit", version: 1, edit: { kind: "write-file", path: "/etc/passwd" } },
      { type: "edit", version: 1, edit: { kind: "set", name: "A", value: "x".repeat(100_001) } },
      { type: "reveal", version: 1 },
    ]) {
      expect(parseWebviewMessage(raw)).toBeUndefined();
    }
  });
});

describe("edits from the table", () => {
  test("an edit against an older document version is a conflict, never applied", () => {
    expect(decideEdit("A=1\n", 5, 4, { kind: "set", name: "A", value: "2" })).toEqual({ kind: "conflict" });
  });

  test("a current edit becomes a minimal replacement with a value-free label", () => {
    const decision = decideEdit("A=1\nB=2\n", 5, 5, { kind: "set", name: "B", value: FAKE_SECRET });
    expect(decision).toEqual({ kind: "apply", replacement: { start: 6, end: 7, text: FAKE_SECRET }, label: "EnvSync: change the value of B" });
    expect(describeEdit({ kind: "add", name: "C", value: FAKE_SECRET })).not.toContain(FAKE_SECRET);
  });

  test("refusals and no-op edits are reported, not applied", () => {
    expect(decideEdit("A=1\n", 1, 1, { kind: "remove", name: "B" })).toEqual({ kind: "refused", reason: "B is not set in this file." });
    expect(decideEdit("A=1\n", 1, 1, { kind: "set", name: "A", value: "1" })).toEqual({ kind: "refused", reason: "Nothing to change." });
  });
});

describe("diagnostics for the Problems panel", () => {
  test("groups by file, converts to zero-based positions, and attaches project-level findings to the config", () => {
    const grouped = groupFindings(
      [
        { code: "ENV010", severity: "error", message: "Bad value.", file: ".env.local", line: 3, variableName: "A", suggestion: "Fix it." },
        { code: "ENV002", severity: "error", message: "Missing.", file: "envsync.config.ts", line: 2, column: 5 },
        { code: "ENV999" as "ENV001", severity: "warning", message: "Project-level." },
      ],
      "envsync.config.ts",
    );
    expect(Object.fromEntries(grouped)).toEqual({
      ".env.local": [{ file: ".env.local", line: 2, column: 0, severity: "error", code: "ENV010", message: "Bad value. Fix it." }],
      "envsync.config.ts": [
        { file: "envsync.config.ts", line: 1, column: 4, severity: "error", code: "ENV002", message: "Missing." },
        { file: "envsync.config.ts", line: 0, column: 0, severity: "warning", code: "ENV999", message: "Project-level." },
      ],
    });
  });
});

describe("how an edit is confirmed", () => {
  const safe = "# Development defaults\nNEXT_PUBLIC_SITE=https://example.com\nPORT_NUMBER=3000\n";

  test("a diff only when both the current and the proposed file are safe to show in full", async () => {
    const { confirmationMode } = await import("../src/edit-handler.js");
    expect(confirmationMode(safe, safe.replace("3000", "4000"), config)).toBe("diff");
    // The current file already has a hidden value.
    expect(confirmationMode(text, text, config)).toBe("dialog");
    // No config: nothing says which values are secret.
    expect(confirmationMode(safe, safe, null)).toBe("dialog");
  });

  test("the edit itself can make the file unsafe to show: set, add or rename to something hidden (review M2)", async () => {
    const { confirmationMode } = await import("../src/edit-handler.js");
    const cases = [
      safe.replace("https://example.com", stripe), // credential-shaped value
      `${safe}DB_PASSWORD=hunter2\n`, // private-looking name
      safe.replace("PORT_NUMBER", "API_TOKEN"), // rename to a private-looking name
      `${safe}DATABASE_URL=postgres://db/app\n`, // declared secret in the config
    ];
    for (const after of cases) expect(confirmationMode(safe, after, config)).toBe("dialog");
  });

  test("every line counts, not just the effective value of each variable (review M1)", () => {
    // A shadowed earlier assignment holding a connection string with a password.
    expect(isSafeToDisplay(`NEXT_PUBLIC_SITE=postgres://u:${FAKE_SECRET}@db\nNEXT_PUBLIC_SITE=https://x\n`, config)).toBe(false);
    // A commented-out value, and a comment with a credential in it.
    expect(isSafeToDisplay(`# OLD_KEY=${FAKE_SECRET}\nPORT_NUMBER=1\n`, config)).toBe(false);
    expect(isSafeToDisplay(`# rotated ${stripe} last week\nPORT_NUMBER=1\n`, config)).toBe(false);
    // A line that is not an assignment at all.
    expect(isSafeToDisplay(`${FAKE_SECRET}\nPORT_NUMBER=1\n`, config)).toBe(false);
    // Plain comments, blank lines and multi-line quoted plain values are fine.
    expect(isSafeToDisplay(`# Ports\n\nPORT_NUMBER=1\nNEXT_PUBLIC_SITE="https://a\nb"\n`, config)).toBe(true);
  });
});
