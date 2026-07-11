import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AC-1.3: Given `npm run build` is executed, When the TypeScript compiler
// runs, Then it exits 0 with no type errors and produces `dist/cli.js`.
//
// This is a genuine build smoke test — it shells out to the real `npm run
// build` script (tsc + the dist/rules/builtin copy step) rather than
// mocking the compiler, so it is legitimately slower than the rest of the
// unit suite. Running `npm run build` is idempotent/safe: it only
// (re)writes files under `dist/`, which is gitignored and not otherwise
// depended on by any other test in this suite.
describe("AC-1.3: npm run build", () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );

  it(
    "AC-1.3: exits 0 and produces dist/cli.js",
    () => {
      // execFileSync throws (non-zero exit) if the build fails, which fails
      // the test on its own; we additionally assert explicitly below so
      // the failure mode is clear either way.
      expect(() =>
        execFileSync("npm", ["run", "build"], {
          cwd: repoRoot,
          stdio: "pipe",
        }),
      ).not.toThrow();

      const cliPath = path.join(repoRoot, "dist", "cli.js");
      expect(existsSync(cliPath)).toBe(true);
    },
    60_000,
  );
});
