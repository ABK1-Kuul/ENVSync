import { lstat } from "node:fs/promises";
import path from "node:path";
import { readProjectFile, ScanError } from "./project-files.js";

/**
 * Minimal, read-only `.gitignore` evaluation for `doctor`, so it never has to run `git`.
 * Supports comments, negation, anchoring, directory-only rules, `*`, `?`, `**` and character
 * classes, plus `.git/info/exclude`. Not supported (documented): the global excludes file and
 * whether a file is already tracked despite being ignored.
 */

type Rule = { negated: boolean; directoryOnly: boolean; anchored: boolean; regex: RegExp };

/** Rules from one ignore file; they apply to paths inside `base`. */
type RuleSet = { base: string; rules: Rule[] };

export type IgnoreContext = {
  /** Absolute path of the repository root, or `null` if the project is not in a git repository. */
  repositoryRoot: string | null;
  /** Lowest precedence first: `.git/info/exclude`, then `.gitignore` files from outermost to innermost. */
  ruleSets: RuleSet[];
};

const MAX_PARENT_LEVELS = 64;

export async function loadIgnoreContext(projectRoot: string): Promise<IgnoreContext> {
  const chain: string[] = [];
  let repositoryRoot: string | null = null;

  for (let directory = path.resolve(projectRoot), level = 0; level < MAX_PARENT_LEVELS; level++) {
    chain.push(directory);
    if (await exists(path.join(directory, ".git"))) {
      repositoryRoot = directory;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (repositoryRoot === null) return { repositoryRoot, ruleSets: [] };

  const ruleSets: RuleSet[] = [];
  const excludeText = await readIgnoreFile(path.join(repositoryRoot, ".git", "info"), "exclude");
  if (excludeText !== null) ruleSets.push({ base: repositoryRoot, rules: parseIgnoreRules(excludeText) });
  for (const directory of chain.reverse()) {
    const text = await readIgnoreFile(directory, ".gitignore");
    if (text !== null) ruleSets.push({ base: directory, rules: parseIgnoreRules(text) });
  }
  return { repositoryRoot, ruleSets };
}

/** Whether `fileName`, directly inside `projectRoot`, would be ignored by git. */
export function isIgnoredFile(context: IgnoreContext, projectRoot: string, fileName: string): boolean {
  if (context.repositoryRoot === null) return false;
  const root = path.resolve(projectRoot);

  // Git does not look inside an ignored directory, so an ignored ancestor ignores the file.
  const ancestors: string[] = [];
  for (let directory = root; directory !== context.repositoryRoot; directory = path.dirname(directory)) {
    ancestors.unshift(directory);
    if (path.dirname(directory) === directory) break;
  }
  if (ancestors.some((directory) => decide(context, directory, true))) return true;

  return decide(context, path.join(root, fileName), false);
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
      if (rule.regex.test(rule.anchored ? relativePath : baseName)) ignored = !rule.negated;
    }
  }
  return ignored;
}

export function parseIgnoreRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const rawLine of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (line === "") continue;
    rules.push({ negated, directoryOnly, anchored, regex: new RegExp(`^${globToRegex(line)}$`) });
  }
  return rules;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*" && glob[i + 1] === "*") {
      const atSegmentStart = i === 0 || glob[i - 1] === "/";
      if (atSegmentStart && glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
      } else {
        out += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (char === "\\" && i + 1 < glob.length) {
      out += escapeRegex(glob[i + 1] as string);
      i += 1;
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

async function readIgnoreFile(directory: string, fileName: string): Promise<string | null> {
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
