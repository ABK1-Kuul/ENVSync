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
export { runDoctor } from "./doctor.js";
export type { DoctorCheck, DoctorStatus } from "./doctor.js";
export type { ClientExposedName, ExtractedReference, FrameworkAdapter, Location } from "./framework.js";
export { isIgnoredFile, loadIgnoreContext, parseIgnoreRules } from "./gitignore.js";
export type { IgnoreContext } from "./gitignore.js";
export { applyInitPlan, InitError, planInit } from "./init.js";
export type { FileChange, InitErrorCode, InitPlan } from "./init.js";
export { CONFIG_FILE_NAME, ENV_EXAMPLE_FILE_NAME, MAX_FILE_BYTES, ScanError } from "./project-files.js";
export type { ScanErrorCode, SkippedPath } from "./project-files.js";
export { scanProject } from "./scan.js";
export type { ScanOptions, ScanResult } from "./scan.js";
