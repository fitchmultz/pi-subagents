import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { OwnedRun } from "../../src/shared/types.ts";
import { createEventBus } from "../support/helpers.ts";

const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
process.env.PI_PACKAGE_DIR = sdkRoot;
const { SessionManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const { createCompletionDelivery } = await import("../../src/runs/background/completion-delivery.ts");
const { registerParentUsage } = await import("../../src/runs/shared/parent-usage.ts");
const { createParentReceiptReader } = await import("../../src/runs/shared/parent-receipts.ts");
const { saveAsyncRunResult, getRunMetadataDir } = await import("../../src/runs/shared/supervisor-questions.ts");
const { JsonProjection } = await import("../../src/shared/journal-reader.ts");

test("resuming legacy delivered runs parses old parent receipts once and never rehydrates unrelated output or resends completions", async (t) => {
	const root = fs.mkdtempSync(path.join(tmpdir(), "subagent-resume-cost-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const manager = SessionManager.create(root, path.join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "Synthetic isolated session", timestamp: Date.now() });
	for (let index = 0; index < 6; index++) manager.appendMessage({ role: "toolResult", toolName: "subagent",
		toolCallId: `old-${index}`, timestamp: Date.now(), content: [{ type: "text", text: "historical result" }],
		details: { blob: "x".repeat(256 * 1024) } });
	const runs = new Map<string, OwnedRun>(), recorded: string[] = [], usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	for (let index = 0; index < 8; index++) {
		const runId = `resume-${path.basename(root)}-${index}`, completionId = `done-${index}`;
		t.after(() => fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true }));
		const run: OwnedRun = { runId, rootRunId: runId, ownerSessionId: manager.getSessionId(), source: "async", mode: "single",
			cwd: root, task: "Synthetic work", startedAt: Date.now(), children: [{ agent: "worker", index: 0 }],
			delivery: { notifiedAt: Date.now(), intercomDelivered: true } };
		manager.appendCustomEntry("subagent-run", run);
		manager.appendCustomMessageEntry("intercom_message", "Already delivered", true, { subagentCompletion: { runId, completionId } });
		saveAsyncRunResult(runId, { id: runId, completionId, mode: "single", sessionId: manager.getSessionId(), state: "complete",
			success: true, timestamp: Date.now(), results: [{ agent: "worker", success: true, exitCode: 0, output: "Finished",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1,
					contributions: [{ id: `native-${index}`, provider: "faux", model: "faux", usage }] } }] });
		runs.set(runId, run);
	}
	const fileBytes = fs.statSync(manager.getSessionFile()!).size;
	let parsedChars = 0, historicalLookups = 0, ownerWrites = 0, sent = 0, ownerWritesAtInput: number | undefined;
	const write = JsonProjection.prototype.write;
	t.mock.method(JsonProjection.prototype, "write", function (chunk: string | symbol) {
		if (typeof chunk === "string") parsedChars += chunk.length;
		return write.call(this, chunk);
	});
	const getEntry = manager.getEntry.bind(manager);
	t.mock.method(manager, "getEntry", (id: string) => { historicalLookups++; return getEntry(id); });
	const pi = { on() {}, events: createEventBus(), sendMessage() { sent++; },
		recordUsage(contribution: { id: string }) { recorded.push(contribution.id); } } as unknown as Parameters<typeof createCompletionDelivery>[0];
	const state = { currentSessionId: manager.getSessionId(), ownedRuns: runs, foregroundRuns: new Map(), completionSeen: new Map(),
		lastUiContext: { cwd: root, sessionManager: manager, isIdle: () => true, hasPendingMessages: () => false },
		persistOwnedRun(run: unknown) {
			ownerWrites++;
			if (ownerWrites === 1) setImmediate(() => { ownerWritesAtInput = ownerWrites; });
			manager.appendCustomEntry("subagent-run", run);
		} } as Parameters<typeof createCompletionDelivery>[1];
	const delivery = createCompletionDelivery(pi, state, registerParentUsage(pi, ["subagent", "delegate", "agent_runs"]));
	try {
		delivery.start();
		const deadline = performance.now() + 5000;
		while ([...runs.values()].some((run) => run.accounting?.state !== "complete" || !run.delivery?.entryId)) {
			assert.ok(performance.now() < deadline, "all legacy runs finish reconciliation");
			await delay(10);
		}
		delivery.stop();
		assert.equal(ownerWrites, 16, "each legacy run saves delivery identity and accounting once");
		assert.ok(ownerWritesAtInput !== undefined && ownerWritesAtInput < 16, "native input is serviced before the recovery batch finishes");
		assert.equal(sent, 0, "published completions never queue another model turn");
		assert.deepEqual(recorded.sort(), Array.from({ length: 8 }, (_, index) => `subagent:native-${index}`));
		assert.ok(parsedChars < fileBytes * 3, `${parsedChars} parsed characters: two compact indexes, not one full parse per run`);
		assert.equal(historicalLookups, 0, "published billing fields do not load historical result bodies");
		t.diagnostic(`${fileBytes} journal bytes; ${parsedChars} parsed characters; ${historicalLookups} historical body lookups.`);
		delivery.start();
		await delay(30);
		delivery.stop();
		assert.equal(ownerWrites, 16, "a second start does not migrate completed runs again");
		assert.equal(sent, 0);
	} finally { delivery.stop(); }
});

