import { lstat } from "node:fs/promises";
import path from "node:path";
import { readTrackedPaths, type TrackedPaths } from "./git-index.js";
import { readRegularFile } from "./project-files.js";
import { compileWildmatch, wildmatch, type CompiledPattern } from "./wildmatch.js";

/**
 * Read-only `.gitignore` evaluation for `doctor`, so it never has to run git.
 *
 * Follows git's rules: lines split on LF (one trailing CR dropped), only unescaped trailing ASCII
 * spaces trimmed, `#` comments, `!` negation, `\` escapes, trailing `/` for directories, patterns
 * containing `/` anchored to their file's directory, wildmatch globbing on bytes (see wildmatch.ts),
 * `core.ignorecase` (ASCII-only folding) from `.git/config`, `.git/info/exclude` at the lowest
 * precedence, deeper `.gitignore` files over shallower ones, and no re-inclusion inside an ignored
 * directory. Known deviations are documented in docs/CLI.md.
 *
 * Uncertainty is explicit: if any rules that could apply were not fully read (missing permissions,
 * size or rule limits, unreadable repository metadata), the answer is "unknown", never a guess.
 */

type Rule = { negated: boolean; directoryOnly: boolean; anchored: boolean; pattern: CompiledPattern };

/** Rules from one ignore file; they apply to paths inside `base`. */
type RuleSet = {
  base: string;
  rules: Rule[];
  /** Why some rules from this file were not evaluated; empty when all were. */
  problems: string[];
};

export type IgnoreStatus = "ignored" | "not-ignored" | "unknown";

export type IgnoreContext = {
  /** Absolute path of the repository root, or `null` if the project is not in a git repository. */
  repositoryRoot: string | null;
  ignoreCase: boolean;
  /** Lowest precedence first: `.git/info/exclude`, then `.gitignore` files from outermost to innermost. */
  ruleSets: RuleSet[];
  /** Problems that make every ignore decision uncertain (e.g. unreadable `.git/config`). */
  problems: string[];
  tracked: TrackedPaths;
};

export type IgnoreContextOptions = {
  /** Directory above which the repository search stops (like GIT_CEILING_DIRECTORIES). */
  ceiling?: string;
};

const MAX_PARENT_LEVELS = 64;
export const MAX_RULES_PER_FILE = 10_000;
export const MAX_PATTERN_LENGTH = 4_096;
const MAX_CONFIG_LINE_LENGTH = 1_024;

type RepositoryProbe = { kind: "none" } | { kind: "directory" } | { kind: "file" };

