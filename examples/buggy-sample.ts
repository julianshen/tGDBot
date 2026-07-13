// Throwaway sample used to smoke-test tgd-review-agent's inline review comments.
// Contains deliberate bugs.

export function sumFirstN(values: number[], n: number): number {
  let total = 0;
  // Off-by-one: <= reads one element past the requested count.
  for (let i = 0; i <= n; i++) {
    total += values[i];
  }
  return total;
}

export async function loadConfig(path: string): Promise<unknown> {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(path, "utf-8");
  // No error handling: a malformed file throws an opaque SyntaxError.
  return JSON.parse(raw);
}
