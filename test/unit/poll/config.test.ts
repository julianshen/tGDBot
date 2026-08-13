import { describe, expect, it } from "vitest";
import { parseCommandArgs } from "../../../src/cli-args.js";

describe("poll command configuration", () => {
  it("accepts an absolute --state-dir", () => {
    expect(parseCommandArgs([
      "poll", "--repo", "owner/repo", "--state-dir", "/tmp/tgd-state",
    ])).toMatchObject({ stateDir: "/tmp/tgd-state" });
  });

  it.each(["relative/state", ""])("rejects non-absolute --state-dir %j", (stateDir) => {
    expect(() => parseCommandArgs([
      "poll", "--repo", "owner/repo", "--state-dir", stateDir,
    ])).toThrow(/--state-dir/);
  });
});
