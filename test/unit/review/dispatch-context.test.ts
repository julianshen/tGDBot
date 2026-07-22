import { describe, expect, it } from "vitest";
import type { ContextPackResult } from "../../../src/context/context-pack.js";
import {
  DispatchInputError,
  validateDispatchContext,
} from "../../../src/review/dispatch-context.js";
import type { EffectiveRule } from "../../../src/rules/types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeRule(name: string): EffectiveRule {
  return {
    name,
    provider: "openai",
    model: "gpt-5.6-terra",
    body: `Review ${name}.`,
    sourcePath: `/rules/${name}.md`,
  };
}

function makePack(text: string, manifestHash = HASH_A): ContextPackResult {
  return { text, manifestHash, truncated: false, sources: [] };
}

describe("validateDispatchContext", () => {
  it("AC-1.1: maps each exact own rule key and returns the common hash without mutation", () => {
    const rules = [makeRule("correctness"), makeRule("security")];
    const correctness = Object.freeze(makePack("correctness evidence"));
    const security = Object.freeze(makePack("security evidence"));
    const packs = Object.freeze({ correctness, security });
    const before = JSON.stringify(packs);

    const result = validateDispatchContext(rules, packs);

    expect(result.manifestHash).toBe(HASH_A);
    expect(result.packsByRule?.get("correctness")).toBe(correctness);
    expect(result.packsByRule?.get("security")).toBe(security);
    expect(JSON.stringify(packs)).toBe(before);
  });

  it.each([
    ["missing key", { correctness: makePack("a") }],
    [
      "extra key",
      { correctness: makePack("a"), security: makePack("b"), performance: makePack("c") },
    ],
    ["blank text", { correctness: makePack(" \n"), security: makePack("b") }],
    ["uppercase hash", { correctness: makePack("a", "A".repeat(64)), security: makePack("b") }],
    ["short hash", { correctness: makePack("a", "a".repeat(63)), security: makePack("b") }],
    ["mixed hashes", { correctness: makePack("a", HASH_A), security: makePack("b", HASH_B) }],
    ["null pack", { correctness: null, security: makePack("b") }],
  ])("AC-1.2: rejects a %s contextual map", (_label, packs) => {
    expect(() =>
      validateDispatchContext(
        [makeRule("correctness"), makeRule("security")],
        packs as unknown as Record<string, ContextPackResult>,
      ),
    ).toThrow(DispatchInputError);
  });

  it("AC-1.2: rejects inherited enumerable keys even when all required own keys exist", () => {
    const packs = Object.assign(Object.create({ inherited: makePack("outside") }), {
      correctness: makePack("a"),
      security: makePack("b"),
    }) as Record<string, ContextPackResult>;

    expect(() =>
      validateDispatchContext([makeRule("correctness"), makeRule("security")], packs),
    ).toThrow(DispatchInputError);
  });

  it("AC-1.2: rejects inherited-only values instead of accepting them for a rule", () => {
    const packs = Object.create({ correctness: makePack("inherited") }) as Record<
      string,
      ContextPackResult
    >;

    expect(() => validateDispatchContext([makeRule("correctness")], packs)).toThrow(
      DispatchInputError,
    );
  });

  it("AC-1.2: rejects duplicate effective rule names in contextualized mode", () => {
    expect(() =>
      validateDispatchContext(
        [makeRule("correctness"), makeRule("correctness")],
        { correctness: makePack("a") },
      ),
    ).toThrow(DispatchInputError);
  });

  it("AC-1.4: keeps omitted packs explicitly context-free", () => {
    const result = validateDispatchContext(
      [makeRule("correctness"), makeRule("correctness")],
      undefined,
    );

    expect(result).toEqual({});
  });

  it("AC-1.2: accepts an explicit empty map only when no effective rules exist", () => {
    expect(validateDispatchContext([], {})).toEqual({
      packsByRule: new Map(),
      manifestHash: undefined,
    });
    expect(() => validateDispatchContext([makeRule("correctness")], {})).toThrow(
      DispatchInputError,
    );
  });
});
