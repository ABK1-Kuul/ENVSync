import path from "node:path";
import { parseArgs } from "node:util";
import {
  applyInitPlan,
  countBySeverity,
  DiscoveryError,
  InitError,
  planInit,
  runDoctor,
  scanProject,
  ScanError,
  type DoctorCheck,
} from "@envsync-internal/core";
import { nextFramework } from "@envsync-internal/parser-next";
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE, exitCodeFor } from "./exit-codes.js";
import { countChecks, formatDoctorJson, formatDoctorTerminal } from "./formatters/doctor.js";
import { formatInitPlan } from "./formatters/init.js";
import { formatJson } from "./formatters/json.js";
import { formatTerminal } from "./formatters/terminal.js";

export const VERSION = "0.0.0";
/** Keep in sync with `engines.node` in package.json. */
export const MINIMUM_NODE_VERSION = "22.12.0";

export type CliIO = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  /** Overridable for tests; defaults to the running Node.js version. */
  nodeVersion?: string;
};

const FORMATS = ["terminal", "json"] as const;
type Format = (typeof FORMATS)[number];

const COMMAND_OPTIONS = {
  scan: ["format", "strict"],
  init: ["write"],
  doctor: ["format"],
} as const;
type Command = keyof typeof COMMAND_OPTIONS;

const HELP = `EnvSync - keep environment configuration in sync with your code.

Usage:
  envsync scan [directory] [--format terminal|json] [--strict]
  envsync init [directory] [--write]
  envsync doctor [directory] [--format terminal|json]

Commands:
  scan     Compare process.env references, envsync.config.ts and .env.example.
  init     Preview a starter envsync.config.ts and .env.example placeholders.
           Nothing is written unless you pass --write. Existing files are never
           overwritten; .env.example only gains appended placeholder lines.
  doctor   Check the local setup: config, .env.example, package.json and
           whether local .env files are ignored by git.

Options:
  --format   Output format for scan and doctor: terminal (default) or json.
  --strict   scan: treat warnings as failures.
  --write    init: apply the previewed changes.
  -h, --help     Show this help.
  -v, --version  Show the version.

Exit codes:
  0  Success: no errors (scan, and no warnings with --strict); no failed checks (doctor).
  1  scan found errors (or warnings with --strict); doctor found a failed check.
  2  Usage error, or the command could not run (for example, missing envsync.config.ts
     for scan, or a file that changed between the init preview and --write).

EnvSync never prints environment-variable values, never reads .env files (doctor
checks only their names), never executes project code and makes no network requests.
`;

/** Runs the CLI and returns the process exit code. Never throws. */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        format: { type: "string" },
        strict: { type: "boolean" },
        write: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : "Invalid arguments.");
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT_OK;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    io.stdout(HELP);
    return EXIT_OK;
  }
  if (!isCommand(command)) return usageError(io, `Unknown command \`${command}\`.`);
  if (rest.length > 1) return usageError(io, `\`${command}\` accepts at most one directory.`);

  const allowed: readonly string[] = COMMAND_OPTIONS[command];
  for (const option of ["format", "strict", "write"] as const) {
    if (values[option] !== undefined && !allowed.includes(option)) {
      return usageError(io, `\`--${option}\` is not an option of \`${command}\`.`);
    }
  }

  const format = values.format ?? "terminal";
  if (!isFormat(format)) return usageError(io, `Unknown format \`${format}\`. Use one of: ${FORMATS.join(", ")}.`);
  const root = path.resolve(io.cwd, rest[0] ?? ".");

  try {
    switch (command) {
      case "scan":
        return await runScan(io, root, format, values.strict ?? false);
      case "init":
        return await runInit(io, root, values.write ?? false);
      case "doctor":
        return await runDoctorCommand(io, root, format);
    }
  } catch (error) {
    if (error instanceof ScanError || error instanceof DiscoveryError || error instanceof InitError) {
      io.stderr(`envsync: ${error.message}\n`);
      return EXIT_USAGE;
    }
    io.stderr(`envsync: Unexpected internal error (${error instanceof Error ? error.name : "unknown"}). Please report this issue.\n`);
    return EXIT_USAGE;
  }
}

async function runScan(io: CliIO, root: string, format: Format, strict: boolean): Promise<number> {
  const result = await scanProject({ root, framework: nextFramework });
  const counts = countBySeverity(result.diagnostics);
  const exitCode = exitCodeFor(counts, strict);
  io.stdout(format === "json" ? formatJson(result, counts, strict, exitCode) : formatTerminal(result, counts, strict, exitCode));
  return exitCode;
}

async function runInit(io: CliIO, root: string, write: boolean): Promise<number> {
  const plan = await planInit({ root, framework: nextFramework });
  const written = write ? await applyInitPlan(root, plan) : null;
  io.stdout(formatInitPlan(plan, written));
  return EXIT_OK;
}

async function runDoctorCommand(io: CliIO, root: string, format: Format): Promise<number> {
  const checks = [nodeVersionCheck(io.nodeVersion ?? process.versions.node), ...(await runDoctor({ root, framework: nextFramework }))];
  const counts = countChecks(checks);
  const exitCode = counts.fail > 0 ? EXIT_FINDINGS : EXIT_OK;
  io.stdout(format === "json" ? formatDoctorJson(checks, counts, exitCode) : formatDoctorTerminal(checks, counts));
  return exitCode;
}

function nodeVersionCheck(version: string): DoctorCheck {
  return compareVersions(version, MINIMUM_NODE_VERSION) >= 0
    ? { id: "node-version", status: "pass", message: `Node.js ${version} meets the requirement (>= ${MINIMUM_NODE_VERSION}).` }
    : {
        id: "node-version",
        status: "fail",
        message: `Node.js ${version} is older than the required ${MINIMUM_NODE_VERSION}.`,
        suggestion: `Install Node.js ${MINIMUM_NODE_VERSION} or newer (an LTS release is recommended).`,
      };
}

export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => version.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`envsync: ${message}\nRun \`envsync --help\` for usage.\n`);
  return EXIT_USAGE;
}

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMAND_OPTIONS, value);
}

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}
