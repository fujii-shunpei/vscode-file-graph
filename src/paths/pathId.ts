import * as fs from "fs";

// realpath is a syscall, and the same paths are asked for over and over: once
// while collecting files and again for every import that resolves to them.
const canonicalPaths = new Map<string, string>();

/**
 * Canonicalize a path so that one file always yields one graph node id.
 *
 * `fs.realpathSync.native` answers with the spelling the file system stores, which
 * settles case differences on case insensitive volumes (`./B` and `./b` reaching the
 * same file) and resolves symlinks to the file they point at.
 *
 * @param filePath Path to canonicalize.
 * @returns The canonical path, or `filePath` unchanged when it cannot be resolved.
 */
export function toNodeId(filePath: string): string {
  const cached = canonicalPaths.get(filePath);
  if (cached !== undefined) return cached;

  let canonical: string;
  try {
    canonical = fs.realpathSync.native(filePath);
  } catch {
    // A path that does not exist has no canonical form. This is an ordinary case
    // (a deleted file, a workspace root that was never created), so the input is
    // handed back rather than failing: the caller still needs an id to work with.
    canonical = filePath;
  }

  canonicalPaths.set(filePath, canonical);
  return canonical;
}

/** Forget every canonical path, so renames and deletions are picked up again. */
export function clearPathIdCache(): void {
  canonicalPaths.clear();
}
