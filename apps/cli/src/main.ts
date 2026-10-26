import path from "node:path";
import { parseArgs } from "node:util";
import {
  applyInitPlan,
  countBySeverity,
  DiscoveryError,
  ENV_CONTEXTS,
  InitError,
  isEnvContext,
  planInit,
  runDoctor,
  scanProject,
  ScanError,
  type DoctorCheck,
  type EnvContext,
} from "@envsync-internal/core";
import { nextFramework } from "@envsync-internal/parser-next";
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE, exitCodeFor } from "./exit-codes.js";
import { countChecks, formatDoctorJson, formatDoctorTerminal } from "./formatters/doctor.js";
import { formatInitPlan } from "./formatters/init.js";
import { formatJson } from "./formatters/json.js";
import { sanitizeForOutput } from "./formatters/sanitize.js";
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
  /** Whether output may end up in CI logs. Overridable for tests; defaults to the `CI` environment variable. */
  ci?: boolean;
};

const FORMATS = ["terminal", "json"] as const;
type Format = (typeof FORMATS)[number];

const COMMAND_OPTIONS = {
  scan: ["format", "strict", "env", "no-env-files", "show-values"],
  init: ["write"],
  doctor: ["format", "strict"],
} as const;
type Command = keyof typeof COMMAND_OPTIONS;

const HELP = `EnvSync - keep environment configuration in sync with your code.

Usage:
  envsync scan [directory] [--format terminal|json] [--strict] [--env <context>]
               [--no-env-files] [--show-values]
  envsync init [directory] [--write]
  envsync doctor [directory] [--format terminal|json] [--strict]

Commands:
  scan     Compare process.env references, envsync.config.ts, .env.example and
           every runtime .env file in the project (.env, .env.local, .env.production,
           ... at any depth), including their values.
  init     Preview a starter envsync.config.ts and .env.example placeholders.
           Nothing is written unless you pass --write, which plans again and
           applies that plan. Existing files are never overwritten;
           .env.example only gains appended placeholder lines.
  doctor   Check the local setup: config, .env.example, package.json, and
           whether local .env files are ignored by git and not already tracked.
           Results that cannot be established are reported as "unknown".

Options:
  --format   Output format for scan and doctor: terminal (default) or json.
  --strict   scan: warnings and incomplete scans fail.
             doctor: warnings and unknown results fail.
  --env      scan: environment whose env files decide missing values (ENV008):
             development (default), preview, production or test.
  --no-env-files  scan: do not open runtime .env files.
  --show-values   scan: show the offending value of a malformed, non-secret variable
                  (ENV010). Credentials and secret values are always redacted.
                  Ignored when the CI environment variable is set.
  --write    init: apply the planned changes.
  -h, --help     Show this help.
  -v, --version  Show the version.

Exit codes:
  0  Success. scan: no errors (with --strict: no warnings, and every file scanned).
     doctor: no failed checks (with --strict: no warnings or unknown results).
  1  scan found errors (or, with --strict, warnings or skipped files); doctor found a
     failed check (or, with --strict, a warning or unknown result).
  2  Usage error, or the command could not run (for example, missing envsync.config.ts
     for scan; for init --write, a file that changed between planning and writing, a
     blocked change, or a failed write).

scan reads runtime .env files and checks their values in memory; it prints no values unless
--show-values is passed, and never prints credentials or secret values. init and doctor
never open .env files (doctor checks only their names).
EnvSync never executes project code and makes no network requests.
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
        env: { type: "string" },
        "no-env-files": { type: "boolean" },
        "show-values": { type: "boolean" },
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
  for (const option of ["format", "strict", "write", "env", "no-env-files", "show-values"] as const) {
    if (values[option] !== undefined && !allowed.includes(option)) {
      return usageError(io, `\`--${option}\` is not an option of \`${command}\`.`);
    }
  }

  const format = values.format ?? "terminal";
  if (!isFormat(format)) return usageError(io, `Unknown format \`${format}\`. Use one of: ${FORMATS.join(", ")}.`);
  const envContext = values.env ?? "development";
  if (!isEnvContext(envContext)) return usageError(io, `Unknown environment \`${envContext}\`. Use one of: ${ENV_CONTEXTS.join(", ")}.`);
  const root = path.resolve(io.cwd, rest[0] ?? ".");

  try {
    switch (command) {
      case "scan": {
        let includeValues = values["show-values"] ?? false;
        if (includeValues && (io.ci ?? isCiEnvironment())) {
          // CI logs are long-lived and widely readable (ADR-016).
          io.stderr("envsync: --show-values is ignored because this looks like a CI environment; values are not printed in CI.\n");
          includeValues = false;
        }
        return await runScan(io, root, format, values.strict ?? false, {
          readEnvFiles: !(values["no-env-files"] ?? false),
          includeValues,
          envContext,
        });
      }
      case "init":
        return await runInit(io, root, values.write ?? false);
      case "doctor":
        return await runDoctorCommand(io, root, format, values.strict ?? false);
    }
  } catch (error) {
    if (error instanceof ScanError || error instanceof DiscoveryError || error instanceof InitError) {
      printError(io, error.message);
      return EXIT_USAGE;
    }
    printError(io, `Unexpected internal error (${error instanceof Error ? error.name : "unknown"}). Please report this issue.`);
    return EXIT_USAGE;
  }
}

