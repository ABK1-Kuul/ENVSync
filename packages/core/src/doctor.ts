import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { parseEnvExample } from "@envsync-internal/schema";
import { discoverSourceFiles, DiscoveryError } from "./discovery.js";
import type { FrameworkAdapter } from "./framework.js";
import { isIgnoredFile, loadIgnoreContext } from "./gitignore.js";
import { CONFIG_FILE_NAME, ENV_EXAMPLE_FILE_NAME, readProjectFile, ScanError } from "./project-files.js";
import { parseConfigSafely } from "./scan.js";

/**
 * `envsync doctor`: local setup checks. Read-only, never runs package scripts or other project
 * code, never runs git, and never reads the contents of `.env`/`.env.*` files (only their names).
 */

export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

/** `id` values are stable for JSON consumers. */
export type DoctorCheck = { id: string; status: DoctorStatus; message: string; suggestion?: string };

const EXAMPLE_LIKE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

export async function runDoctor({ root, framework }: { root: string; framework: FrameworkAdapter }): Promise<DoctorCheck[]> {
  const absoluteRoot = path.resolve(root);
  const checks: DoctorCheck[] = [];

  try {
    const discovery = await discoverSourceFiles(absoluteRoot);
    // Same count as `scan`, which never treats the EnvSync config as application source.
    const count = discovery.files.filter((file) => file !== CONFIG_FILE_NAME).length;
    const skippedNote = discovery.skipped.length > 0 ? ` ${discovery.skipped.length} symlinked or unreadable path(s) will be skipped.` : "";
    checks.push(
      count === 0
        ? {
            id: "source-files",
            status: "warn",
            message: `No source files found in ${absoluteRoot}.${skippedNote}`,
            suggestion: "Run EnvSync from your Next.js app directory.",
          }
        : { id: "source-files", status: "pass", message: `Found ${count} source ${count === 1 ? "file" : "files"} to scan.${skippedNote}` },
    );
  } catch (error) {
    if (!(error instanceof DiscoveryError)) throw error;
    checks.push({ id: "source-files", status: "fail", message: error.message });
    return checks;
  }

  checks.push(...(await checkPackageJson(absoluteRoot, framework)));
  checks.push(await checkConfig(absoluteRoot));
  checks.push(await checkEnvExample(absoluteRoot));
  checks.push(await checkLocalEnvFiles(absoluteRoot));
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

async function checkLocalEnvFiles(root: string): Promise<DoctorCheck> {
  // Names only: the contents of these files are never opened.
  const present = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.isDirectory() && isLocalEnvFileName(entry.name))
    .map((entry) => entry.name)
    .sort();

  const context = await loadIgnoreContext(root);
  if (context.repositoryRoot === null) {
    return {
      id: "env-files-ignored",
      status: "skip",
      message: "Not inside a git repository, so the .gitignore check was skipped.",
    };
  }

  const exposedLocal = present.filter((name) => name.endsWith(".local") && !isIgnoredFile(context, root, name));
  if (exposedLocal.length > 0) {
    return {
      id: "env-files-ignored",
      status: "fail",
      message: `${exposedLocal.join(", ")} ${exposedLocal.length === 1 ? "is" : "are"} not ignored by git, so local secrets could be committed.`,
      suggestion: "Add `.env*.local` to .gitignore. If already committed, remove it from git history and rotate the secrets it contains.",
    };
  }

  const exposedShared = present.filter((name) => !name.endsWith(".local") && !isIgnoredFile(context, root, name));
  if (exposedShared.length > 0) {
    return {
      id: "env-files-ignored",
      status: "warn",
      message: `${exposedShared.join(", ")} ${exposedShared.length === 1 ? "is" : "are"} not ignored by git. Next.js allows committing these for non-secret defaults only.`,
      suggestion: "Make sure they contain no secrets, or add them to .gitignore.",
    };
  }

  if (!isIgnoredFile(context, root, ".env.local")) {
    return {
      id: "env-files-ignored",
      status: "warn",
      message: ".env.local would not be ignored by git if you created it.",
      suggestion: "Add `.env*.local` to .gitignore before creating local env files.",
    };
  }

  return {
    id: "env-files-ignored",
    status: "pass",
    message:
      present.length > 0
        ? `Local env files are ignored by git (${present.join(", ")}). Their contents were not read.`
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
