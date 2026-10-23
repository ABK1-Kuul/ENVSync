export { analyze } from "./analyze.js";
export type { AnalysisInput, FileExposures, FileReferences } from "./analyze.js";
export { compareDiagnostics, countBySeverity, DIAGNOSTIC_CODES } from "./diagnostics.js";
export type { Diagnostic, DiagnosticCode, Severity, SeverityCounts } from "./diagnostics.js";
export {
  discoverSourceFiles,
  DiscoveryError,
  EXCLUDED_DIRECTORIES,
  SOURCE_EXTENSIONS,
} from "./discovery.js";
export type { DiscoveryErrorCode, DiscoveryResult, SkippedEntry } from "./discovery.js";
export type { ClientExposedName, ExtractedReference, FrameworkAdapter, Location } from "./framework.js";
export { CONFIG_FILE_NAME, ENV_EXAMPLE_FILE_NAME, MAX_FILE_BYTES, scanProject, ScanError } from "./scan.js";
export type { ScanErrorCode, ScanOptions, ScanResult, SkippedPath } from "./scan.js";