for (const change of ["partial tail", "changed prefix and growth", "same-size edit", "same-stamp edit", "replacement", "shrink", "malformed append"]) {
	test(`published receipt cache validates ${change}`, (t) => {
		const root = fs.mkdtempSync(path.join(tmpdir(), "subagent-receipt-cache-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const file = path.join(root, "parent.jsonl"), header = '{"type":"session","id":"parent","version":3}\n';
		const receipt = (key: string) => JSON.stringify({ type: "custom_message", id: "receipt", customType: "subagent-notify",
			timestamp: "2026-01-01T00:00:00Z", details: { completion: { runId: "run", key } } });
		const before = header + receipt("completion:A") + "\n";
		fs.writeFileSync(file, before);
		const reader = createParentReceiptReader("live");
		assert.equal(reader.read(file).size, 1);
		if (change === "same-stamp edit") {
			const fixed = fs.statSync(file, { bigint: true }), fstat = fs.fstatSync;
			const mock = t.mock.method(fs, "fstatSync", (fd: number, options?: fs.StatOptions) => {
				const stat = fstat(fd, options);
				return options?.bigint ? { ...stat, mtimeNs: fixed.mtimeNs, ctimeNs: fixed.ctimeNs } : stat;
			});
			syncBuiltinESMExports();
			t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
		}
		const key = () => (reader.read(file).get("receipt") as { details: { completion: { key: string } } } | undefined)?.details.completion.key;
		if (change === "partial tail") {
			fs.appendFileSync(file, receipt("completion:B").replace('"receipt"', '"new"'));
			assert.equal(reader.read(file).has("new"), false, "complete JSON without LF is not published");
			fs.appendFileSync(file, "\n");
			assert.equal(reader.read(file).has("new"), true);
			assert.equal(key(), "completion:A");
		} else if (change === "shrink") {
			fs.writeFileSync(file, header);
			assert.equal(reader.read(file).size, 0, "truncated receipts cannot retain delivery authority");
		} else if (change === "malformed append") {
			fs.appendFileSync(file, "{broken}\n");
			assert.throws(() => reader.read(file), /Invalid JSONL/);
			fs.writeFileSync(file, before + receipt("completion:B").replace('"receipt"', '"new"') + "\n");
			assert.equal(reader.read(file).has("new"), true, "failed scans never poison the next cache snapshot");
		} else {
			const changed = header + receipt("completion:B") + "\n" + (change === "changed prefix and growth" ? '{"type":"custom","id":"extra"}\n' : "");
			if (change === "replacement") {
				fs.writeFileSync(`${file}.next`, changed);
				fs.renameSync(`${file}.next`, file);
			} else fs.writeFileSync(file, changed);
			assert.equal(key(), "completion:B", "cached authority follows the current verified bytes");
		}
	});
}
