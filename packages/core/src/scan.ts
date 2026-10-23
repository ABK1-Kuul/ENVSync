import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseConfigSource, parseEnvExample, type ParsedConfig, type ParsedEnvExample } from "@envsync/schema";
import { analyze, type FileExposures, type FileReferences } from "./analyze.js";
import type { Diagnostic } from "./diagnostics.js";
import { discoverSourceFiles } from "./discovery.js";
import type { FrameworkAdapter } from "./framework.js";

export const CONFIG_FILE_NAME = "envsync.config.ts";
export const ENV_EXAMPLE_FILE_NAME = ".env.example";
/** Files larger than this are skipped; real source files are far smaller, crafted ones may not be. */
export const MAX_FILE_BYTES = 1_000_000;

export type ScanErrorCode = "CONFIG_NOT_FOUND" | "UNSAFE_PATH" | "FILE_TOO_LARGE" | "READ_FAILED";

/** Problems that stop a scan before analysis (as opposed to findings, which are diagnostics). */
export class ScanError extends Error {
  readonly code: ScanErrorCode;

  constructor(code: ScanErrorCode, message: string) {
    super(message);
    this.name = "ScanError";
    this.code = code;
  }
}

export type SkippedPath = {
  path: string;
  reason: "symlink" | "unreadable" | "too-large" | "parse-failed";
};

export type ScanResult = {
  diagnostics: Diagnostic[];
  filesScanned: number;
  skipped: SkippedPath[];
};

export type ScanOptions = {
  root: string;
  framework: FrameworkAdapter;
};

/**
 * Runs the full scan pipeline. Reads only: the config file, `.env.example`, and discovered source
 * files. Never reads `.env`/`.env.*`, never executes project code, never touches the network.
 */
export async function scanProject({ root, framework }: ScanOptions): Promise<ScanResult> {
  const absoluteRoot = path.resolve(root);
  const discovery = await discoverSourceFiles(absoluteRoot);

  const configText = await readProjectFile(absoluteRoot, CONFIG_FILE_NAME);
  if (configText === null) {
    throw new ScanError(
      "CONFIG_NOT_FOUND",
      `No ${CONFIG_FILE_NAME} found in ${absoluteRoot}. Create one that declares your environment variables, then run the scan again.`,
    );
  }
  let config: ParsedConfig;
  try {
    config = parseConfigSource(configText, CONFIG_FILE_NAME);
  } catch {
    // e.g. pathological nesting exhausting the parser's stack: report it, never fall back to evaluation.
    config = {
      variables: [],
      issues: [
        {
          kind: "invalid",
          message: `${CONFIG_FILE_NAME} could not be parsed.`,
          suggestion: "Simplify the file to the documented literal format, then run the scan again.",
        },
      ],
    };
  }

  const exampleText = await readProjectFile(absoluteRoot, ENV_EXAMPLE_FILE_NAME);
  const envExample: ParsedEnvExample | null = exampleText === null ? null : parseEnvExample(exampleText);

  const skipped: SkippedPath[] = [...discovery.skipped];
  const references: FileReferences[] = [];
  const exposures: FileExposures[] = [];
  let filesScanned = 0;

  for (const file of discovery.files) {
    if (file === CONFIG_FILE_NAME) continue;
    const absolutePath = path.join(absoluteRoot, file);

    let text: string;
    try {
      if ((await stat(absolutePath)).size > MAX_FILE_BYTES) {
        skipped.push({ path: file, reason: "too-large" });
        continue;
      }
      text = await readFile(absolutePath, "utf8");
    } catch {
      skipped.push({ path: file, reason: "unreadable" });
      continue;
    }

    try {
      references.push({ file, references: framework.extractReferences(text, file) });
      if (framework.frameworkConfigFiles.includes(file)) {
        exposures.push({ file, names: framework.extractClientExposedNames(text, file) });
      }
    } catch {
      skipped.push({ path: file, reason: "parse-failed" });
      continue;
    }
    filesScanned++;
  }

  const diagnostics = analyze({
    configFile: CONFIG_FILE_NAME,
    config,
    envExampleFile: ENV_EXAMPLE_FILE_NAME,
    envExample,
    references,
    exposures,
    framework,
  });

  return {
    diagnostics,
    filesScanned,
    skipped: skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** Reads a fixed project-level file. Returns `null` if absent; refuses symlinks and oversized files. */
async function readProjectFile(absoluteRoot: string, fileName: string): Promise<string | null> {
  const absolutePath = path.join(absoluteRoot, fileName);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new ScanError("READ_FAILED", `Cannot access ${fileName}. Check that it is readable.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ScanError(
      "UNSAFE_PATH",
      `Refusing to read ${fileName} because it is not a regular file (symbolic links are not followed). Replace it with a regular file inside the project.`,
    );
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new ScanError("FILE_TOO_LARGE", `${fileName} is larger than ${MAX_FILE_BYTES} bytes. Check that it is the intended file.`);
  }
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    throw new ScanError("READ_FAILED", `Cannot read ${fileName}. Check that it is readable.`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
