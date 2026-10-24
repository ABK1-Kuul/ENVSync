import path from "node:path";
import { parseConfigSource, parseEnvExample, type ParsedConfig, type ParsedEnvExample } from "@envsync-internal/schema";
import { analyze } from "./analyze.js";
import type { Diagnostic } from "./diagnostics.js";
import type { FrameworkAdapter } from "./framework.js";
import {
  collectSourceEvidence,
  CONFIG_FILE_NAME,
  ENV_EXAMPLE_FILE_NAME,
  readProjectFile,
  ScanError,
  type SkippedPath,
} from "./project-files.js";

export type ScanResult = {
  diagnostics: Diagnostic[];
  filesScanned: number;
  skipped: SkippedPath[];
  /** False when any path was not scanned (see `skipped`); findings may then be incomplete. */
  complete: boolean;
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
  const evidence = await collectSourceEvidence(absoluteRoot, framework);

  const configText = await readProjectFile(absoluteRoot, CONFIG_FILE_NAME);
  if (configText === null) {
    throw new ScanError(
      "CONFIG_NOT_FOUND",
      `No ${CONFIG_FILE_NAME} found in ${absoluteRoot}. Run \`envsync init\` to preview a starter config, then run the scan again.`,
    );
  }
  const config = parseConfigSafely(configText);

  const exampleText = await readProjectFile(absoluteRoot, ENV_EXAMPLE_FILE_NAME);
  const envExample: ParsedEnvExample | null = exampleText === null ? null : parseEnvExample(exampleText);

  const diagnostics = analyze({
    configFile: CONFIG_FILE_NAME,
    config,
    envExampleFile: ENV_EXAMPLE_FILE_NAME,
    envExample,
    references: evidence.references,
    exposures: evidence.exposures,
    framework,
  });

  return { diagnostics, filesScanned: evidence.filesScanned, skipped: evidence.skipped, complete: evidence.skipped.length === 0 };
}

/** Parses the config as data; a parser crash becomes an ENV004 issue, never a fallback to evaluation. */
export function parseConfigSafely(configText: string): ParsedConfig {
  try {
    return parseConfigSource(configText, CONFIG_FILE_NAME);
  } catch {
    return {
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
}
