// Makes a tool-owned root directory private before anything trusted is read
// from or written to it.
//
// Extracted from `manager.ts`, where it guarded only the managed git
// workspace. The context cache needs exactly the same guarantee for a stronger
// reason: `ContextCache.lookupContext` verifies that an entry's artifacts match
// the hashes in its own manifest, but a manifest is self-describing — it says
// nothing about WHO wrote it. On a shared writable root, another local user can
// pre-create the deterministic cache entry with a perfectly self-consistent
// manifest, and its text is then handed to the reviewing model inside
// `[TRUSTED_CONTEXT]`. Hash integrity is not provenance; directory ownership is
// what supplies it.
import { chmod, lstat, stat } from "node:fs/promises";
import path from "node:path";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Refuses a root reachable through a symlink at any level, which would let the
 * real directory sit somewhere the ownership checks never looked.
 */
export async function assertNoSymlinkedAncestors(
  root: string,
  candidates: readonly string[],
  label = "Managed workspace",
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  for (const candidate of [resolvedRoot, ...candidates]) {
    const relative = path.relative(resolvedRoot, candidate);
    const segments = relative === "" ? [] : relative.split(path.sep);
    let current = resolvedRoot;
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) current = path.join(current, segments[index]!);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`${label} path contains a symbolic link: ${current}`);
        }
      } catch (error) {
        if (isMissing(error)) break;
        throw error;
      }
    }
  }
}

/**
 * Requires the root to be a real directory owned by the current user, sitting
 * under ancestors no other user can replace, then makes it mode 0700 and
 * re-checks that the directory it just secured is the one it inspected.
 *
 * A no-op on Windows, whose permission model this does not describe.
 */
export interface ProtectManagedRootOptions {
  /**
   * Refuse a pre-existing root that other users could write, instead of
   * adopting it and locking it down.
   *
   * Off by default because the managed git workspace has always adopted such a
   * root (and a test asserts it): reversing that is a separate decision from
   * this one. The context cache turns it ON, because its contents are read
   * back as `[TRUSTED_CONTEXT]` — ownership NOW is not evidence about the past,
   * and chmodding to 0700 locks the door on whatever is already inside.
   */
  readonly rejectPreviouslyShared?: boolean;
}

export async function protectManagedRoot(
  root: string,
  label = "Managed workspace",
  options: ProtectManagedRootOptions = {},
): Promise<void> {
  if (process.platform === "win32") return;
  const initial = await lstat(root);
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error(`${label} root must be a real directory: ${root}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && initial.uid !== currentUid) {
    throw new Error(`${label} root must be owned by the current user: ${root}`);
  }
  // Callers that opt in create their root mode 0700, so a freshly-made one
  // never trips this whatever the umask; only a root that already existed and
  // was shared does.
  if (options.rejectPreviouslyShared === true && (initial.mode & 0o022) !== 0) {
    throw new Error(
      `${label} root was writable by other users and may already hold their files; ` +
        `remove it or choose another location: ${root}`,
    );
  }

  let ancestor = path.dirname(root);
  while (true) {
    const info = await stat(ancestor);
    const writableByOthers = (info.mode & 0o022) !== 0;
    const sticky = (info.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new Error(`${label} parent can be replaced by another user: ${ancestor}`);
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  await chmod(root, 0o700);
  const secured = await lstat(root);
  if (
    secured.isSymbolicLink() ||
    !secured.isDirectory() ||
    secured.dev !== initial.dev ||
    secured.ino !== initial.ino ||
    (secured.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} root changed while it was being protected: ${root}`);
  }
}
