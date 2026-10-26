import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesDir = fileURLToPath(new URL("./packages/", import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against workspace sources, not built output.
    alias: [{ find: /^@envsync-internal\/(core|schema|parser-next|env-edit)$/, replacement: `${packagesDir}$1/src/index.ts` }],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
