// Resolves the on-disk path to the installed `pi-subagents` pi extension's
// entry point, for use in DefaultResourceLoader's `additionalExtensionPaths`.
// See SPEC.md's "Architecture correction" note and TASKS.md Task 5.
//
// The entry path is read from pi-subagents' own package.json ("pi":
// { "extensions": [...] }) rather than hardcoded, because the field is
// authoritative and the exact file layout can change between versions
// (confirmed against the installed pi-subagents@0.34.0: "./src/extension/index.ts").
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

interface PiPackageJson {
  pi?: {
    extensions?: string[];
  };
}

// Resolved via Node's CommonJS-style module resolution (createRequire +
// require.resolve) rather than `import.meta.resolve`: this project is ESM,
// and `import.meta.resolve` does work under plain `node`/`tsc` (verified),
// but vitest's SSR module runner does not implement it
// ("__vite_ssr_import_meta__.resolve is not a function" — confirmed by
// running the AC-5.1 test), so it can't be used here without breaking the
// test suite. `createRequire` is a real Node API that both `node` and
// vitest's SSR runner support, and gives identical resolution semantics.
const require = createRequire(import.meta.url);

export function resolvePiSubagentsExtensionPath(): string {
  const packageJsonPath = require.resolve("pi-subagents/package.json");
  const packageRoot = path.dirname(packageJsonPath);

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PiPackageJson;
  const entry = pkg.pi?.extensions?.[0];
  if (!entry) {
    throw new Error(
      `pi-subagents package.json (${packageJsonPath}) is missing a "pi.extensions[0]" entry`,
    );
  }

  return path.resolve(packageRoot, entry);
}
