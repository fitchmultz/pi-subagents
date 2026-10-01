import { setImmediate as yieldToInput } from "node:timers/promises";

export function runSynchronously<T>(steps: Generator<void, T>): T {
	let step = steps.next();
	while (!step.done) step = steps.next();
	return step.value;
}

/** Batched recovery and delivery leave room for input between records. */
export async function runCooperatively<T>(steps: Generator<void, T>): Promise<T> {
	let step = steps.next();
	for (let count = 0; !step.done; step = steps.next()) {
		// ponytail: one recovery record remains atomic; move a demonstrated
		// single-record stall off-thread rather than increasing this batch size.
		if (++count === 32) {
			await yieldToInput();
			count = 0;
		}
	}
	return step.value;
}
