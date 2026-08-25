// Issue #50, the fetch layer. Every test injects the fetcher, so the suite
// never touches the network — the same discipline the VCS adapters follow.
import { describe, expect, it, vi } from "vitest";
import { fetchDependencyFacts } from "../../../src/review/dependency-facts.js";
import type { DependencyChange } from "../../../src/review/dependency-changes.js";

const change = (name: string, version: string): DependencyChange => ({
  name,
  version,
  manifest: "package.json",
});

const registry = (body: Record<string, unknown>) => vi.fn(async () => body);

describe("fetchDependencyFacts", () => {
  it("asks the fixed registry host, with the name encoded", async () => {
    const fetchJson = registry({ "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} } });

    await fetchDependencyFacts([change("@scope/pkg", "4.17.21")], fetchJson);

    expect(fetchJson).toHaveBeenCalledWith("https://registry.npmjs.org/%40scope%2Fpkg");
  });

  it("reports the latest version", async () => {
    const fetchJson = registry({
      "dist-tags": { latest: "4.17.21" },
      versions: { "4.17.20": {}, "4.17.21": {} },
    });

    const [fact] = await fetchDependencyFacts([change("lodash", "4.17.20")], fetchJson);

    expect(fact).toMatchObject({ name: "lodash", version: "4.17.20", latest: "4.17.21" });
  });

  it("reports a deprecated version", async () => {
    const fetchJson = registry({
      "dist-tags": { latest: "2.0.0" },
      versions: { "1.0.0": { deprecated: "no longer maintained" }, "2.0.0": {} },
    });

    const [fact] = await fetchDependencyFacts([change("pkg", "1.0.0")], fetchJson);

    expect(fact?.deprecated).toBe("no longer maintained");
  });

  // A version the registry does not publish is worth saying out loud — it is
  // either a typo or something the registry withdrew.
  it("flags a version the registry does not publish", async () => {
    const fetchJson = registry({ "dist-tags": { latest: "2.0.0" }, versions: { "2.0.0": {} } });

    const [fact] = await fetchDependencyFacts([change("pkg", "9.9.9")], fetchJson);

    expect(fact?.published).toBe(false);
  });

  // THE outage rule: a review that could not check must say so, never imply it
  // checked and found nothing.
  it("records a failure as unknown rather than as nothing to report", async () => {
    const fetchJson = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    const [fact] = await fetchDependencyFacts([change("pkg", "1.0.0")], fetchJson);

    expect(fact?.unknown).toMatch(/ECONNRESET|could not/i);
    expect(fact?.latest).toBeUndefined();
  });

  it("keeps resolving the rest when one lookup fails", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith("/broken")) throw new Error("HTTP 500");
      return { "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": {} } };
    });

    const facts = await fetchDependencyFacts(
      [change("broken", "1.0.0"), change("fine", "1.0.0")],
      fetchJson,
    );

    expect(facts.find((f) => f.name === "broken")?.unknown).toBeDefined();
    expect(facts.find((f) => f.name === "fine")?.latest).toBe("2.0.0");
  });

  it("treats a malformed registry response as unknown", async () => {
    for (const body of [null, "text", { versions: "nope" }, {}]) {
      const [fact] = await fetchDependencyFacts([change("pkg", "1.0.0")], vi.fn(async () => body));

      expect(fact?.unknown, `${JSON.stringify(body)} was trusted`).toBeDefined();
    }
  });

  // One request per PACKAGE, not per occurrence: a monorepo names the same
  // dependency in several manifests.
  it("asks about each package once", async () => {
    const fetchJson = registry({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } });

    const facts = await fetchDependencyFacts(
      [
        { name: "lodash", version: "1.0.0", manifest: "package.json" },
        { name: "lodash", version: "1.0.0", manifest: "web/package.json" },
      ],
      fetchJson,
    );

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(facts).toHaveLength(1);
  });

  it("makes no request at all when nothing changed", async () => {
    const fetchJson = vi.fn(async () => ({}));

    expect(await fetchDependencyFacts([], fetchJson)).toEqual([]);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  // Defence in depth: the parser cannot produce an invalid name, so this is
  // reachable only by a caller skipping it.
  it("refuses to request an invalid package name", async () => {
    const fetchJson = vi.fn(async () => ({}));

    const [fact] = await fetchDependencyFacts(
      [{ name: "../etc/passwd", version: "1.0.0", manifest: "package.json" }],
      fetchJson,
    );

    expect(fetchJson).not.toHaveBeenCalled();
    expect(fact?.unknown).toMatch(/name/i);
    // registryUrlFor would throw too, so "no request happened" passes either
    // way. What distinguishes the explicit check is the REASON: an invalid name
    // is not a network problem, and reporting it as one would send an operator
    // looking at their proxy.
    expect(fact?.unknown).not.toMatch(/could not be reached/i);
  });
});
