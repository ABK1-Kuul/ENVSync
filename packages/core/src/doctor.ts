import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { parseEnvExample } from "@envsync-internal/schema";
import { discoverSourceFiles, DiscoveryError, MAX_DISCOVERY_ENTRIES } from "./discovery.js";
import type { FrameworkAdapter } from "./framework.js";
import { explainIgnoreStatus, explainTrackedFile, loadIgnoreContext } from "./gitignore.js";
import { CONFIG_FILE_NAME, DEFAULT_SCAN_LIMITS, ENV_EXAMPLE_FILE_NAME, readProjectFile, ScanError } from "./project-files.js";
import { parseConfigSafely } from "./scan.js";

/**
 * `envsync doctor`: local setup checks. Read-only, never runs package scripts or other project
 * code, never runs git, and never reads the contents of `.env`/`.env.*` files (only their names).
 */

/**
 * `unknown`: the check could not be established (unreadable or unsupported metadata, limits hit).
 * It is never a pass; `doctor --strict` fails on it, like on `warn`.
 */
export type DoctorStatus = "pass" | "warn" | "fail" | "unknown" | "skip";

/** `id` values are stable for JSON consumers. */
export type DoctorCheck = { id: string; status: DoctorStatus; message: string; suggestion?: string };

const EXAMPLE_LIKE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

export type DoctorOptions = {
  root: string;
  framework: FrameworkAdapter;
  /** Stops the search for an enclosing git repository at this directory (used by tests). */
  gitSearchCeiling?: string;
};

export async function runDoctor({ root, framework, gitSearchCeiling }: DoctorOptions): Promise<DoctorCheck[]> {
  const absoluteRoot = path.resolve(root);
  const checks: DoctorCheck[] = [];

  try {
    const discovery = await discoverSourceFiles(absoluteRoot);
    // Same count as `scan`, which never treats the EnvSync config as application source.
    const count = discovery.files.filter((file) => file !== CONFIG_FILE_NAME).length;
    const limitHit = discovery.skipped.some((entry) => entry.reason === "limit-reached") || count > DEFAULT_SCAN_LIMITS.maxFiles;
    const symlinks = discovery.skipped.filter((entry) => entry.reason === "symlink").length;
    const unreadable = discovery.skipped.filter((entry) => entry.reason === "unreadable").length;
    const skippedParts = [
      ...(symlinks > 0 ? [`${symlinks} symlinked ${symlinks === 1 ? "path" : "paths"}`] : []),
      ...(unreadable > 0 ? [`${unreadable} unreadable ${unreadable === 1 ? "directory" : "directories"}`] : []),
    ];
    const files = `${count} source ${count === 1 ? "file" : "files"}`;
    if (limitHit) {
      checks.push({
        id: "source-files",
        status: "unknown",
        message: `The project is larger than EnvSync's scan limits (${DEFAULT_SCAN_LIMITS.maxFiles} source files, ${MAX_DISCOVERY_ENTRIES} directory entries), so \`envsync scan\` will stop early and its results will be incomplete.`,
        suggestion: "Run EnvSync on each app directory separately.",
      });
    } else if (count === 0) {
      checks.push({
        id: "source-files",
        status: "warn",
        message: `No source files found in ${absoluteRoot}.`,
        suggestion: "Run EnvSync from your Next.js app directory.",
      });
    } else if (skippedParts.length > 0) {
      checks.push({
        id: "source-files",
        status: "warn",
        message: `Found ${files} to scan, but ${skippedParts.join(" and ")} will not be scanned, so \`envsync scan\` will report an incomplete scan.`,
        suggestion: "Run `envsync scan` to list them; symbolic links are never followed.",
      });
    } else {
      checks.push({ id: "source-files", status: "pass", message: `Found ${files} to scan.` });
    }
  } catch (error) {
    if (!(error instanceof DiscoveryError)) throw error;
    checks.push({ id: "source-files", status: "fail", message: error.message });
    return checks;
  }

  checks.push(...(await checkPackageJson(absoluteRoot, framework)));
  checks.push(await checkConfig(absoluteRoot));
  checks.push(await checkEnvExample(absoluteRoot));
  checks.push(await checkLocalEnvFiles(absoluteRoot, gitSearchCeiling));
  return checks;
}

