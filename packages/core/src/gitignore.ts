import { lstat } from "node:fs/promises";
import path from "node:path";
import { readTrackedPaths, type TrackedPaths } from "./git-index.js";
import { readProjectFile, ScanError } from "./project-files.js";
import { compileWildmatch, wildmatch, type CompiledPattern } from "./wildmatch.js";

/**
 * Read-only `.gitignore` evaluation for `doctor`, so it never has to run git.
 *
 * Follows git's rules: lines split on LF (one trailing CR dropped), only unescaped trailing ASCII
 * spaces trimmed, `#` comments, `!` negation, `\` escapes, trailing `/` for directories, patterns
 * containing `/` anchored to their file's directory, wildmatch globbing (see wildmatch.ts),
 * `core.ignorecase` from `.git/config`, `.git/info/exclude` at the lowest precedence, deeper
 * `.gitignore` files over shallower ones, and no re-inclusion inside an ignored directory.
 * Not covered (documented): the global excludes file (`core.excludesFile`).
 */

type Rule = { negated: boolean; directoryOnly: boolean; anchored: boolean; pattern: CompiledPattern };

/** Rules from one ignore file; they apply to paths inside `base`. */
type RuleSet = { base: string; rules: Rule[] };

export type IgnoreContext = {
  /** Absolute path of the repository root, or `null` if the project is not in a git repository. */
  repositoryRoot: string | null;
  ignoreCase: boolean;
  /** Lowest precedence first: `.git/info/exclude`, then `.gitignore` files from outermost to innermost. */
  ruleSets: RuleSet[];
  /** True when an ignore file exceeded the rule or pattern limits and some rules were skipped. */
  truncated: boolean;
  tracked: TrackedPaths;
};

export type IgnoreContextOptions = {
  /** Directory above which the repository search stops (like GIT_CEILING_DIRECTORIES). */
  ceiling?: string;
};

const MAX_PARENT_LEVELS = 64;
export const MAX_RULES_PER_FILE = 10_000;
export const MAX_PATTERN_LENGTH = 4_096;

export async function loadIgnoreContext(projectRoot: string, options: IgnoreContextOptions = {}): Promise<IgnoreContext> {
  const ceiling = options.ceiling === undefined ? undefined : path.resolve(options.ceiling);
  const chain: string[] = [];
  let repositoryRoot: string | null = null;

  for (let directory = path.resolve(projectRoot), level = 0; level < MAX_PARENT_LEVELS; level++) {
    chain.push(directory);
    if (await exists(path.join(directory, ".git"))) {
      repositoryRoot = directory;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory || directory === ceiling) break;
    directory = parent;
  }
  if (repositoryRoot === null) {
    return { repositoryRoot, ignoreCase: false, ruleSets: [], truncated: false, tracked: { status: "ok", paths: new Set() } };
  }

  // `.git` may be a file (linked worktree, submodule); then config, exclude and index live elsewhere.
  const gitDirectory = path.join(repositoryRoot, ".git");
  const gitIsDirectory = await isDirectory(gitDirectory);
  const config = gitIsDirectory ? parseGitConfig((await readOptional(gitDirectory, "config")) ?? "") : { ignoreCase: false, sha256: false };

  const ruleSets: RuleSet[] = [];
  let truncated = false;
  const addRules = (base: string, text: string | null) => {
    if (text === null) return;
    const parsed = parseIgnoreRules(text, config.ignoreCase);
    truncated ||= parsed.truncated;
    ruleSets.push({ base, rules: parsed.rules });
  };
  if (gitIsDirectory) addRules(repositoryRoot, await readOptional(path.join(gitDirectory, "info"), "exclude"));
  for (const directory of chain.reverse()) addRules(directory, await readOptional(directory, ".gitignore"));

  const tracked: TrackedPaths = gitIsDirectory
    ? await readTrackedPaths(gitDirectory, config.sha256 ? 32 : 20)
    : { status: "unavailable", reason: "this is a linked worktree or submodule, whose index was not read" };

  return { repositoryRoot, ignoreCase: config.ignoreCase, ruleSets, truncated, tracked };
}

