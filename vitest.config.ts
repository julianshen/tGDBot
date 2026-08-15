import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scope discovery to this checkout's own suites. Without this, vitest's
    // default `**/*.test.ts` walk descends into `.worktrees/*`, so running the
    // suite from the primary checkout also collects every linked worktree's
    // tests against ITS sources — reporting failures from unrelated branches
    // as if they belonged to this one.
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".worktrees/**"],
    // Much of this suite is not a pure in-memory unit test: the conversation
    // state store, publication manifests, and poll discovery exercise real temp
    // directories, fsync ordering, and lock serialization. Run in parallel they
    // contend for IO badly enough that unrelated tests exceed any per-test
    // budget, and the failures read exactly like logic errors while being
    // purely a function of machine load.
    //
    // Measured on this suite: sequential is 260s against 183s parallel, and it
    // is reliable. A generous timeout was tried first and made things worse —
    // dozens of contention timeouts at 60s each turn a suite that fails in
    // four minutes into one that appears to hang for forty. Determinism is
    // worth 80 seconds; a test suite nobody can trust hides real defects, which
    // is exactly how a branch that could not compile reported 1477 passing.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
