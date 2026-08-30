// Issue #60: measuring and classifying the delta between the commit a cached
// graph was built from and the commit under review. Pure parsing and
// classification — git itself is injected.
import { describe, expect, it } from "vitest";
import {
  classifyBaseDelta,
  computeBaseDelta,
  MAX_INCREMENTAL_COMMITS,
  MAX_INCREMENTAL_FILES,
  parseBaseDelta,
  type GitRunner,
} from "../../../src/context/delta.js";

const FROM = "a".repeat(40);
const TO = "b".repeat(40);

function gitRunner(responses: Record<string, string | Error>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const response = responses[key];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected git invocation: ${key}`);
    return { stdout: response };
  };
}

describe("parseBaseDelta", () => {
  it("sorts additions, modifications and deletions into their own sets", () => {
    const delta = parseBaseDelta(
      FROM,
      TO,
      ["A\tsrc/new.ts", "M\tsrc/changed.ts", "D\tsrc/old.ts", "T\tsrc/typed.ts", ""].join("\n"),
      3,
    );
    expect(delta.added).toEqual(["src/new.ts"]);
    expect(delta.changed).toEqual(["src/changed.ts", "src/typed.ts"]);
    expect(delta.deleted).toEqual(["src/old.ts"]);
    expect(delta.commitCount).toBe(3);
  });

  it("treats a rename as a deletion of the old path and an addition of the new one", () => {
    const delta = parseBaseDelta(FROM, TO, "R100\tsrc/old.ts\tsrc/renamed.ts\n", 1);
    expect(delta.deleted).toEqual(["src/old.ts"]);
    expect(delta.added).toEqual(["src/renamed.ts"]);
    expect(delta.changed).toEqual([]);
  });

  it("treats a copy as an addition only", () => {
    const delta = parseBaseDelta(FROM, TO, "C100\tsrc/a.ts\tsrc/b.ts\n", 1);
    expect(delta.deleted).toEqual([]);
    expect(delta.added).toEqual(["src/b.ts"]);
  });
});

describe("classifyBaseDelta", () => {
  it("classifies a small delta as incremental", () => {
    const delta = parseBaseDelta(FROM, TO, "M\tsrc/a.ts\n", 1);
    expect(classifyBaseDelta(delta, new Set()).kind).toBe("incremental");
  });

  it("fails to full remap past the file ceiling", () => {
    const nameStatus = Array.from(
      { length: MAX_INCREMENTAL_FILES + 1 },
      (_, index) => `M\tsrc/file-${index}.ts`,
    ).join("\n");
    const classified = classifyBaseDelta(parseBaseDelta(FROM, TO, nameStatus, 1), new Set());
    expect(classified.kind).toBe("full");
    expect(classified.reason).toMatch(/ceiling/);
  });

  it("fails to full remap past the commit ceiling", () => {
    const classified = classifyBaseDelta(
      parseBaseDelta(FROM, TO, "M\tsrc/a.ts\n", MAX_INCREMENTAL_COMMITS + 1),
      new Set(),
    );
    expect(classified.kind).toBe("full");
    expect(classified.reason).toMatch(/commits/);
  });

  it("fails to full remap when a domain-graph flow step file is touched", () => {
    const classified = classifyBaseDelta(
      parseBaseDelta(FROM, TO, "M\tsrc/checkout.ts\nM\tsrc/other.ts\n", 1),
      new Set(["src/checkout.ts"]),
    );
    expect(classified.kind).toBe("full");
    expect(classified.reason).toMatch(/domain-graph flow step/);
  });
});

describe("computeBaseDelta", () => {
  it("runs ancestry, name-status and commit count, and classifies the result", async () => {
    const classified = await computeBaseDelta(
      gitRunner({
        [`merge-base --is-ancestor ${FROM} ${TO}`]: "",
        [`diff --name-status -M ${FROM} ${TO}`]: "M\tsrc/a.ts\n",
        [`rev-list --count ${FROM}..${TO}`]: "2\n",
      }),
      FROM,
      TO,
      new Set(),
    );
    expect(classified.kind).toBe("incremental");
    expect(classified.delta.commitCount).toBe(2);
  });

  it("classifies full when the cached base is not an ancestor (rewritten history)", async () => {
    const classified = await computeBaseDelta(
      gitRunner({
        [`merge-base --is-ancestor ${FROM} ${TO}`]: Object.assign(new Error("exit 1"), { code: 1 }),
      }),
      FROM,
      TO,
      new Set(),
    );
    expect(classified.kind).toBe("full");
    expect(classified.reason).toMatch(/not an ancestor/);
  });

  it("throws on a git failure that is not an ancestry answer", async () => {
    await expect(computeBaseDelta(
      gitRunner({
        [`merge-base --is-ancestor ${FROM} ${TO}`]: Object.assign(new Error("not found"), { code: 128 }),
      }),
      FROM,
      TO,
      new Set(),
    )).rejects.toThrow(/not found/);
  });
});
