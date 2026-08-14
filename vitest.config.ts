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
    // Vitest's 5s default assumes pure in-memory unit tests. Much of this suite
    // is not that: the conversation state store, publication manifests, and
    // poll discovery exercise real temp directories, fsync ordering, and lock
    // serialization, and the heaviest drive several full poll() passes over
    // hundreds of events. Those files pass comfortably alone but contend for IO
    // when all 44 run in parallel, and the resulting timeouts read exactly like
    // logic failures while being purely a function of machine load — which is
    // how a suite that could not even compile still reported 1477 passing.
    //
    // Capping worker count instead was measured at more than double the total
    // wall-clock, so a generous per-test budget is the cheaper guarantee: a
    // healthy test never approaches it, a genuinely hung one still fails.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