/** Whether `fileName`, directly inside `projectRoot`, would be ignored by git (if untracked). */
export function isIgnoredFile(context: IgnoreContext, projectRoot: string, fileName: string): boolean {
  if (context.repositoryRoot === null) return false;
  const root = path.resolve(projectRoot);

  // Git does not look inside an ignored directory, so an ignored ancestor ignores the file.
  for (let directory = root; directory !== context.repositoryRoot; directory = path.dirname(directory)) {
    if (decide(context, directory, true)) return true;
    if (path.dirname(directory) === directory) break;
  }
  return decide(context, path.join(root, fileName), false);
}

/** `true`/`false` when the index was read; `undefined` when tracking status is unknown. */
export function isTrackedFile(context: IgnoreContext, projectRoot: string, fileName: string): boolean | undefined {
  if (context.repositoryRoot === null) return false;
  if (context.tracked.status !== "ok") return undefined;
  const relative = path.relative(context.repositoryRoot, path.join(path.resolve(projectRoot), fileName)).split(path.sep).join("/");
  if (!context.ignoreCase) return context.tracked.paths.has(relative);
  const folded = relative.toLowerCase();
  for (const tracked of context.tracked.paths) if (tracked.toLowerCase() === folded) return true;
  return false;
}

/** The last matching rule wins across all applicable rulesets, in precedence order. */
function decide(context: IgnoreContext, target: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const { base, rules } of context.ruleSets) {
    const relative = path.relative(base, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const relativePath = relative.split(path.sep).join("/");
    const baseName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (wildmatch(rule.pattern, rule.anchored ? relativePath : baseName)) ignored = !rule.negated;
    }
  }
  return ignored;
}

export function parseIgnoreRules(text: string, ignoreCase = false): { rules: Rule[]; truncated: boolean } {
  const rules: Rule[] = [];
  let truncated = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // git skips a UTF-8 BOM

  for (const rawLine of body.split("\n")) {
    let line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    line = trimTrailingSpaces(line);
    if (line === "" || line.startsWith("#")) continue;
    if (rules.length >= MAX_RULES_PER_FILE || line.length > MAX_PATTERN_LENGTH) {
      truncated = true;
      continue;
    }

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    const directoryOnly = line.endsWith("/") && !line.endsWith("\\/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (line === "") continue;
    rules.push({ negated, directoryOnly, anchored, pattern: compileWildmatch(line, ignoreCase) });
  }
  return { rules, truncated };
}

/** Git trims trailing ASCII spaces only, and keeps a space escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let trailingSpaceStart = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === " ") {
      if (trailingSpaceStart === -1) trailingSpaceStart = i;
    } else {
      trailingSpaceStart = -1;
      if (char === "\\") i++; // the escaped character, even a space, is kept
    }
  }
  return trailingSpaceStart === -1 ? line : line.slice(0, trailingSpaceStart);
}

/** Minimal `.git/config` reader for the two settings `doctor` needs. */
export function parseGitConfig(text: string): { ignoreCase: boolean; sha256: boolean } {
  let section = "";
  let ignoreCase = false;
  let sha256 = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (header) {
      section = (header[1] as string).toLowerCase();
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!entry) continue;
    const key = (entry[1] as string).toLowerCase();
    const value = (entry[2] ?? "true").replace(/\s*[#;].*$/, "").trim().toLowerCase();
    if (section === "core" && key === "ignorecase") ignoreCase = ["true", "yes", "on", "1"].includes(value);
    if (section === "extensions" && key === "objectformat") sha256 = value === "sha256";
  }
  return { ignoreCase, sha256 };
}

async function readOptional(directory: string, fileName: string): Promise<string | null> {
  try {
    return await readProjectFile(directory, fileName);
  } catch (error) {
    if (error instanceof ScanError) return null; // symlinked, oversized or unreadable: treat as absent
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory();
  } catch {
    return false;
  }
}
