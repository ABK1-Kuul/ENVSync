import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Reads the list of tracked paths from `.git/index` without running git. Only path names are read;
 * object hashes and file contents are never used. Any unexpected structure makes the result
 * "unavailable" rather than guessing, so callers can avoid reporting a false "not tracked".
 */

export type TrackedPaths =
  | { status: "ok"; paths: ReadonlySet<string> }
  | { status: "unavailable"; reason: string };

/** Large monorepos have large indexes; this bounds memory while covering realistic repositories. */
export const MAX_INDEX_BYTES = 256 * 1024 * 1024;

const ENTRY_STAT_BYTES = 40; // ctime, mtime (8 each), dev, ino, mode, uid, gid, size (4 each)

export async function readTrackedPaths(gitDirectory: string, hashBytes: 20 | 32): Promise<TrackedPaths> {
  const indexPath = path.join(gitDirectory, "index");
  let stats;
  try {
    stats = await lstat(indexPath);
  } catch (error) {
    // A repository with nothing staged yet has no index: nothing is tracked.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { status: "ok", paths: new Set() };
    return { status: "unavailable", reason: "the git index could not be accessed" };
  }
  if (!stats.isFile()) return { status: "unavailable", reason: "the git index is not a regular file" };
  if (stats.size > MAX_INDEX_BYTES) return { status: "unavailable", reason: "the git index is too large to read" };

  let buffer: Buffer;
  try {
    buffer = await readFile(indexPath);
  } catch {
    return { status: "unavailable", reason: "the git index could not be read" };
  }
  const paths = parseIndex(buffer, hashBytes);
  return paths === null ? { status: "unavailable", reason: "the git index format was not recognized" } : { status: "ok", paths };
}

/** Returns tracked paths (repository-relative, `/`-separated) or `null` if the data is not a valid index. */
export function parseIndex(buffer: Buffer, hashBytes: 20 | 32): Set<string> | null {
  if (buffer.length < 12 || buffer.toString("latin1", 0, 4) !== "DIRC") return null;
  const version = buffer.readUInt32BE(4);
  if (version < 2 || version > 4) return null;
  const count = buffer.readUInt32BE(8);
  // Every entry needs at least its fixed fields, so a count larger than this is corrupt.
  if (count > buffer.length / (ENTRY_STAT_BYTES + hashBytes + 2)) return null;

  const paths = new Set<string>();
  let offset = 12;
  let previousName: Buffer = Buffer.alloc(0);

  for (let entry = 0; entry < count; entry++) {
    const entryStart = offset;
    const flagsOffset = entryStart + ENTRY_STAT_BYTES + hashBytes;
    if (flagsOffset + 2 > buffer.length) return null;
    const flags = buffer.readUInt16BE(flagsOffset);
    let nameStart = flagsOffset + 2;
    if (flags & 0x4000) {
      if (version < 3) return null;
      nameStart += 2; // extended flags
    }
    if (nameStart > buffer.length) return null;

    let name: Buffer;
    if (version === 4) {
      // Prefix compression: a varint says how many bytes to drop from the previous name.
      const varint = readVarint(buffer, nameStart);
      if (varint === null || varint.value > previousName.length) return null;
      const terminator = buffer.indexOf(0, varint.next);
      if (terminator === -1) return null;
      name = Buffer.concat([previousName.subarray(0, previousName.length - varint.value), buffer.subarray(varint.next, terminator)]);
      offset = terminator + 1;
    } else {
      const terminator = buffer.indexOf(0, nameStart);
      if (terminator === -1) return null;
      name = buffer.subarray(nameStart, terminator);
      // Entries are NUL-padded to a multiple of 8 bytes (at least one NUL).
      offset = entryStart + ((terminator - entryStart + 8) & ~7);
      if (offset > buffer.length) return null;
    }
    previousName = name;
    paths.add(name.toString("utf8"));
  }
  return paths;
}

function readVarint(buffer: Buffer, start: number): { value: number; next: number } | null {
  let i = start;
  if (i >= buffer.length) return null;
  let byte = buffer[i] as number;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    i++;
    if (i >= buffer.length || value > 0xffffff) return null;
    byte = buffer[i] as number;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: i + 1 };
}
