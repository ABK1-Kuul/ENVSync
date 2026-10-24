import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readTrackedPaths, type TrackedPaths } from "./git-index.js";
import { readRegularFile } from "./project-files.js";
import { compileGitPathPattern, compileWildmatch, wildmatch, type CompiledPattern } from "./wildmatch.js";

/**
 * Read-only `.gitignore` evaluation for `doctor`, so it never has to run git.
 *
 * Follows git's rules: the repository is searched from the project's real (symlink-resolved) path,
 * lines split on LF (one trailing CR dropped), only unescaped trailing ASCII spaces trimmed, `#`
 * comments, `!` negation, `\` escapes, trailing `/` for directories, patterns containing `/`
 * anchored to their file's directory (with git's literal-prefix split), byte-wise wildmatch (see
 * wildmatch.ts), `.git/info/exclude` at the lowest precedence, deeper `.gitignore` files over
 * shallower ones, and no re-inclusion inside an ignored directory. Known deviations are documented
 * in docs/CLI.md.
 *
 * Uncertainty is explicit: if anything that could change the answer was not fully established
 * (rules not read, repository metadata EnvSync cannot verify, `core.ignorecase` not set in the
 * repository's own config and the answer depends on it), the answer is "unknown", never a guess.
 */

/**
 * `pattern` is matched the way git up to 2.46 does (literal prefix compared first, so a `**` right
 * after it starts the rest of the pattern); newer git versions match the whole pattern at once.
 * The two only differ when `**` directly follows a literal prefix that does not end in `/`
 * (`apps**\/x`); `modernPattern` is set only for those rules.
 */
type Rule = { negated: boolean; directoryOnly: boolean; anchored: boolean; pattern: CompiledPattern; modernPattern?: CompiledPattern };

type MatchVariant = "prefix-split" | "whole-pattern";

/** Rules from one ignore file; they apply to paths inside `base`. */
type RuleSet = {
  base: string;
  rules: Rule[];
  /** Why some rules from this file were not evaluated; empty when all were. */
  problems: string[];
};

export type IgnoreStatus = "ignored" | "not-ignored" | "unknown";

