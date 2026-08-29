// Codex review, round 8. `cli.ts` imports the structural-check module
// unconditionally, and the module used to evaluate `Lang.TypeScript` at load —
// so on any platform `@ast-grep/napi` ships no prebuilt binary for (Linux
// ppc64/s390x, FreeBSD, anything outside its nine optional packages) EVERY
// command died at startup, over a feature that defaults to off.
//
// Its own file, because it has to mock the native module before the import and
// reset the module registry, which would leak into the main suite.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@ast-grep/napi");
  vi.resetModules();
});

describe("structural-check without a usable native parser", () => {
  it("still loads, and claim parsing still works", async () => {
    vi.resetModules();
    vi.doMock("@ast-grep/napi", () => {
      throw new Error("Cannot find module '@ast-grep/napi-linux-ppc64-gnu'");
    });

    // The import itself is the assertion: this used to throw.
    const mod = await import("../../../src/review/structural-check.js");

    expect(mod.parseStructuralClaim({ kind: "no-other-references", symbol: "budget" }))
      .toEqual({ kind: "no-other-references", symbol: "budget" });
  });

  it("degrades to not-checked instead of failing the review", async () => {
    vi.resetModules();
    vi.doMock("@ast-grep/napi", () => {
      throw new Error("Cannot find module '@ast-grep/napi-linux-ppc64-gnu'");
    });

    const { runStructuralChecks } = await import("../../../src/review/structural-check.js");
    const output = await runStructuralChecks({
      findings: [{
        file: "src/retry.ts",
        severity: "blocking",
        category: "correctness",
        message: "budget() is never called.",
        ruleName: "rule-a",
        claim: { kind: "no-other-references" as const, symbol: "budget" },
      }],
      baseRoot: process.cwd(),
    });

    // The finding is still published; only the check is missing, with a reason.
    expect(output).toHaveLength(1);
    expect(output[0]?.hostCheck?.status).toBe("not-checked");
    expect((output[0]?.hostCheck as { reason: string }).reason).toMatch(/not available on this platform/);
  });
});
