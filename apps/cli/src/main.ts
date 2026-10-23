import path from "node:path";
import { parseArgs } from "node:util";
import { countBySeverity, DiscoveryError, scanProject, ScanError } from "@envsync/core";
import { nextFramework } from "@envsync/parser-next";
import { EXIT_USAGE, exitCodeFor } from "./exit-codes.js";
import { formatJson } from "./formatters/json.js";
import { formatTerminal } from "./formatters/terminal.js";

export const VERSION = "0.0.0";

export type CliIO = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
};

const FORMATS = ["terminal", "json"] as const;
type Format = (typeof FORMATS)[number];

const HELP = `EnvSync - keep environment configuration in sync with your code.

Usage:
  envsync scan [directory] [--format terminal|json] [--strict]

Commands:
  scan       Compare process.env references, envsync.config.ts and .env.example.

Options:
  --format   Output format: terminal (default) or json.
  --strict   Treat warnings as failures.
  -h, --help     Show this help.
  -v, --version  Show the version.

Exit codes:
  0  No errors (and, with --strict, no warnings).
  1  Errors found, or warnings found with --strict.
  2  Usage error, or the scan could not run (for example, missing envsync.config.ts).

EnvSync never prints environment-variable values, never reads .env files,
never executes project code and makes no network requests during a scan.
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
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    io.stdout(HELP);
    return 0;
  }

  if (command !== "scan") {
    const hint = command === "init" || command === "doctor" ? ` \`${command}\` is planned but not available yet.` : "";
    return usageError(io, `Unknown command \`${command}\`.${hint}`);
  }
  if (rest.length > 1) return usageError(io, "`scan` accepts at most one directory.");

  const format = values.format ?? "terminal";
  if (!isFormat(format)) return usageError(io, `Unknown format \`${format}\`. Use one of: ${FORMATS.join(", ")}.`);
  const strict = values.strict ?? false;

  try {
    const root = path.resolve(io.cwd, rest[0] ?? ".");
    const result = await scanProject({ root, framework: nextFramework });
    const counts = countBySeverity(result.diagnostics);
    const exitCode = exitCodeFor(counts, strict);
    io.stdout(format === "json" ? formatJson(result, counts, strict, exitCode) : formatTerminal(result, counts, strict, exitCode));
    return exitCode;
  } catch (error) {
    if (error instanceof ScanError || error instanceof DiscoveryError) {
      io.stderr(`envsync: ${error.message}\n`);
      return EXIT_USAGE;
    }
    io.stderr(`envsync: Unexpected internal error (${error instanceof Error ? error.name : "unknown"}). Please report this issue.\n`);
    return EXIT_USAGE;
  }
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`envsync: ${message}\nRun \`envsync --help\` for usage.\n`);
  return EXIT_USAGE;
}

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}
