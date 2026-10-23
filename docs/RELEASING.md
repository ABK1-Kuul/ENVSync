# Releasing EnvSync

The published package is **`envsync`** (Apache-2.0), built from `apps/cli`. It is a single bundled
file, `dist/envsync.js`; the internal workspace packages (`@envsync-internal/*`) are bundled in
and are never published. `typescript` is the only runtime dependency.

`apps/cli/package.json` is marked `private`, so `npm publish` from the source tree is refused. The
publishable package is assembled outside the repository by `apps/cli/scripts/stage.mjs`, with an
allow-listed manifest (no `devDependencies`, `scripts` or `private`), so no generated files are
ever written into the source tree.

## Pre-release checklist

1. `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build` all pass.
   (`apps/cli/test/package.test.ts` stages the package and checks its files and manifest.)
2. Bump `version` in `apps/cli/package.json` **and** `VERSION` in `apps/cli/src/main.ts`
   (a test fails if they differ). Move the `[Unreleased]` CHANGELOG entries under the new version.
3. Stage and dry-run, without publishing:
   ```sh
   node apps/cli/scripts/stage.mjs --out <empty-dir>   # bundles, then assembles the package
   npm pack <empty-dir> --pack-destination <tmp>       # expect exactly: LICENSE, README.md, CHANGELOG.md, package.json, dist/envsync.js
   ```
4. Install the tarball into an empty project outside the repository (`npm install <tarball>`) and
   run `npx envsync --version`, `scan`, `init` and `doctor` against a fixture copy. CI does the
   install and `scan` part on every push.
5. Run the `/release-check` skill and a security review of the diff since the last release.

Publishing (`npm publish <staged-dir>`) is a manual, owner-only step and is not automated in CI.

## Notes

- Register the `@envsync-internal` scope on npm (free) so nobody else can claim it, even though
  those names never appear in the published package.
- esbuild's install script is denied (`allowBuilds: esbuild: false` in `pnpm-workspace.yaml`);
  its platform binary arrives as an optional dependency and works without it.
