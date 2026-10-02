import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent, MessageEndEventResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { OwnedRunView, SubagentExecutionResult, UsageContribution } from "../../src/shared/types.ts";
import { finalizedChildUsage, registerParentUsage } from "../../src/runs/shared/parent-usage.ts";

const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 15, reasoning: 5,
	totalTokens: 100, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const a: UsageContribution = { id: "child:a", provider: "provider", model: "actual-response", usage };
const b: UsageContribution = { id: "child:b", usage };
const result = (): SubagentExecutionResult => ({ content: [{ type: "text", text: "done" }], details: { mode: "management", results: [] } });

function harness() {
	let messageEnd!: (event: MessageEndEvent, ctx: ExtensionContext) => MessageEndEventResult | undefined;
	const entries: SessionEntry[] = [];
	const pi = { on(event: string, handler: typeof messageEnd) { assert.equal(event, "message_end"); messageEnd = handler; } } as unknown as ExtensionAPI;
	const ctx = { sessionManager: { getSessionId: () => "parent", getEntries: () => entries, getSessionFile: () => undefined, getEntry: (id: string) => entries.find((entry) => entry.id === id) } } as unknown as ExtensionContext;
	const adapter = registerParentUsage(pi, ["delegate", "agent_runs"]);
	const finalize = (value: SubagentExecutionResult) => {
		const message = { ...value, role: "toolResult", toolName: "agent_runs", toolCallId: "wait", isError: false, timestamp: 0 } as const;
		return messageEnd({ type: "message_end", message }, ctx)?.message ?? message;
	};
	const persist = (message: ReturnType<typeof finalize>) => entries.push({ type: "message", id: String(entries.length), parentId: null, timestamp: new Date().toISOString(), message });
	return { adapter, ctx, entries, finalize, persist };
}

test("select finalized siblings by their actual index and read only their own native delta", () => {
	const child = (index: number, state: OwnedRunView["children"][number]["state"], contributions: UsageContribution[]) => ({ index, state, agent: "worker", configuration: "legacy-partial" as const,
		result: { agent: "worker", task: "work", exitCode: 0, usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 1000, turns: 1, contributions },
			modelAttempts: [{ model: "fallback", success: true, usage: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0, cost: 9, turns: 1, contributions: [a] } }] } });
	const children = [child(7, "completed", [a]), child(2, "live", [b]), child(4, "failed", [b]), child(0, "unknown", [a])];
	const before = structuredClone(children);
	assert.deepEqual(finalizedChildUsage(children, 4), [b], "filtered result array position is not the child slot");
	assert.deepEqual(finalizedChildUsage(children), [a, b], "failed work still costs; attempts and nested rollups are not counted again");
	assert.deepEqual(finalizedChildUsage(children, 2), []);
	assert.deepEqual(children, before, "inspection/selection is pure");
});

test("portable final usage preserves every native counter and sums subsets only once", () => {
	const h = harness();
	const prepared = h.adapter.attach(result(), [a, a, b], h.ctx);
	assert.equal(prepared.usage, undefined, "preparation is intent, not a charge");
	assert.equal(h.entries.length, 0);
	const message = h.finalize(prepared);
	assert.equal(message.role, "toolResult");
	assert.deepEqual(message.usage, { input: 20, output: 40, cacheRead: 60, cacheWrite: 80, reasoning: 10, cacheWrite1h: 30, totalTokens: 200,
		cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 } });
	assert.deepEqual(message.details.parentUsage.contributions, [a, b]);
	assert.equal(h.entries.length, 0, "even message_end is not a receipt until native stores the message");
	assert.deepEqual(h.finalize(prepared).usage, message.usage, "a dropped persistence attempt remains chargeable");
	h.persist(message);
	assert.equal(h.finalize(prepared).usage, undefined, "replayed completion sees the persisted receipt");
	assert.equal(h.adapter.attach(result(), [a, b], h.ctx).details.parentUsage, undefined);
});

test("details alone, custom messages and mismatched top-level usage are not portable receipts", () => {
	const h = harness();
	const prepared = h.adapter.attach(result(), [a], h.ctx);
	h.persist({ ...h.finalize(prepared), usage: undefined });
	h.entries.push({ type: "custom_message", id: "notice", parentId: null, timestamp: "now", customType: "subagent-notify", content: "done", display: false, details: { result: prepared } });
	h.persist({ ...h.finalize(prepared), usage: { ...usage, output: 999 } });
	assert.deepEqual(h.finalize(prepared).usage, usage);
	h.persist(h.finalize(prepared));
	assert.equal(h.finalize(prepared).usage, undefined);
});

test("legacy native usage and finalized portable receipts deduplicate new finalized results", () => {
	const h = harness();
	h.persist(h.finalize(h.adapter.attach(result(), [a], h.ctx)));
	h.entries.push({ type: "usage", id: "native", parentId: null, timestamp: "now", kind: "subagent", provider: "unattributed", model: "unattributed", usage, contributionId: "subagent:child:b" } as SessionEntry);
	assert.equal(h.adapter.attach(result(), [a, b], h.ctx).details.parentUsage, undefined);
	assert.equal(h.adapter.isRecorded([a, b], h.ctx, new Map(h.entries.map((entry) => [entry.id, entry]))), true);
});

test("conflicting repeated native IDs fail before accounting and optional undefined fields survive JSON receipts", () => {
	const h = harness();
	assert.throws(() => h.adapter.attach(result(), [a, { ...a, model: "other" }], h.ctx), /conflict/i);
	assert.throws(() => h.adapter.attach(result(), [{ ...a, id: "" }], h.ctx), /stable native contribution ID/);
	const optional = { ...a, usage: { ...usage, reasoning: undefined, cacheWrite1h: undefined } };
	h.persist(h.finalize(h.adapter.attach(result(), [optional], h.ctx)));
	assert.equal(h.adapter.attach(result(), [optional], h.ctx).details.parentUsage, undefined);
	assert.throws(() => h.adapter.attach(result(), [a], h.ctx), /conflict/i);
});
