# Releasing EnvSync

The published package is **`envsync`** (Apache-2.0), built from `apps/cli`. It is a single bundled
file, `dist/envsync.js`; the internal workspace packages (`@envsync-internal/*`) are bundled in
and are never published. `typescript` is the only runtime dependency.

## Pre-release checklist

1. `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build` all pass.
2. Bump `version` in `apps/cli/package.json` **and** `VERSION` in `apps/cli/src/main.ts`
   (a test fails if they differ). Move the `[Unreleased]` CHANGELOG entries under the new version.
3. Dry run, without publishing:
   ```sh
   cd apps/cli
   pnpm pack --pack-destination <temp-dir>   # runs the bundle via prepack
   tar -tzf <temp-dir>/envsync-<version>.tgz # expect exactly: LICENSE, README.md, CHANGELOG.md, package.json, dist/envsync.js
   ```
4. Install the tarball into an empty project (`npm install <tarball>`) and run
   `npx envsync --version`, `scan`, `init` and `doctor` against a fixture copy.
5. Run the `/release-check` skill and a security review of the diff since the last release.

Publishing itself (`pnpm publish` from `apps/cli`) is a manual, owner-only step and is not
automated in CI.

## Notes

- The published manifest still lists `@envsync-internal/*` under `devDependencies` (pnpm rewrites
  `workspace:*` to `0.0.0`). Consumers never install devDependencies, but registering the
  `@envsync-internal` scope on npm (free) removes any chance of someone else claiming it.
- esbuild's install script is denied (`allowBuilds: esbuild: false` in `pnpm-workspace.yaml`);
  its platform binary arrives as an optional dependency and works without it.
