import type { ForegroundControlState, TimeoutExtensionCallback, TimeoutExtensionResult } from "../../shared/types.ts";

export interface ForegroundTimeoutExtensionRegistry {
	register(key: string, extend: TimeoutExtensionCallback): () => void;
}

function aggregateTimeoutExtensions(
	callbacks: Map<string, TimeoutExtensionCallback>,
	control: ForegroundControlState,
	additionalMs: number,
): TimeoutExtensionResult {
	if (callbacks.size === 0) return { ok: false, message: "This foreground run does not currently have an active child timeout to extend." };
	let extended = 0;
	let timeoutAt: number | undefined;
	const failures: string[] = [];
	for (const extend of callbacks.values()) {
		const result = extend(additionalMs);
		if (result.ok) {
			extended++;
			if (result.timeoutAt !== undefined) timeoutAt = Math.max(timeoutAt ?? 0, result.timeoutAt);
		} else {
			failures.push(result.message);
		}
	}
	if (extended > 0) {
		if (timeoutAt !== undefined) control.timeoutAt = timeoutAt;
		return {
			ok: true,
			...(timeoutAt !== undefined ? { timeoutAt } : {}),
			message: `Extended ${extended} active child timeout${extended === 1 ? "" : "s"}.`,
		};
	}
	return { ok: false, message: failures[0] ?? "This foreground run does not currently have an active child timeout to extend." };
}

export function createForegroundTimeoutExtensionRegistry(control: ForegroundControlState | undefined): ForegroundTimeoutExtensionRegistry {
	const callbacks = new Map<string, TimeoutExtensionCallback>();
	const refresh = () => {
		if (!control) return;
		control.extendTimeout = callbacks.size > 0
			? (additionalMs: number) => aggregateTimeoutExtensions(callbacks, control, additionalMs)
			: undefined;
		control.updatedAt = Date.now();
	};
	return {
		register(key: string, extend: TimeoutExtensionCallback): () => void {
			callbacks.set(key, extend);
			refresh();
			return () => {
				callbacks.delete(key);
				refresh();
			};
		},
	};
}
