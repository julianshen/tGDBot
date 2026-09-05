// The two files this tool ships with and reads at RUNTIME: the builtin review
// rule, and the restricted `reviewer` agent definition that ADR-003 relies on
// to deny the dispatched subagent bash/edit/write.
//
// Both used to be handled as PATHS resolved from `import.meta.url`, which works
// for `node dist/cli.js` because the build copies them next to the compiled
// output. It does not work inside a single-file binary, where there is no
// directory to copy them next to: the paths resolve into the virtual
// filesystem and the reads fail — silently producing a review with zero rules
// loaded, which aborts, and an agent definition that cannot be seeded.
//
// So the unit here is CONTENTS, not a path. On Node the contents come from
// disk exactly as before. A bundler that cannot ship a directory calls
// `provideVendoredAsset` before anything else runs, and the reads never happen.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type VendoredAsset = "builtin-rule" | "reviewer-agent";

/**
 * Where each asset lives relative to this module, for the ordinary Node build.
 *
 * `import.meta.url` rather than `process.cwd()`, so it resolves the same run
 * from `src/` under vitest and from `dist/` after `npm run build`.
 */
const ASSET_PATHS: Readonly<Record<VendoredAsset, string>> = {
  "builtin-rule": fileURLToPath(new URL("./rules/builtin/tgd-review.md", import.meta.url)),
  "reviewer-agent": fileURLToPath(new URL("./review/builtin-agents/reviewer.md", import.meta.url)),
};

const provided = new Map<VendoredAsset, string>();

/**
 * Supplies an asset's contents, for a build with no directory to read from.
 *
 * Must be called before the review flow starts. Deliberately NOT a fallback
 * for a failed read: a missing file in the Node build is a broken install, and
 * quietly substituting an embedded copy would hide that while shipping a rule
 * the operator's `dist/` does not actually contain.
 */
export function provideVendoredAsset(asset: VendoredAsset, contents: string): void {
  if (contents.length === 0) throw new Error(`vendored asset "${asset}" was provided empty`);
  provided.set(asset, contents);
}

/** The asset's text: whatever was provided, else the file on disk. */
export function vendoredAssetContents(asset: VendoredAsset): string {
  const embedded = provided.get(asset);
  if (embedded !== undefined) return embedded;
  return readFileSync(ASSET_PATHS[asset], "utf-8");
}

/**
 * The on-disk path, for the one caller that still needs a name rather than
 * text: the temp-directory seeding in `session-hermetics`, whose error
 * messages quote it.
 */
export function vendoredAssetPath(asset: VendoredAsset): string {
  return ASSET_PATHS[asset];
}