async function runScan(
  io: CliIO,
  root: string,
  format: Format,
  strict: boolean,
  envOptions: { readEnvFiles: boolean; includeValues: boolean; envContext: EnvContext },
): Promise<number> {
  const result = await scanProject({ root, framework: nextFramework, ...envOptions });
  const counts = countBySeverity(result.diagnostics);
  const exitCode = exitCodeFor(counts, strict, result.complete);
  io.stdout(format === "json" ? formatJson(result, counts, strict, exitCode) : formatTerminal(result, counts, strict, exitCode));
  return exitCode;
}

async function runInit(io: CliIO, root: string, write: boolean): Promise<number> {
  const plan = await planInit({ root, framework: nextFramework });
  const written = write ? await applyInitPlan(root, plan) : null;
  io.stdout(formatInitPlan(plan, written));
  return EXIT_OK;
}

async function runDoctorCommand(io: CliIO, root: string, format: Format, strict: boolean): Promise<number> {
  const checks = [nodeVersionCheck(io.nodeVersion ?? process.versions.node), ...(await runDoctor({ root, framework: nextFramework }))];
  const counts = countChecks(checks);
  const exitCode = counts.fail > 0 || (strict && counts.warn + counts.unknown > 0) ? EXIT_FINDINGS : EXIT_OK;
  io.stdout(format === "json" ? formatDoctorJson(checks, counts, strict, exitCode) : formatDoctorTerminal(checks, counts, strict));
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
  printError(io, message);
  io.stderr("Run `envsync --help` for usage.\n");
  return EXIT_USAGE;
}

/** Error text can contain argv, paths and directory names, so it is sanitized like stdout. */
function printError(io: CliIO, message: string): void {
  io.stderr(`${sanitizeForOutput(`envsync: ${message}`)}\n`);
}

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMAND_OPTIONS, value);
}

// Providers that do not always set CI. Their presence alone means output may end up in a build log.
const CI_PROVIDER_VARIABLES = ["GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "TF_BUILD", "JENKINS_URL", "CODEBUILD_BUILD_ID", "TEAMCITY_VERSION", "CIRCLECI", "BITBUCKET_BUILD_NUMBER"];

/** `CI` set to anything but an empty string, "0" or "false", or a known CI provider's variable. */
function isCiEnvironment(): boolean {
  const value = process.env.CI;
  if (value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false") return true;
  return CI_PROVIDER_VARIABLES.some((name) => (process.env[name] ?? "") !== "");
}

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}
