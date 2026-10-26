/**
 * Environment contexts (ADR-017). Development, Production and Test load exactly the files Next.js
 * loads; Preview is EnvSync's convention: `.env.preview*` overrides on top of the production defaults,
 * because Next.js builds previews in production mode.
 */

export const ENV_CONTEXTS = ["development", "preview", "production", "test"] as const;

export type EnvContext = (typeof ENV_CONTEXTS)[number];

/** File names in the project root, highest priority first (the first file that sets a name wins). */
const CONTEXT_FILES: Record<EnvContext, readonly string[]> = {
  development: [".env.development.local", ".env.local", ".env.development", ".env"],
  production: [".env.production.local", ".env.local", ".env.production", ".env"],
  preview: [".env.preview.local", ".env.preview", ".env.production", ".env"],
  test: [".env.test.local", ".env.test", ".env"],
};

/**
 * Files that exist only for a deployed environment. When none of them is present, missing values
 * are expected to come from the hosting platform rather than from local files.
 */
const DEPLOYMENT_FILES: Partial<Record<EnvContext, readonly string[]>> = {
  production: [".env.production.local", ".env.production"],
  preview: [".env.preview.local", ".env.preview"],
};

export function isEnvContext(value: string): value is EnvContext {
  return (ENV_CONTEXTS as readonly string[]).includes(value);
}

export function contextFiles(context: EnvContext): readonly string[] {
  return CONTEXT_FILES[context];
}

/** Whether values for `context` normally come from the hosting platform, given the files present. */
export function expectsPlatformValues(context: EnvContext, presentFiles: ReadonlySet<string>): boolean {
  const own = DEPLOYMENT_FILES[context];
  return own !== undefined && !own.some((file) => presentFiles.has(file));
}
