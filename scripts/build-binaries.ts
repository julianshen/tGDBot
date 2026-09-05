// Cross-compiles the single-file binary for every supported target.
//
// Run with `bun run scripts/build-binaries.ts` (npm: `build:binary:all`).
// `--target` makes Bun fetch and cache the matching runtime, so this works
// from any one machine — but see the caveat below, which is the reason this
// script prints a warning rather than pretending otherwise.
import { $ } from "bun";
import { mkdir } from "node:fs/promises";

/**
 * The targets worth shipping. Bun also supports musl and older glibc variants;
 * they are omitted until someone needs one, because every target added is a
 * binary nobody has run.
 */
const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const;

const OUT_DIR = "dist/binaries";

/**
 * `@ast-grep/napi` is a NATIVE module, and the structural checker (#75) is the
 * one feature that depends on it. Bun embeds the `.node` for the platform whose
 * package is installed in `node_modules`, so a cross-compiled binary carries
 * THIS machine's native module rather than the target's.
 *
 * Said out loud rather than discovered later: a Linux binary cross-built on a
 * Mac may start fine and then fail only when a rule attaches a structural
 * claim — the narrowest possible failure window. Build each target on its own
 * platform, or in a matching container, when structural checks matter.
 */
function warnAboutNativeModules(): void {
  console.warn(
    "\n  NOTE: @ast-grep/napi is native. A cross-compiled binary embeds the host's\n" +
    "  build of it, so `--structural-checks on` may fail at runtime on another\n" +
    "  platform. Build on the target platform when that feature matters.\n",
  );
}

await mkdir(OUT_DIR, { recursive: true });
warnAboutNativeModules();

const failures: string[] = [];
for (const target of TARGETS) {
  const suffix = target.includes("windows") ? ".exe" : "";
  const outfile = `${OUT_DIR}/tgd-review-agent-${target.replace("bun-", "")}${suffix}`;
  process.stdout.write(`building ${target} … `);
  try {
    await $`bun build --compile --minify --target=${target} scripts/bun-entry.ts --outfile ${outfile}`.quiet();
    console.log("ok");
  } catch (error) {
    // One target failing must not hide the rest, and must not be mistaken for
    // a target that built: the summary below reports both.
    console.log("FAILED");
    failures.push(`${target}: ${(error as Error).message.split("\n")[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} target(s) failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`\n${TARGETS.length} binaries in ${OUT_DIR}/`);
