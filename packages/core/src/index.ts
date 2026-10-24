export { isUnsafeCodePoint } from "@envsync-internal/schema";
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
export type { DoctorCheck, DoctorOptions, DoctorStatus } from "./doctor.js";
export { parseIndex, readTrackedPaths } from "./git-index.js";
export type { ParsedIndex, TrackedPaths } from "./git-index.js";
export type { ClientExposedName, ExtractedReference, FrameworkAdapter, Location } from "./framework.js";
export { explainIgnoreStatus, ignoreStatus, isIgnoredFile, isTrackedFile, loadIgnoreContext, parseGitConfig, parseIgnoreRules } from "./gitignore.js";
export type { IgnoreContext, IgnoreContextOptions, IgnoreStatus } from "./gitignore.js";
export { compileWildmatch, wildmatch } from "./wildmatch.js";
export { applyInitPlan, InitError, planInit } from "./init.js";
export type { FileChange, InitErrorCode, InitPlan } from "./init.js";
export { CONFIG_FILE_NAME, ENV_EXAMPLE_FILE_NAME, MAX_FILE_BYTES, readRegularFile, ScanError } from "./project-files.js";
export type { RegularFileRead, ScanErrorCode, SkippedPath } from "./project-files.js";
export { scanProject } from "./scan.js";
export type { ScanOptions, ScanResult } from "./scan.js";