async function checkPackageJson(root: string, framework: FrameworkAdapter): Promise<DoctorCheck[]> {
  let text: string | null;
  try {
    text = await readProjectFile(root, "package.json");
  } catch (error) {
    if (!(error instanceof ScanError)) throw error;
    return [{ id: "package-json", status: "fail", message: error.message }];
  }
  if (text === null) {
    return [
      {
        id: "package-json",
        status: "warn",
        message: "No package.json found, so this may not be the project root.",
        suggestion: "Run EnvSync from the directory that contains your Next.js app's package.json.",
      },
    ];
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [{ id: "package-json", status: "fail", message: "package.json is not valid JSON.", suggestion: "Fix the JSON syntax in package.json." }];
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return [{ id: "package-json", status: "fail", message: "package.json does not contain a JSON object.", suggestion: "Fix package.json." }];
  }

  const checks: DoctorCheck[] = [{ id: "package-json", status: "pass", message: "package.json is present and valid JSON." }];
  // Only presence is reported; version ranges can be URLs that embed credentials.
  const declared = ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
    const deps = (manifest as Record<string, unknown>)[field];
    return typeof deps === "object" && deps !== null && framework.packageName in deps;
  });
  const workspaceRoot = "workspaces" in manifest || (await exists(path.join(root, "pnpm-workspace.yaml")));

  if (declared) {
    checks.push({ id: "framework", status: "pass", message: `${framework.name} (\`${framework.packageName}\`) is a dependency in package.json.` });
  } else if (workspaceRoot) {
    checks.push({
      id: "framework",
      status: "warn",
      message: `This looks like a monorepo/workspace root and \`${framework.packageName}\` is not a dependency here.`,
      suggestion: `Run EnvSync inside each ${framework.name} app directory (for example apps/web).`,
    });
  } else {
    checks.push({
      id: "framework",
      status: "warn",
      message: `\`${framework.packageName}\` is not a dependency in package.json. EnvSync's analysis is designed for ${framework.name} projects.`,
      suggestion: `Run EnvSync from a ${framework.name} project, or expect framework-specific checks to be less accurate.`,
    });
  }
  return checks;
}

async function checkConfig(root: string): Promise<DoctorCheck> {
  let text: string | null;
  try {
    text = await readProjectFile(root, CONFIG_FILE_NAME);
  } catch (error) {
    if (!(error instanceof ScanError)) throw error;
    return { id: "config", status: "fail", message: error.message };
  }
  if (text === null) {
    return {
      id: "config",
      status: "fail",
      message: `No ${CONFIG_FILE_NAME} found, so \`envsync scan\` cannot run.`,
      suggestion: "Run `envsync init` to preview a starter config.",
    };
  }
  const config = parseConfigSafely(text);
  if (config.issues.length > 0) {
    return {
      id: "config",
      status: "fail",
      message: `${CONFIG_FILE_NAME} has ${config.issues.length} ${config.issues.length === 1 ? "problem" : "problems"}.`,
      suggestion: "Run `envsync scan` to see each problem with its location.",
    };
  }
  const count = config.variables.length;
  return { id: "config", status: "pass", message: `${CONFIG_FILE_NAME} declares ${count} ${count === 1 ? "variable" : "variables"}.` };
}

async function checkEnvExample(root: string): Promise<DoctorCheck> {
  let text: string | null;
  try {
    text = await readProjectFile(root, ENV_EXAMPLE_FILE_NAME);
  } catch (error) {
    if (!(error instanceof ScanError)) throw error;
    return { id: "env-example", status: "fail", message: error.message };
  }
  if (text === null) {
    return {
      id: "env-example",
      status: "warn",
      message: `No ${ENV_EXAMPLE_FILE_NAME} found, so new contributors cannot see which variables to set.`,
      suggestion: "Run `envsync init` to preview one with empty placeholders.",
    };
  }
  const parsed = parseEnvExample(text);
  if (parsed.invalidLines.length > 0) {
    const lines = parsed.invalidLines.slice(0, 10).join(", ") + (parsed.invalidLines.length > 10 ? ", ..." : "");
    return {
      id: "env-example",
      status: "warn",
      message: `${ENV_EXAMPLE_FILE_NAME} has lines that are not KEY=value entries and are ignored (line ${lines}).`,
      suggestion: "Rewrite them as `NAME=` placeholders or turn them into `#` comments.",
    };
  }
  const count = parsed.entries.length;
  return { id: "env-example", status: "pass", message: `${ENV_EXAMPLE_FILE_NAME} lists ${count} ${count === 1 ? "variable" : "variables"}.` };
}

