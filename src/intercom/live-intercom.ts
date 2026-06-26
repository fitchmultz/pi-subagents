import { randomUUID } from "node:crypto";
import {
	SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT,
	SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT,
	SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_LIVE_INTERCOM_EVENT,
	type IntercomEventBus,
	type SubagentLiveIntercomHealth,
} from "../shared/types.ts";

export async function sendLiveSubagentMessage(events: IntercomEventBus, input: {
	to: string;
	message: string;
	delivery?: "steer" | "queue";
	timeoutMs?: number;
	extra?: Record<string, unknown>;
}): Promise<{ delivered: boolean; reason?: string }> {
	if (typeof events.on !== "function" || typeof events.emit !== "function") return { delivered: false, reason: "pi-intercom bridge unavailable" };
	const requestId = randomUUID();
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: { delivered: boolean; reason?: string }) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			unsubscribe?.();
			resolve(result);
		};
		unsubscribe = events.on(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			const payload = data as { requestId?: unknown; delivered?: unknown; reason?: unknown };
			if (payload.requestId !== requestId) return;
			finish({ delivered: payload.delivered === true, ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}) });
		});
		timer = setTimeout(() => finish({ delivered: false, reason: "pi-intercom bridge unavailable" }), input.timeoutMs ?? 500);
		try {
			events.emit(SUBAGENT_LIVE_INTERCOM_EVENT, {
				...input.extra,
				requestId,
				to: input.to,
				message: input.message,
				delivery: input.delivery ?? "steer",
			});
		} catch (error) {
			finish({ delivered: false, reason: error instanceof Error ? error.message : String(error) });
		}
	});
}

export async function queryLiveIntercomHealth(events: IntercomEventBus, targets: string[], timeoutMs = 300): Promise<Map<string, SubagentLiveIntercomHealth>> {
	const uniqueTargets = [...new Set(targets.map((target) => target.trim()).filter(Boolean))];
	if (uniqueTargets.length === 0 || typeof events.on !== "function" || typeof events.emit !== "function") return new Map();
	const requestId = randomUUID();
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (items: SubagentLiveIntercomHealth[] = []) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			unsubscribe?.();
			resolve(new Map(items.map((item) => [item.target, item])));
		};
		unsubscribe = events.on(SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			const payload = data as { requestId?: unknown; health?: unknown };
			if (payload.requestId !== requestId || !Array.isArray(payload.health)) return;
			finish(payload.health.filter((item): item is SubagentLiveIntercomHealth => Boolean(item && typeof item === "object" && typeof (item as { target?: unknown }).target === "string")));
		});
		timer = setTimeout(() => finish(), timeoutMs);
		try {
			events.emit(SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT, { requestId, targets: uniqueTargets });
		} catch {
			finish();
		}
	});
}
