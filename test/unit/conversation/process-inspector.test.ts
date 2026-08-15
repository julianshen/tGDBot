import { describe, expect, it, vi } from "vitest";
import { createDefaultProcessInspector } from "../../../src/conversation/process-inspector.js";

const LSTART = "Thu Aug 14 00:00:00 2026";

describe("createDefaultProcessInspector on darwin", () => {
  // Every lock acquisition asks for the current process identity, and on darwin
  // that means spawning `ps`. A poll run takes the lock many times, so without
  // caching one review turns into a stream of subprocesses. The identity of a
  // running process cannot change, so it only ever needs looking up once.
  it("looks up the current process identity once and reuses it", async () => {
    const exec = vi.fn(async () => ({ stdout: LSTART, stderr: "" }));
    const inspector = createDefaultProcessInspector("darwin", 4242, "host", { exec });

    const first = await inspector.current();
    const second = await inspector.current();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.startIdentity).toContain("Thu Aug 14");
  });

  // A subprocess that never returns has no timeout of its own, so an unbounded
  // wait here becomes an unbounded wait for the lock: no CPU use, no error, no
  // diagnostic. Reporting `unknown` is the safe answer — it means "do not
  // reclaim this lock" rather than "the owner is gone".
  it("reports unknown rather than waiting forever when ps does not return", async () => {
    const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>(() => {}));
    const inspector = createDefaultProcessInspector("darwin", 4242, "host", {
      exec,
      timeoutMs: 20,
    });

    await expect(inspector.inspect(99)).resolves.toEqual({ status: "unknown" });
  });

  it("fails closed when the current identity cannot be established", async () => {
    const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>(() => {}));
    const inspector = createDefaultProcessInspector("darwin", 4242, "host", {
      exec,
      timeoutMs: 20,
    });

    await expect(inspector.current()).rejects.toThrow(/fails closed/i);
  });
});
