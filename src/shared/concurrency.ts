import type { ReadonlyInput } from "./types/inputs.ts";

/** A bounded worker pool. Results retain input order even when workers finish out of order. */
export async function mapConcurrent<T, R>(
  items: readonly ReadonlyInput<T>[],
  limit: number,
  fn: (item: ReadonlyInput<T>, index: number) => Promise<R>,
): Promise<R[]> {
  const integralLimit = Math.floor(limit);
  const safeLimit = Math.max(
    1,
    Number.isNaN(integralLimit) || integralLimit === 0 ? 1 : integralLimit,
  );
  const results: R[] = [];
  results.length = items.length;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      // Each worker awaits its own task before claiming another, bounding active work.
      // oxlint-disable-next-line no-await-in-loop
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, () => worker()));
  return results;
}
