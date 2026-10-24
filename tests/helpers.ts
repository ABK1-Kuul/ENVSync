import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../apps/cli/src/main.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

export const FAKE_SECRET = "ENVSYNC_FAKE_SECRET_DO_NOT_LEAK";

export type FixtureCopy = { root: string; cleanup: () => Promise<void> };

/** Copies a fixture to a fresh temp directory and materializes its `.env.example`. */
export async function copyFixture(name: string): Promise<FixtureCopy> {
  const workspace = await mkdtemp(path.join(tmpdir(), `envsync-${name}-`));
  const root = path.join(workspace, name);
  await cp(path.join(FIXTURES_DIR, name), root, { recursive: true });
  try {
    await rename(path.join(root, "env.example.fixture"), path.join(root, ".env.example"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root, cleanup: () => rm(workspace, { recursive: true, force: true }) };
}

/**
 * Creates the smallest `.git` directory git (and EnvSync) accept as a repository: `HEAD` naming a
 * ref, plus `objects/` and `refs/`. An empty `.git` folder is not a repository.
 */
export async function makeMinimalGitDirectory(root: string): Promise<string> {
  const gitDirectory = path.join(root, ".git");
  await mkdir(path.join(gitDirectory, "objects"), { recursive: true });
  await mkdir(path.join(gitDirectory, "refs"), { recursive: true });
  await writeFile(path.join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
  return gitDirectory;
}

export type CliRun = { exitCode: number; stdout: string; stderr: string };

export async function runCli(args: string[], cwd: string): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const exitCode = await main(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd,
  });
  return { exitCode, stdout, stderr };
}
