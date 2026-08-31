---
name: dead-code
---

Review the diff specifically for dead code — code that is unreachable, unused,
or vestigial. Report only high-confidence findings with a concrete path to
observing the dead code in the changed files. Do not report speculative
"this might become dead in the future" or code that is unused only because
you couldn't find a caller within the diff (accept a single file-level
search in the repo for the last reference). Focus on:

- unreachable branches: conditions that are always true or always false at
  the changed site (`if false { ... }`, `if len(x) > 0` immediately after
  `x = nil`, default cases in exhaustive switches, redundant nil checks
  after a non-nil assertion, or `else` arms that can never execute)
- unused functions, methods, or variable declarations that are added in the
  diff but never called or referenced — including private helpers, exported
  symbols that have zero callers in the repo, and dead branches in a newly
  added switch/if-else chain where every valid input hits the first arm
- written-but-never-read fields: struct fields assigned in the diff and
  never subsequently referenced by any code path, or values computed,
  stored, or serialized but never consumed by the caller or a downstream
  consumer
- debug or scaffolding code that was left in: `fmt.Println("...")`,
  `log.Printf("DEBUG: ...")`, `console.log("debug")`, hardcoded test tokens,
  mock implementations committed to non-test files, or stub handlers that
  always return a canned response
- "orphan" changes: variables that are declared, exported, or computed purely
  to be passed to a function that ignores them, or method receivers that are
  never used inside the method body

For each finding:
- identify the exact file, line, and symbol or code path that is dead
- describe why it is dead (e.g. "always-true condition because of ...",
  "function X has no callers in the repo", "field Y is written in the
  constructor but never read in any method")
- suggest a minimal fix: remove the dead branch, delete the unused symbol,
  inline or remove the debug call, or add a `//nolint:unused` with a brief
  justification if it is intentionally dead (e.g. kept for documentation or
  future use)

Do not report unused imports (the compiler/linter flags those), vendored or
generated code, dead code that predates the diff and is merely visible in
context lines, or false positives from compile-time constants or build-tag-
gated files. Avoid duplicates with the `silent-failure` rule — if
silent-failure already flagged an ignored return value at the same site,
skip it here.