export type IgnoreContext = {
  /** Absolute real path of the repository root, or `null` if no repository was found. */
  repositoryRoot: string | null;
  /** The project root as given and as resolved through symlinks; paths are evaluated on the latter. */
  projectRoot: { lexical: string; real: string };
  /** `core.ignorecase` from the repository's own config; `undefined` when not established there. */
  ignoreCase: boolean | undefined;
  /** Why `ignoreCase` is undefined (shown when a result depends on it). */
  ignoreCaseUnknownReason: string;
  /** Lowest precedence first: `.git/info/exclude`, then `.gitignore` files from outermost to innermost. */
  ruleSets: RuleSet[];
  /**
   * Problems that make every ignore decision uncertain: repository metadata EnvSync could not
   * verify. May be non-empty even when `repositoryRoot` is null (then the project may still be
   * inside a repository that EnvSync could not recognize).
   */
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
const LINKED_METADATA = "this is a linked worktree or submodule, whose git metadata EnvSync does not read";
const OUTSIDE_PROJECT_REASON = "the path is outside the project EnvSync checked, so its repository was not searched";
const VERSION_DEPENDENT_REASON =
  "a .gitignore pattern with ** directly after other characters (like apps**/x) is matched differently by older and newer git versions, and the result depends on it";
const NOT_SET_REASON = "the result depends on core.ignorecase, which .git/config does not set (global settings are not read)";

/**
 * `directory`: a git directory EnvSync verified. `file`: a `.git` file (worktree, submodule).
 * `invalid`: a `.git` that git also rejects, so the search continues upward exactly as git's does.
 * `unverifiable`: a `.git` git might accept but EnvSync cannot verify without following links.
 */
type RepositoryProbe =
  | { kind: "none" }
  | { kind: "directory" }
  | { kind: "file" }
  | { kind: "invalid" }
  | { kind: "unverifiable"; reason: string };

export async function loadIgnoreContext(projectRoot: string, options: IgnoreContextOptions = {}): Promise<IgnoreContext> {
  const lexical = path.resolve(projectRoot);
  // Git searches from the physical directory, so symlinked, junctioned or substituted paths are
  // resolved first; otherwise EnvSync could walk different parent directories than git does.
  const problems: string[] = [];
  const resolved = await realpathOrNull(lexical);
  // If the real path cannot be established, git may search different parent directories.
  if (resolved === null) problems.push(`the real path of ${lexical} could not be resolved, so EnvSync cannot be sure which repository git uses`);
  const real = resolved ?? lexical;
  const ceiling = options.ceiling === undefined ? undefined : ((await realpathOrNull(path.resolve(options.ceiling))) ?? path.resolve(options.ceiling));
  const roots = { lexical, real };
  const chain: string[] = [];
  let repositoryRoot: string | null = null;
  let probe: RepositoryProbe = { kind: "none" };

  let directory = real;
  for (let level = 0; ; level++) {
    if (level === MAX_PARENT_LEVELS) {
      problems.push(`the directory is more than ${MAX_PARENT_LEVELS} levels deep, so the search for a git repository stopped early`);
      break;
    }
    chain.push(directory);
    probe = await probeRepository(directory);
    if (probe.kind === "directory" || probe.kind === "file") {
      repositoryRoot = directory;
      break;
    }
    if (probe.kind === "unverifiable") problems.push(probe.reason);
    const parent = path.dirname(directory);
    if (parent === directory || directory === ceiling) break;
    directory = parent;
  }
  if (repositoryRoot === null) {
    return {
      repositoryRoot,
      projectRoot: roots,
      ignoreCase: undefined,
      ignoreCaseUnknownReason: NOT_SET_REASON,
      ruleSets: [],
      problems,
      tracked: { status: "ok", paths: new Set() },
    };
  }

  const gitDirectory = path.join(repositoryRoot, ".git");
  let ignoreCase: boolean | undefined;
  let ignoreCaseUnknownReason = NOT_SET_REASON;
  let sha256 = false;
  if (probe.kind === "file") {
    // Linked worktree or submodule: config, exclude and index live elsewhere and are not followed.
    problems.push(LINKED_METADATA);
  } else {
    const config = await readOptional(path.join(gitDirectory, "config"));
    if (config.kind === "problem") problems.push(`.git/config ${config.reason}`);
    if (config.kind === "text") {
      const parsed = parseGitConfig(config.text);
      // Unparsed lines could set the value, so it is only trusted from a fully parsed file.
      if (parsed.unparsedLines === 0) {
        ignoreCase = parsed.ignoreCase;
      } else {
        ignoreCaseUnknownReason =
          "the result depends on core.ignorecase, which could not be confirmed because .git/config has lines EnvSync does not parse";
      }
      sha256 = parsed.sha256;
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
    const parsed = parseIgnoreRules(read.text);
    ruleSets.push({ base, rules: parsed.rules, problems: parsed.truncated ? [`${label} exceeds EnvSync's rule limits, so some rules were not evaluated`] : [] });
  };
  if (probe.kind === "directory") await addRules(repositoryRoot, path.join(gitDirectory, "info", "exclude"), ".git/info/exclude");
  for (const ruleDirectory of chain.reverse()) {
    const relative = path.relative(repositoryRoot, path.join(ruleDirectory, ".gitignore")).split(path.sep).join("/");
    await addRules(ruleDirectory, path.join(ruleDirectory, ".gitignore"), relative);
  }

  const tracked: TrackedPaths =
    probe.kind === "directory" ? await readTrackedPaths(gitDirectory, sha256 ? 32 : 20) : { status: "unavailable", reason: LINKED_METADATA };

  return { repositoryRoot, projectRoot: roots, ignoreCase, ignoreCaseUnknownReason, ruleSets, problems, tracked };
}

/**
 * Whether `fileName`, directly inside `projectRoot`, would be ignored by git (if untracked).
 * "unknown" whenever a ruleset that applies to the file or any of its ancestor directories was not
 * fully read, the repository metadata could not be verified, or the answer depends on a
 * `core.ignorecase` value that is not set in the repository's own config.
 */
export function ignoreStatus(context: IgnoreContext, projectRoot: string, fileName: string): IgnoreStatus {
  return explainIgnoreStatus(context, projectRoot, fileName).status;
}

/** `ignoreStatus` plus the reasons when the answer is "unknown". */
export function explainIgnoreStatus(context: IgnoreContext, projectRoot: string, fileName: string): { status: IgnoreStatus; reasons: string[] } {
  if (context.repositoryRoot === null) {
    return context.problems.length > 0 ? { status: "unknown", reasons: [...context.problems] } : { status: "not-ignored", reasons: [] };
  }
  const root = toRealPath(context, projectRoot);
  if (root === null) return { status: "unknown", reasons: [OUTSIDE_PROJECT_REASON] };
  const target = path.join(root, fileName);

  const reasons = [...context.problems];
  for (const ruleSet of context.ruleSets) {
    if (ruleSet.problems.length > 0 && isInside(ruleSet.base, target)) reasons.push(...ruleSet.problems);
  }
  if (reasons.length > 0) return { status: "unknown", reasons };

  const verdict = (ignoreCase: boolean, variant: MatchVariant): boolean => {
    // Git does not look inside an ignored directory, so an ignored ancestor ignores the file.
    for (let directory = root; directory !== context.repositoryRoot; directory = path.dirname(directory)) {
      if (decide(context, directory, true, ignoreCase, variant)) return true;
      if (path.dirname(directory) === directory) break;
    }
    return decide(context, target, false, ignoreCase, variant);
  };

  // An answer is only reported when every possibility agrees: both core.ignorecase settings when
  // the value is not established, and both git matching behaviours for `apps**/x`-style patterns.
  const caseSettings = context.ignoreCase === undefined ? [false, true] : [context.ignoreCase];
  const variants: MatchVariant[] = hasVersionDependentRules(context) ? ["prefix-split", "whole-pattern"] : ["prefix-split"];
  const outcomes = new Set<string>();
  for (const ignoreCase of caseSettings) for (const variant of variants) outcomes.add(`${ignoreCase}|${variant}|${verdict(ignoreCase, variant)}`);
  const answers = new Set([...outcomes].map((outcome) => outcome.endsWith("true")));
  if (answers.size === 1) return { status: answers.has(true) ? "ignored" : "not-ignored", reasons: [] };

  const uncertainty: string[] = [];
  const differsByCase = caseSettings.length > 1 && variants.some((variant) => verdict(false, variant) !== verdict(true, variant));
  const differsByVersion = variants.length > 1 && caseSettings.some((ignoreCase) => verdict(ignoreCase, "prefix-split") !== verdict(ignoreCase, "whole-pattern"));
  if (differsByCase) uncertainty.push(context.ignoreCaseUnknownReason);
  if (differsByVersion) uncertainty.push(VERSION_DEPENDENT_REASON);
  // Both flags can be false only when the disagreement needs both factors at once.
  return { status: "unknown", reasons: uncertainty.length > 0 ? uncertainty : [context.ignoreCaseUnknownReason, VERSION_DEPENDENT_REASON] };
}

/** Kept for callers that only need a yes/no and have already ruled out "unknown". */
export function isIgnoredFile(context: IgnoreContext, projectRoot: string, fileName: string): boolean {
  return ignoreStatus(context, projectRoot, fileName) === "ignored";
}

/** `true`/`false` when established from the index; `undefined` when tracking status is unknown. */
export function isTrackedFile(context: IgnoreContext, projectRoot: string, fileName: string): boolean | undefined {
  return explainTrackedFile(context, projectRoot, fileName).tracked;
}

/**
 * `isTrackedFile` plus the reason whenever the answer is `undefined`, so callers can never treat an
 * undetermined answer as "not tracked".
 */
export function explainTrackedFile(
  context: IgnoreContext,
  projectRoot: string,
  fileName: string,
): { tracked: true | false; reason?: undefined } | { tracked: undefined; reason: string } {
  // Any doubt about which repository git uses means the index read may not be git's.
  if (context.problems.length > 0) return { tracked: undefined, reason: context.problems.join("; ") };
  if (context.repositoryRoot === null) return { tracked: false };
  if (context.tracked.status !== "ok") return { tracked: undefined, reason: context.tracked.reason };
  const root = toRealPath(context, projectRoot);
  if (root === null) return { tracked: undefined, reason: OUTSIDE_PROJECT_REASON };

  const relative = path.relative(context.repositoryRoot, path.join(root, fileName)).split(path.sep).join("/");
  if (context.tracked.paths.has(relative)) return { tracked: true };
  const folded = foldAscii(relative);
  let caseOnlyMatch = false;
  for (const tracked of context.tracked.paths) {
    if (foldAscii(tracked) === folded) {
      caseOnlyMatch = true;
      break;
    }
  }
  if (!caseOnlyMatch) return { tracked: false };
  // A match that differs only by case is tracked when git ignores case. With core.ignorecase=false
  // it still is on a case-insensitive file system (`git commit -a` commits the file through the
  // tracked name), which EnvSync does not detect, so it is never reported as "not tracked".
  if (context.ignoreCase === true) return { tracked: true };
  return {
    tracked: undefined,
    reason:
      context.ignoreCase === false
        ? `the git index tracks a file whose name differs from ${fileName} only by letter case; on a case-insensitive file system git commits changes to it even with core.ignorecase=false`
        : `the git index tracks a file whose name differs from ${fileName} only by letter case, and whether git treats them as the same file depends on core.ignorecase, which EnvSync could not establish`,
  };
}

/**
 * Maps a path given by the caller onto the real path the context was built from. `null` when the
 * path is outside the project the context describes: its repository was never searched.
 */
function toRealPath(context: IgnoreContext, projectRoot: string): string | null {
  const resolved = path.resolve(projectRoot);
  const { lexical, real } = context.projectRoot;
  const within = (base: string) => {
    const relative = path.relative(base, resolved);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ? relative : null;
  };
  const fromLexical = within(lexical);
  if (fromLexical !== null) return path.join(real, fromLexical);
  return within(real) !== null ? resolved : null;
}

/** The last matching rule wins across all applicable rulesets, in precedence order. */
function hasVersionDependentRules(context: IgnoreContext): boolean {
  return context.ruleSets.some((ruleSet) => ruleSet.rules.some((rule) => rule.modernPattern !== undefined));
}

function decide(context: IgnoreContext, target: string, isDirectory: boolean, ignoreCase: boolean, variant: MatchVariant): boolean {
  let ignored = false;
  for (const { base, rules } of context.ruleSets) {
    if (!isInside(base, target)) continue;
    const relativePath = path.relative(base, target).split(path.sep).join("/");
    const baseName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      const pattern = variant === "whole-pattern" ? (rule.modernPattern ?? rule.pattern) : rule.pattern;
      if (wildmatch(pattern, rule.anchored ? relativePath : baseName, ignoreCase)) ignored = !rule.negated;
    }
  }
  return ignored;
}

/** Whether `target` is strictly inside `base` (a directory named `..x` is inside; `..` is not). */
function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function parseIgnoreRules(text: string): { rules: Rule[]; truncated: boolean } {
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
    if (!anchored) {
      rules.push({ negated, directoryOnly, anchored, pattern: compileWildmatch(line) });
      continue;
    }
    const rule: Rule = { negated, directoryOnly, anchored, pattern: compileGitPathPattern(line) };
    if (isVersionDependent(line)) rule.modernPattern = compileWildmatch(line);
    rules.push(rule);
  }
  return { rules, truncated };
}

