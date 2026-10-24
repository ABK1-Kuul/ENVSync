import path from "node:path";
import { readRegularFileBytes } from "./project-files.js";

/**
 * Reads the list of tracked paths from `.git/index` without running git. Only path names are read;
 * object hashes and file contents are never used.
 *
 * Deliberately conservative: anything this reader does not fully understand makes the result
 * "unavailable", so callers report "unknown" instead of a false "not tracked". That includes
 * split indexes (`link` extension: most entries live in `sharedindex.*`), sparse indexes (`sdir`
 * extension or directory entries standing for many files), malformed data, and inputs that would
 * need more than the memory caps below.
 */

export type TrackedPaths =
  | { status: "ok"; paths: ReadonlySet<string> }
  | { status: "unavailable"; reason: string };

export type ParsedIndex =
  | { kind: "ok"; paths: Set<string> }
  | { kind: "unsupported"; reason: string }
  | { kind: "invalid" };

/** Large monorepos have large indexes; this bounds the file read. */
export const MAX_INDEX_BYTES = 256 * 1024 * 1024;
/** Longest path accepted in one entry (git itself refuses paths this long on most systems). */
export const MAX_INDEX_NAME_BYTES = 4_096;
/** Bound on all decoded names together; v4 prefix compression can otherwise expand names quadratically. */
export const MAX_INDEX_DECODED_BYTES = 64 * 1024 * 1024;

const ENTRY_STAT_BYTES = 40; // ctime, mtime (8 each), dev, ino, mode, uid, gid, size (4 each)
const MODE_OFFSET = 24;
const DIRECTORY_MODE = 0o040000;

export async function readTrackedPaths(gitDirectory: string, hashBytes: 20 | 32): Promise<TrackedPaths> {
  const read = await readRegularFileBytes(path.join(gitDirectory, "index"), MAX_INDEX_BYTES);
  if (!read.ok) {
    // A repository with nothing staged yet has no index: nothing is tracked.
    if (read.reason === "missing") return { status: "ok", paths: new Set() };
    const reasons = {
      "not-regular": "the git index is not a regular file",
      "too-large": "the git index is too large to read",
      changed: "the git index changed while it was being read",
      unreadable: "the git index could not be read",
    } as const;
    return { status: "unavailable", reason: reasons[read.reason] };
  }
  const parsed = parseIndex(read.bytes, hashBytes);
  switch (parsed.kind) {
    case "ok":
      return { status: "ok", paths: parsed.paths };
    case "unsupported":
      return { status: "unavailable", reason: parsed.reason };
    case "invalid":
      return { status: "unavailable", reason: "the git index format was not recognized" };
  }
}

/** Parses tracked paths (repository-relative, `/`-separated). Never throws on any input. */
export function parseIndex(buffer: Buffer, hashBytes: 20 | 32): ParsedIndex {
  const invalid: ParsedIndex = { kind: "invalid" };
  // The index ends with a checksum of `hashBytes`; entries and extensions come before it.
  const end = buffer.length - hashBytes;
  if (end < 12 || buffer.toString("latin1", 0, 4) !== "DIRC") return invalid;
  const version = buffer.readUInt32BE(4);
  if (version < 2 || version > 4) return invalid;
  const count = buffer.readUInt32BE(8);
  // Every entry needs at least its fixed fields, so a count larger than this is corrupt.
  if (count > end / (ENTRY_STAT_BYTES + hashBytes + 2)) return invalid;

  const paths = new Set<string>();
  let decodedBytes = 0;
  let offset = 12;
  let previousName: Buffer = Buffer.alloc(0);

  for (let entry = 0; entry < count; entry++) {
    const entryStart = offset;
    const flagsOffset = entryStart + ENTRY_STAT_BYTES + hashBytes;
    if (flagsOffset + 2 > end) return invalid;
    // Directory entries only appear in sparse indexes, where one entry stands for a whole tree.
    if ((buffer.readUInt32BE(entryStart + MODE_OFFSET) & 0o170000) === DIRECTORY_MODE) {
      return { kind: "unsupported", reason: "the repository uses a sparse index, which EnvSync does not read" };
    }
    const flags = buffer.readUInt16BE(flagsOffset);
    let nameStart = flagsOffset + 2;
    if (flags & 0x4000) {
      if (version < 3) return invalid;
      nameStart += 2; // extended flags
    }
    if (nameStart > end) return invalid;

    let name: Buffer;
    if (version === 4) {
      // Prefix compression: a varint says how many bytes to drop from the previous name.
      const varint = readVarint(buffer, nameStart, end);
      if (varint === null || varint.value > previousName.length) return invalid;
      const terminator = buffer.indexOf(0, varint.next);
      if (terminator === -1 || terminator >= end) return invalid;
      const keep = previousName.length - varint.value;
      if (keep + (terminator - varint.next) > MAX_INDEX_NAME_BYTES) return invalid;
      name = Buffer.concat([previousName.subarray(0, keep), buffer.subarray(varint.next, terminator)]);
      offset = terminator + 1;
    } else {
      const terminator = buffer.indexOf(0, nameStart);
      if (terminator === -1 || terminator >= end) return invalid;
      if (terminator - nameStart > MAX_INDEX_NAME_BYTES) return invalid;
      name = buffer.subarray(nameStart, terminator);
      // Entries are NUL-padded to a multiple of 8 bytes (at least one NUL).
      offset = entryStart + ((terminator - entryStart + 8) & ~7);
      if (offset > end) return invalid;
    }

    decodedBytes += name.length;
    if (decodedBytes > MAX_INDEX_DECODED_BYTES) {
      return { kind: "unsupported", reason: "the git index has more path data than EnvSync reads" };
    }
    previousName = name;
    paths.add(name.toString("utf8"));
  }

  // Extensions: 4-byte signature, 4-byte size, data. They must tile exactly up to the checksum.
  // The size check also rejects leftovers shorter than a header (the bound is then negative);
  // the header read itself stays in range because the checksum follows `end`.
  while (offset < end) {
    const signature = buffer.toString("latin1", offset, offset + 4);
    const size = buffer.readUInt32BE(offset + 4);
    if (size > end - offset - 8) return invalid;
    if (signature === "link") {
      return { kind: "unsupported", reason: "the repository uses a split index, which EnvSync does not read" };
    }
    if (signature === "sdir") {
      return { kind: "unsupported", reason: "the repository uses a sparse index, which EnvSync does not read" };
    }
    offset += 8 + size;
  }
  return { kind: "ok", paths };
}

/** Git's offset varint. Returns null on truncation or values beyond any valid name length. */
function readVarint(buffer: Buffer, start: number, end: number): { value: number; next: number } | null {
  let i = start;
  if (i >= end) return null;
  let byte = buffer[i] as number;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    i++;
    if (i >= end) return null;
    byte = buffer[i] as number;
    // Plain arithmetic (no 32-bit shifts), capped well below overflow.
    value = (value + 1) * 128 + (byte & 0x7f);
    if (value > MAX_INDEX_DECODED_BYTES) return null;
  }
  return { value, next: i + 1 };
}
