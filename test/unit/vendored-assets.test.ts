// The two files the tool ships with and reads at runtime. On Node they come
// off disk; inside a single-file binary there is no directory to read, so the
// build embeds them and hands the text to the same seam.
//
// The failure this guards against is silent in the worst way: an unread
// builtin rule means a review starts with zero rules and aborts, and an
// unseeded `reviewer` agent means the dispatched subagent keeps the
// bash/edit/write tools ADR-003 exists to deny it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  provideVendoredAsset,
  vendoredAssetContents,
  vendoredAssetPath,
} from "../../src/vendored-assets.js";

const onDisk = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${relative}`, import.meta.url)), "utf-8");

describe("vendored assets", () => {
  it("reads the builtin rule off disk when nothing was provided", () => {
    expect(vendoredAssetContents("builtin-rule")).toBe(onDisk("rules/builtin/tgd-review.md"));
  });

  it("reads the reviewer agent off disk when nothing was provided", () => {
    // Byte-for-byte, because this file's `tools:` line is the ADR-003
    // guarantee. A truncated or re-encoded copy could still parse and still
    // grant more than `read, grep, find, ls`.
    expect(vendoredAssetContents("reviewer-agent")).toBe(onDisk("review/builtin-agents/reviewer.md"));
  });

  it("still reports a path, for error messages that name a file to go and look at", () => {
    expect(vendoredAssetPath("builtin-rule")).toMatch(/rules[/\\]builtin[/\\]tgd-review\.md$/u);
  });

  it("refuses empty contents rather than accepting an asset that says nothing", () => {
    // An empty builtin rule would load as a rule with no body and review
    // nothing, which is worse than failing to load at all.
    expect(() => provideVendoredAsset("builtin-rule", "")).toThrow(/provided empty/);
  });

  // LAST in the file, deliberately: the registry is process-global and there is
  // no way to withdraw an entry — which is correct for its real use, where the
  // binary populates it once before anything runs. Any test needing the disk
  // path must come above this one.
  it("prefers provided contents over the file on disk", () => {
    provideVendoredAsset("builtin-rule", "---\nname: embedded\n---\n\nbody\n");
    expect(vendoredAssetContents("builtin-rule")).toContain("name: embedded");
    // The other asset is untouched: providing one does not shadow the rest.
    expect(vendoredAssetContents("reviewer-agent")).toBe(onDisk("review/builtin-agents/reviewer.md"));
  });
});
