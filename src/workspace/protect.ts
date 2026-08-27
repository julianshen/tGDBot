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
 * **This control is POSIX-only, and that is a real gap, not a footnote.** On
 * Windows it returns immediately and establishes nothing: uid ownership and
 * mode bits do not describe that platform, and Node exposes no portable API
 * for the ACLs that do. A caller relying on this for provenance — as the
 * context cache does, since its contents are read back as `[TRUSTED_CONTEXT]`
 * — therefore has NO provenance guarantee on Windows, and a directory another
 * local user can write could be pre-populated with a self-consistent entry.
 *
 * Closing it means either validating ACLs (no portable API; would mean
 * shelling out to `icacls` or a native dependency) or declining to trust a
 * cache on that platform at all — which would mean the feature does not work
 * on Windows. That is a product decision, so it is stated here rather than
 * silently chosen. Until it is made, prefer `--context off` on Windows for a
 * cache root that is not exclusively yours.
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
    // Ownership, not just write bits. An ancestor owned by another local user
    // at an ordinary mode 0755 passes every permission test here — owner-write
    // is not in 0o022 — yet its owner can rename the protected root after the
    // last check and put their own directory in its place. A sticky writable
    // ancestor is the same story: it stops others replacing entries they do
    // not own, and says nothing about the owner. Root is trusted because a
    // uid 0 that wanted this could take it far more directly.
    if (currentUid !== undefined && info.uid !== currentUid && info.uid !== 0) {
      throw new Error(`${label} parent is owned by another user: ${ancestor}`);
    }
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
