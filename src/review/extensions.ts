// Resolves the on-disk path to an installed pi extension's entry point, for
// use in DefaultResourceLoader's `additionalExtensionPaths`. See SPEC.md's
// "Architecture correction" note and TASKS.md Tasks 5 and 6.
//
// Each extension's entry path is read from that package's own package.json
// ("pi": { "extensions": [...] }) rather than hardcoded, because the field
// is authoritative and the exact file layout can change between versions
// (confirmed against the installed pi-subagents@0.34.0:
// "./src/extension/index.ts" and @juicesharp/rpiv-advisor@1.20.0:
// "./index.ts").
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

// Shared resolution logic: both pi-subagents and rpiv-advisor are ordinary
// node_modules packages that declare their pi extension entry point in
// their own package.json, so the same require.resolve + "pi.extensions[0]"
// read applies to either.
function resolvePiExtensionEntryPath(packageName: string): string {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageRoot = path.dirname(packageJsonPath);

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PiPackageJson;
  const entry = pkg.pi?.extensions?.[0];
  if (!entry) {
    throw new Error(
      `${packageName} package.json (${packageJsonPath}) is missing a "pi.extensions[0]" entry`,
    );
  }

  return path.resolve(packageRoot, entry);
}

export function resolvePiSubagentsExtensionPath(): string {
  return resolvePiExtensionEntryPath("pi-subagents");
}

// TASKS.md Task 6: same resolution pattern as
// resolvePiSubagentsExtensionPath — read from the real installed
// @juicesharp/rpiv-advisor package's own manifest rather than hardcoding
// (confirmed entry: "./index.ts").
export function resolveRpivAdvisorExtensionPath(): string {
  return resolvePiExtensionEntryPath("@juicesharp/rpiv-advisor");
}
