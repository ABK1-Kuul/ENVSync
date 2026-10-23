import { extractNextConfigEnvKeys, NEXT_CONFIG_FILE_NAMES } from "./next-config.js";
import { extractEnvReferences } from "./references.js";

export { extractEnvReferences } from "./references.js";
export type { EnvReference } from "./references.js";
export { extractNextConfigEnvKeys, NEXT_CONFIG_FILE_NAMES } from "./next-config.js";
export type { ExposedName } from "./next-config.js";

/** Next.js adapter consumed by `@envsync-internal/core` through its `FrameworkAdapter` interface. */
export const nextFramework = {
  name: "Next.js",
  publicPrefix: "NEXT_PUBLIC_",
  // Set by Next.js / Node itself; projects should not have to declare them.
  builtInVariables: ["NODE_ENV", "NEXT_RUNTIME"],
  // Read by `next start`/`next dev`, Node.js or Next.js internals rather than application code.
  externallyReadVariables: ["PORT", "HOSTNAME", "NODE_OPTIONS", "NEXT_TELEMETRY_DISABLED", "NEXT_SHARP_PATH", "TZ"],
  packageName: "next",
  frameworkConfigFiles: NEXT_CONFIG_FILE_NAMES,
  extractReferences: extractEnvReferences,
  extractClientExposedNames: extractNextConfigEnvKeys,
} as const;
