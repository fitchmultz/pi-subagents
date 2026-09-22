import { isDeepStrictEqual } from "node:util";
import type { Usage as NativeUsage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageEndEventResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Details, OwnedRunView, SubagentExecutionResult, UsageContribution } from "../../shared/types.ts";

const PREFIX = "subagent:";
const UNATTRIBUTED = "unattributed";

// Additive public API; official hosts without it use final tool-result usage below.
type UsageAPI = ExtensionAPI & {
	recordUsage?: (contribution: { id: string; kind: string; provider: string; model: string; usage: NativeUsage }) => void;
};

export function finalizedChildUsage(children: OwnedRunView["children"], index?: number): UsageContribution[] {
	return children.flatMap((child) => (index === undefined || child.index === index) && child.state !== "live" && child.state !== "unknown" && !child.result?.detached
		? child.result?.usage.contributions ?? [] : []);
}

function sumUsage(contributions: readonly UsageContribution[]): NativeUsage {
	const total: NativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	for (const { usage } of contributions) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
		// These are subsets of output/cacheWrite, never additional total tokens.
		for (const key of ["reasoning", "cacheWrite1h"] as const) if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
	}
	return total;
}

function sameUsage(a: NativeUsage, b: NativeUsage): boolean {
	return isDeepStrictEqual({ ...a, reasoning: a.reasoning, cacheWrite1h: a.cacheWrite1h }, { ...b, reasoning: b.reasoning, cacheWrite1h: b.cacheWrite1h });
}

function checkContribution(previous: UsageContribution | undefined, next: UsageContribution): void {
	if (previous && ((previous.provider ?? UNATTRIBUTED) !== (next.provider ?? UNATTRIBUTED)
		|| (previous.model ?? UNATTRIBUTED) !== (next.model ?? UNATTRIBUTED) || !sameUsage(previous.usage, next.usage))) {
		throw new Error(`Conflicting subagent usage contribution: ${next.id}`);
	}
}

function uniqueContributions(contributions: readonly UsageContribution[]): UsageContribution[] {
	const unique = new Map<string, UsageContribution>();
	for (const contribution of contributions) {
		if (!contribution.id.trim()) throw new Error("Subagent usage requires a stable native contribution ID");
		checkContribution(unique.get(contribution.id), contribution);
		unique.set(contribution.id, contribution);
	}
	return [...unique.values()];
}

function receipts(entries: SessionEntry[], toolNames: readonly string[], includeNative: boolean): Map<string, UsageContribution> {
	const received = new Map<string, UsageContribution>();
	for (const entry of entries) {
		if (includeNative && entry.type === "usage") {
			const id = (entry as typeof entry & { contributionId?: string }).contributionId;
			if (id?.startsWith(PREFIX)) received.set(id.slice(PREFIX.length), { id: id.slice(PREFIX.length), provider: entry.provider, model: entry.model, usage: entry.usage });
		} else if (entry.type === "message" && entry.message.role === "toolResult" && toolNames.includes(entry.message.toolName)) {
			const contributions = (entry.message.details as Details | undefined)?.parentUsage?.contributions;
			// Details/custom notifications alone are never evidence that native accounting ran.
			if (Array.isArray(contributions) && entry.message.usage && sameUsage(entry.message.usage, sumUsage(contributions))) {
				for (const contribution of contributions) received.set(contribution.id, contribution);
			}
		}
	}
	return received;
}

function unrecorded(contributions: readonly UsageContribution[], received: Map<string, UsageContribution>): UsageContribution[] {
	return uniqueContributions(contributions).filter((contribution) => {
		const previous = received.get(contribution.id);
		checkContribution(previous, contribution);
		return !previous;
	});
}

/**
 * Register once per extension instance. Call record only on finalized completion;
 * false means this host needs an explicit tool wait. Call attach only on final
 * wait/execution results, never inspection or streaming updates. Both take native
 * entry contributions, not aggregate totals or recursively traversed descendants.
 * Include legacy tool aliases in toolNames so old journal receipts still count.
 */
export function registerParentUsage(pi: ExtensionAPI, toolNames: readonly string[]) {
	const api = pi as UsageAPI;
	const record = (contributions: readonly UsageContribution[], ctx: ExtensionContext): boolean => {
		if (!api.recordUsage) return false;
		// Let native idempotence handle its own receipts, including retrying a failed flush.
		const pending = unrecorded(contributions, receipts(ctx.sessionManager.getEntries(), toolNames, false));
		for (const contribution of pending) api.recordUsage({ id: `${PREFIX}${contribution.id}`, kind: "subagent",
			provider: contribution.provider ?? UNATTRIBUTED, model: contribution.model ?? UNATTRIBUTED, usage: contribution.usage });
		return true;
	};

	pi.on("message_end", (event, ctx): MessageEndEventResult | undefined => {
		const message = event.message;
		if (message.role !== "toolResult" || !toolNames.includes(message.toolName)) return;
		const details = message.details as Details | undefined;
		if (!details?.parentUsage) return;
		const pending = unrecorded(details.parentUsage.contributions, receipts(ctx.sessionManager.getEntries(), toolNames, true));
		const { usage: _usage, ...rest } = message;
		const { parentUsage: _parentUsage, ...restDetails } = details;
		// Public replacement hook: native emits/persists final tool messages serially,
		// even for concurrent tools. No in-memory reservation can outlive an aborted result.
		return { message: { ...rest, details: JSON.parse(JSON.stringify({ ...restDetails, ...(pending.length ? { parentUsage: { contributions: pending } } : {}) })),
			...(pending.length ? { usage: sumUsage(pending) } : {}) } };
	});

	return {
		record,
		attach(result: SubagentExecutionResult, contributions: readonly UsageContribution[], ctx: ExtensionContext): SubagentExecutionResult {
			const { usage: _usage, ...rest } = result;
			const { parentUsage: _parentUsage, ...details } = result.details;
			const pending = record(contributions, ctx) ? [] : unrecorded(contributions, receipts(ctx.sessionManager.getEntries(), toolNames, true));
			// Intent only. Top-level usage is added at final message_end, immediately before native persistence.
			return { ...rest, details: { ...details, ...(pending.length ? { parentUsage: { contributions: pending } } : {}) } };
		},
	};
}
