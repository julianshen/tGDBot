// Throwaway sample to smoke-test committable suggestions. Deliberate bug.

export function sumFirstN(values: number[], n: number): number {
  let total = 0;
  for (let i = 0; i <= n; i++) {
    total += values[i];
  }
  return total;
}