async function checkLocalEnvFiles(root: string, ceiling: string | undefined): Promise<DoctorCheck> {
  // Names only: the contents of these files are never opened.
  const present = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.isDirectory() && isLocalEnvFileName(entry.name))
    .map((entry) => entry.name)
    .sort();

  const context = await loadIgnoreContext(root, ceiling === undefined ? {} : { ceiling });
  // "Not in a repository" is only reported when EnvSync is sure: a `.git` it could not verify on the
  // way up means the project may be inside a repository, which the checks below report as unknown.
  if (context.repositoryRoot === null && context.problems.length === 0) {
    return {
      id: "env-files-ignored",
      status: "skip",
      message: "Not inside a git repository, so the git checks were skipped.",
    };
  }

  // Next.js treats `.env*.local` as machine-local secrets; matching is case-insensitive because
  // Windows and macOS file systems are.
  const isLocal = (name: string) => name.toLowerCase().endsWith(".local");
  const list = (names: readonly string[]) => names.join(", ");
  const verb = (names: readonly string[], one: string, many: string) => (names.length === 1 ? one : many);

  // Every file gets an explicit verdict for both questions; `undefined`/"unknown" means "could not
  // be established" and is never treated as safe.
  const unknownReasons = new Set<string>();
  const facts = present.map((name) => {
    const ignore = explainIgnoreStatus(context, root, name);
    for (const reason of ignore.reasons) unknownReasons.add(reason);
    // Every undetermined tracking answer carries its own reason, so it can never fall through to a pass.
    const { tracked, reason } = explainTrackedFile(context, root, name);
    if (tracked === undefined) unknownReasons.add(reason);
    return { name, local: isLocal(name), tracked, ignore: ignore.status };
  });

  // 1. An ignore rule does not untrack a committed file, so tracking is checked first.
  const trackedLocal = facts.filter((fact) => fact.local && fact.tracked === true).map((fact) => fact.name);
  if (trackedLocal.length > 0) {
    return {
      id: "env-files-ignored",
      status: "fail",
      message: `${list(trackedLocal)} ${verb(trackedLocal, "is", "are")} tracked by git, so changes to ${verb(trackedLocal, "it", "them")} will be committed even if .gitignore lists ${verb(trackedLocal, "it", "them")}.`,
      suggestion:
        "Run `git rm --cached <file>` and commit, keep `.env*.local` in .gitignore, and rotate any secret that was ever committed.",
    };
  }

  // 2. Definitely not ignored: committable regardless of anything else we could not verify.
  const exposedLocal = facts.filter((fact) => fact.local && fact.ignore === "not-ignored").map((fact) => fact.name);
  if (exposedLocal.length > 0) {
    return {
      id: "env-files-ignored",
      status: "fail",
      message: `${list(exposedLocal)} ${verb(exposedLocal, "is", "are")} not ignored by git, so local secrets could be committed.`,
      suggestion: "Add `.env*.local` to .gitignore.",
    };
  }

  // Warnings below still mention anything that could not be verified, so it is never hidden.
  const alsoUnverified = () => (unknownReasons.size > 0 ? ` Also could not verify: ${[...unknownReasons].join("; ")}.` : "");

  const sharedExposed = facts.filter((fact) => !fact.local && (fact.tracked === true || fact.ignore === "not-ignored")).map((fact) => fact.name);
  if (sharedExposed.length > 0) {
    return {
      id: "env-files-ignored",
      status: "warn",
      message: `${list(sharedExposed)} ${verb(sharedExposed, "is", "are")} committed or not ignored by git. Next.js allows committing these for non-secret defaults only.${alsoUnverified()}`,
      suggestion: "Make sure they contain no secrets, or add them to .gitignore.",
    };
  }

  const probe = explainIgnoreStatus(context, root, ".env.local");
  if (probe.status === "not-ignored") {
    return {
      id: "env-files-ignored",
      status: "warn",
      message: `.env.local would not be ignored by git if you created it.${alsoUnverified()}`,
      suggestion: "Add `.env*.local` to .gitignore before creating local env files.",
    };
  }
  for (const reason of probe.reasons) unknownReasons.add(reason);

  // 3. Anything not established is reported as unknown, never as a pass.
  if (unknownReasons.size > 0) {
    const subject = present.length > 0 ? list(present) : ".env.local";
    return {
      id: "env-files-ignored",
      status: "unknown",
      message: `Could not verify that ${subject} ${present.length > 1 ? "are" : "is"} ignored and untracked by git: ${[...unknownReasons].join("; ")}.`,
      suggestion: "Check with `git check-ignore -v <file>` and `git ls-files <file>`.",
    };
  }

  return {
    id: "env-files-ignored",
    status: "pass",
    message:
      present.length > 0
        ? `Local env files are ignored by git and not tracked (${list(present)}). Their contents were not read.`
        : "No local env files found, and .env.local would be ignored by git.",
  };
}

function isLocalEnvFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower !== ".env" && !lower.startsWith(".env.")) return false;
  return !EXAMPLE_LIKE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}