export async function loadIgnoreContext(projectRoot: string, options: IgnoreContextOptions = {}): Promise<IgnoreContext> {
  const ceiling = options.ceiling === undefined ? undefined : path.resolve(options.ceiling);
  const chain: string[] = [];
  let repositoryRoot: string | null = null;
  let probe: RepositoryProbe = { kind: "none" };

  for (let directory = path.resolve(projectRoot), level = 0; level < MAX_PARENT_LEVELS; level++) {
    chain.push(directory);
    probe = await probeRepository(directory);
    if (probe.kind !== "none") {
      repositoryRoot = directory;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory || directory === ceiling) break;
    directory = parent;
  }
  if (repositoryRoot === null) {
    return { repositoryRoot, ignoreCase: false, ruleSets: [], problems: [], tracked: { status: "ok", paths: new Set() } };
  }

  const problems: string[] = [];
  const gitDirectory = path.join(repositoryRoot, ".git");
  let ignoreCase = false;
  let sha256 = false;
  if (probe.kind === "file") {
    // Linked worktree or submodule: config, exclude and index live elsewhere and are not followed.
    problems.push("this is a linked worktree or submodule, whose git metadata EnvSync does not read");
  } else {
    const config = await readOptional(path.join(gitDirectory, "config"));
    if (config.kind === "problem") problems.push(`.git/config ${config.reason}`);
    if (config.kind === "text") {
      const parsed = parseGitConfig(config.text);
      ignoreCase = parsed.ignoreCase;
      sha256 = parsed.sha256;
      if (parsed.unparsedLines > 0) problems.push(".git/config has lines EnvSync could not parse");
    }
  }

  const ruleSets: RuleSet[] = [];
  const addRules = async (base: string, file: string, label: string) => {
    const read = await readOptional(file);
    if (read.kind === "missing") return;
    if (read.kind === "problem") {
      ruleSets.push({ base, rules: [], problems: [`${label} ${read.reason}`] });
      return;
    }
    const parsed = parseIgnoreRules(read.text, ignoreCase);
    ruleSets.push({ base, rules: parsed.rules, problems: parsed.truncated ? [`${label} exceeds EnvSync's rule limits, so some rules were not evaluated`] : [] });
  };
  if (probe.kind === "directory") await addRules(repositoryRoot, path.join(gitDirectory, "info", "exclude"), ".git/info/exclude");
  for (const directory of chain.reverse()) {
    const relative = path.relative(repositoryRoot, path.join(directory, ".gitignore")).split(path.sep).join("/");
    await addRules(directory, path.join(directory, ".gitignore"), relative);
  }

  const tracked: TrackedPaths =
    probe.kind === "directory"
      ? await readTrackedPaths(gitDirectory, sha256 ? 32 : 20)
      : { status: "unavailable", reason: "this is a linked worktree or submodule, whose index EnvSync does not read" };

  return { repositoryRoot, ignoreCase, ruleSets, problems, tracked };
}

/**
 * Whether `fileName`, directly inside `projectRoot`, would be ignored by git (if untracked).
 * "unknown" whenever a ruleset that applies to the file or any of its ancestor directories was not
 * fully read, or the repository metadata could not be read.
 */
export function ignoreStatus(context: IgnoreContext, projectRoot: string, fileName: string): IgnoreStatus {
  return explainIgnoreStatus(context, projectRoot, fileName).status;
}

/** `ignoreStatus` plus the reasons when the answer is "unknown". */
export function explainIgnoreStatus(context: IgnoreContext, projectRoot: string, fileName: string): { status: IgnoreStatus; reasons: string[] } {
  if (context.repositoryRoot === null) return { status: "not-ignored", reasons: [] };
  const root = path.resolve(projectRoot);
  const target = path.join(root, fileName);

  const reasons = [...context.problems];
  for (const ruleSet of context.ruleSets) {
    if (ruleSet.problems.length > 0 && isInside(ruleSet.base, target)) reasons.push(...ruleSet.problems);
  }
  if (reasons.length > 0) return { status: "unknown", reasons };

  // Git does not look inside an ignored directory, so an ignored ancestor ignores the file.
  for (let directory = root; directory !== context.repositoryRoot; directory = path.dirname(directory)) {
    if (decide(context, directory, true)) return { status: "ignored", reasons: [] };
    if (path.dirname(directory) === directory) break;
  }
  return { status: decide(context, target, false) ? "ignored" : "not-ignored", reasons: [] };
}

/** Kept for callers that only need a yes/no and have already ruled out "unknown". */
export function isIgnoredFile(context: IgnoreContext, projectRoot: string, fileName: string): boolean {
  return ignoreStatus(context, projectRoot, fileName) === "ignored";
}

/** `true`/`false` when the index was read; `undefined` when tracking status is unknown. */
export function isTrackedFile(context: IgnoreContext, projectRoot: string, fileName: string): boolean | undefined {
  if (context.repositoryRoot === null) return false;
  if (context.tracked.status !== "ok") return undefined;
  const relative = path.relative(context.repositoryRoot, path.join(path.resolve(projectRoot), fileName)).split(path.sep).join("/");
  if (!context.ignoreCase) return context.tracked.paths.has(relative);
  const folded = foldAscii(relative);
  for (const tracked of context.tracked.paths) if (foldAscii(tracked) === folded) return true;
  return false;
}