/**
 * Whether older and newer git can disagree on an anchored pattern: `**` directly after a literal
 * prefix (everything before the first `*`, `?`, `[` or `\`) that does not end with `/`.
 */
function isVersionDependent(pattern: string): boolean {
  const wildcard = pattern.search(/[*?[\\]/);
  return wildcard > 0 && pattern[wildcard - 1] !== "/" && pattern.startsWith("**", wildcard);
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
 * (no backtracking regexes). Anything this reader does not fully understand counts as an unparsed
 * line, so callers treat the settings as not established: lines over 1,024 characters, keys on a
 * section-header line, quoted values, line continuations, `include`/`includeIf` sections and
 * values that are not plain booleans.
 */
export function parseGitConfig(text: string): { ignoreCase: boolean | undefined; sha256: boolean; unparsedLines: number } {
  let section = "";
  let ignoreCase: boolean | undefined;
  let sha256 = false;
  let unparsedLines = 0;
  for (const rawLine of text.split("\n")) {
    if (rawLine.length > MAX_CONFIG_LINE_LENGTH) {
      unparsedLines++;
      continue;
    }
    const line = stripConfigComment(rawLine).trim();
    if (line === "") continue;
    if (line.endsWith("\\") || (line.includes('"') && !line.startsWith("["))) {
      unparsedLines++;
      continue;
    }
    if (line.startsWith("[")) {
      const close = line.indexOf("]");
      if (close === -1 || line.slice(close + 1).trim() !== "") {
        unparsedLines++;
        continue;
      }
      // The whole header is kept: `[core "x"]` (and old-style `[core.x]`) is a subsection, whose
      // `ignorecase` is `core.x.ignorecase`, not `core.ignorecase`, so only exact `[core]` counts.
      const header = line.slice(1, close).trim().toLowerCase();
      const space = header.search(/\s/);
      section = header;
      const name = space === -1 ? header : header.slice(0, space);
      // Included files can set anything, and EnvSync does not read them.
      if (name === "include" || name === "includeif") unparsedLines++;
      continue;
    }
    const equals = line.indexOf("=");
    const key = (equals === -1 ? line : line.slice(0, equals)).trim().toLowerCase();
    const value = (equals === -1 ? "true" : line.slice(equals + 1)).trim().toLowerCase();
    if (section === "core" && key === "ignorecase") {
      const parsed = parseGitBoolean(value);
      if (parsed === undefined) unparsedLines++;
      else ignoreCase = parsed;
    }
    if (section === "extensions" && key === "objectformat") sha256 = value === "sha256";
    // With per-worktree config, .git/config.worktree (not read) can override core.ignorecase.
    if (section === "extensions" && key === "worktreeconfig" && parseGitBoolean(value) !== false) unparsedLines++;
  }
  return { ignoreCase, sha256, unparsedLines };
}

function parseGitBoolean(value: string): boolean | undefined {
  if (["true", "yes", "on"].includes(value)) return true;
  if (["false", "no", "off", ""].includes(value)) return false;
  return /^-?\d+$/.test(value) ? Number(value) !== 0 : undefined;
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
 * Mirrors git's `is_git_directory` / `validate_headref`. A `.git` is "invalid" only when git
 * definitely rejects it: no `HEAD`, a `HEAD` whose first bytes name neither a ref (`ref:` +
 * optional space/tab/CR/LF + `refs/`) nor an object id (40+ hex digits, any case), or missing
 * `objects/`/`refs/` with no `commondir`. Anything git might accept but EnvSync cannot verify
 * without following links or reading elsewhere (links, a `commondir` file, `objects`/`refs` that
 * are not directories, an oversized `HEAD`, unreadable entries) is "unverifiable". A `.git` file
 * links to a git directory elsewhere (worktree, submodule).
 */
async function probeRepository(directory: string): Promise<RepositoryProbe> {
  const dotGit = path.join(directory, ".git");
  const unverifiable = (what: string, why = "is a symbolic link or could not be checked"): RepositoryProbe => ({
    kind: "unverifiable",
    reason: `${path.join(directory, what)} ${why}, so EnvSync cannot tell whether ${directory} is a git repository`,
  });

  const dotGitType = await entryType(dotGit);
  if (dotGitType === "missing") return { kind: "none" };
  if (dotGitType === "file") return { kind: "file" };
  if (dotGitType !== "directory") return unverifiable(".git");

  const headType = await entryType(path.join(dotGit, "HEAD"));
  if (headType === "missing" || headType === "directory") return { kind: "invalid" };
  if (headType !== "file") return unverifiable(path.join(".git", "HEAD"));
  const head = await readRegularFile(path.join(dotGit, "HEAD"), 4_096);
  if (!head.ok) return unverifiable(path.join(".git", "HEAD"), head.reason === "too-large" ? "is unusually large" : "could not be read");
  // git reads at most the first 255 bytes and does not look past the hash.
  if (!/^(ref:[ \t\r\n]*refs\/|[0-9a-fA-F]{40})/.test(head.text.slice(0, 255))) return { kind: "invalid" };

  // `commondir` points git at objects/ and refs/ in another directory, which EnvSync does not follow.
  if ((await entryType(path.join(dotGit, "commondir"))) !== "missing") return unverifiable(path.join(".git", "commondir"), "exists (shared git directory)");
  for (const required of ["objects", "refs"]) {
    const type = await entryType(path.join(dotGit, required));
    if (type === "missing") return { kind: "invalid" };
    // git only checks that these are accessible, so a file or link may still be accepted.
    if (type !== "directory") return unverifiable(path.join(".git", required), "is not a plain directory");
  }
  return { kind: "directory" };
}

/** `other`: a symbolic link, special file, or an entry whose type could not be read. */
async function entryType(target: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const stats = await lstat(target);
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "other";
  }
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}
