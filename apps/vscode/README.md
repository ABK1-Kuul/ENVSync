# EnvSync for VS Code

Edit `.env` files as a table, see EnvSync's checks in the Problems panel, and switch the
environment the checks use. Pre-release; not yet published to the Marketplace.

## Features

- **Table editor for env files.** Right-click a `.env` / `.env.*` file and choose
  **Open as EnvSync table** (or *Open With… → EnvSync table*). The table shows each variable's
  value, visibility, type, whether it is required, its description from `envsync.config.ts`, and
  problems: duplicates, undeclared names, values that do not match the declared type, and
  credentials in public (`NEXT_PUBLIC_`) variables.
- **Safe edits.** Change, add, rename or remove variables from the table. Every change opens VS
  Code's edit preview first. Comments, blank lines, ordering, `export`, quoting style and line
  endings are kept. A value that cannot be written back exactly is refused, never altered. If the
  file changed after the table was drawn, the edit is rejected and the table refreshes.
- **Raw text alongside.** *Open as text* shows the same file in the normal editor. Both views
  edit the same document, so undo, saving and "file changed on disk" work as usual.
- **Masked values.** Values of `secret`/`sensitive` variables, private-looking names
  (`…_TOKEN`, `…_KEY`, …) and credential-shaped values are hidden until you choose *Reveal*.
- **Diagnostics.** The EnvSync scan runs on save and when the environment changes, in every
  workspace folder that has an `envsync.config.ts`.
- **Environment selector.** The status bar shows the environment the checks use (Development,
  Preview, Production or Test). Click it to change.

## Privacy and safety

- Local only: no network requests and no telemetry.
- Never executes code from the workspace. `envsync.config.ts` and source files are parsed as
  data. The extension is therefore enabled in untrusted workspaces.
- Diagnostics never contain values. A value appears in the table only if it is not masked, or
  after you reveal it.

## Requirements

VS Code 1.95 or newer (or a compatible editor).