/** The last matching rule wins across all applicable rulesets, in precedence order. */
function decide(context: IgnoreContext, target: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const { base, rules } of context.ruleSets) {
    if (!isInside(base, target)) continue;
    const relativePath = path.relative(base, target).split(path.sep).join("/");
    const baseName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (wildmatch(rule.pattern, rule.anchored ? relativePath : baseName)) ignored = !rule.negated;
    }
  }
  return ignored;
}

/** Whether `target` is strictly inside `base` (a directory named `..x` is inside; `..` is not). */
function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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

/**
 * Minimal `.git/config` reader for the two settings `doctor` needs. Linear-time string scanning
 * (no backtracking regexes); lines over 1,024 characters are counted as unparsed.
 */
export function parseGitConfig(text: string): { ignoreCase: boolean; sha256: boolean; unparsedLines: number } {
  let section = "";
  let ignoreCase = false;
  let sha256 = false;
  let unparsedLines = 0;
  for (const rawLine of text.split("\n")) {
    if (rawLine.length > MAX_CONFIG_LINE_LENGTH) {
      unparsedLines++;
      continue;
    }
    const line = stripConfigComment(rawLine).trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      const close = line.indexOf("]");
      if (close === -1) {
        unparsedLines++;
        continue;
      }
      // `[section]` or `[section "subsection"]`: only the section name matters here.
      const header = line.slice(1, close).trim();
      const space = header.search(/\s/);
      section = (space === -1 ? header : header.slice(0, space)).toLowerCase();
      continue;
    }
    const equals = line.indexOf("=");
    const key = (equals === -1 ? line : line.slice(0, equals)).trim().toLowerCase();
    const value = (equals === -1 ? "true" : line.slice(equals + 1)).trim().toLowerCase();
    if (section === "core" && key === "ignorecase") ignoreCase = ["true", "yes", "on", "1"].includes(value);
    if (section === "extensions" && key === "objectformat") sha256 = value === "sha256";
  }
  return { ignoreCase, sha256, unparsedLines };
}

/** Removes a `#` or `;` comment that is not inside double quotes. */
function stripConfigComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\") i++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "#" || char === ";")) return line.slice(0, i);
  }
  return line;
}

type OptionalRead = { kind: "text"; text: string } | { kind: "missing" } | { kind: "problem"; reason: string };

async function readOptional(file: string): Promise<OptionalRead> {
  const read = await readRegularFile(file);
  if (read.ok) return { kind: "text", text: read.text };
  switch (read.reason) {
    case "missing":
      return { kind: "missing" };
    case "too-large":
      return { kind: "problem", reason: "is larger than EnvSync's 1 MB limit, so its rules were not evaluated" };
    case "not-regular":
      return { kind: "problem", reason: "is not a regular file (symbolic links are not followed), so its rules were not evaluated" };
    case "changed":
      return { kind: "problem", reason: "changed while it was being read" };
    case "unreadable":
      return { kind: "problem", reason: "could not be read" };
  }
}

/**
 * Git treats a directory as a repository only if `.git` is a valid git directory (a `HEAD` that
 * names a ref or object, plus `objects/` and `refs/`); otherwise it keeps searching upward. A `.git`
 * file is a link to a git directory elsewhere (worktree, submodule).
 */
async function probeRepository(directory: string): Promise<RepositoryProbe> {
  const dotGit = path.join(directory, ".git");
  let stats;
  try {
    stats = await lstat(dotGit);
  } catch {
    return { kind: "none" };
  }
  if (stats.isFile()) return { kind: "file" };
  if (!stats.isDirectory()) return { kind: "none" };

  const head = await readRegularFile(path.join(dotGit, "HEAD"), 4_096);
  if (!head.ok || !/^(ref: refs\/|[0-9a-f]{40}\b|[0-9a-f]{64}\b)/.test(head.text)) return { kind: "none" };
  if (!(await isDirectory(path.join(dotGit, "objects"))) || !(await isDirectory(path.join(dotGit, "refs")))) return { kind: "none" };
  return { kind: "directory" };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}
