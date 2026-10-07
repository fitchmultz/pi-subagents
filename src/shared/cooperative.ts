import { setImmediate as yieldToInput } from "node:timers/promises";

export function runSynchronously<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (step.done !== true) {
    step = steps.next();
  }
  return step.value;
}

/** Batched recovery and delivery leave room for input between records. */
export async function runCooperatively<T>(steps: Generator<void, T>): Promise<T> {
  let step = steps.next();
  for (let count = 0; step.done !== true; step = steps.next()) {
    // ponytail: one recovery record remains atomic; move a demonstrated
    // single-record stall off-thread rather than increasing this batch size.
    if (++count === 32) {
      // Yield between ordered atomic recovery records; concurrency would reorder delivery.
      // oxlint-disable-next-line no-await-in-loop
      await yieldToInput();
      count = 0;
    }
  }
  return step.value;
}
