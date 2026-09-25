import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readNativeUsage, snapshotNativeUsage } from "../../src/runs/shared/native-usage.ts";
import { sumAttemptUsage } from "../../src/runs/shared/model-fallback.ts";

const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 15, reasoning: 5,
	totalTokens: 100, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };

test("native accounting excludes actual fork baseline and checkpoints, includes tool/summary/usage entries once", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-usage-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "session.jsonl");
	const assistant = (id: string, checkpoint = false) => ({ type: "message", id, checkpoint, message: { role: "assistant", provider: "provider", model: "requested", responseModel: "actual", usage } });
	fs.writeFileSync(file, [JSON.stringify({ type: "session", id: "child" }), JSON.stringify(assistant("inherited"))].join("\n") + "\n");
	const baseline = snapshotNativeUsage(file);
	fs.appendFileSync(file, [assistant("first"), assistant("checkpoint-copy", true),
		{ type: "message", id: "nested", message: { role: "toolResult", usage } },
		{ type: "compaction", id: "summary", usage },
		{ type: "branch_summary", id: "branch", usage },
		{ type: "usage", id: "native-usage", provider: "other", model: "small", usage },
		assistant("review")].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const segments = readNativeUsage(file, baseline, ["nested", "review"])!;
	assert.deepEqual(segments.map((part) => part.input), [20, 40]);
	const total = sumAttemptUsage(segments.map((part) => ({ model: "fixture", success: true, usage: part })));
	assert.equal(total.input, 60);
	assert.equal(total.output, 120, "reasoning is already included in output");
	assert.equal(total.cacheWrite, 240, "cacheWrite1h is a subset");
	assert.equal(total.cost, 60);
	assert.equal(total.turns, 2);
	assert.equal(total.contributions?.length, 6);
	assert.deepEqual(total.contributions?.map((part) => part.id), ["child:first", "child:nested", "child:summary", "child:branch", "child:native-usage", "child:review"]);
	assert.equal(total.contributions?.[0]?.model, "actual");
	assert.equal(total.contributions?.[1]?.provider, undefined, "native tool attribution is unavailable, not guessed");
	assert.deepEqual(total.contributions?.[4], { id: "child:native-usage", provider: "other", model: "small", usage });
	assert.deepEqual(readNativeUsage(file, snapshotNativeUsage(file))?.[0]?.contributions, []);
});

test("missing/non-native journals allow stream fallback; malformed journals surface errors", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-usage-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "session.jsonl");
	assert.equal(readNativeUsage(file, new Set()), undefined);
	fs.writeFileSync(file, JSON.stringify({ type: "message_end" }) + "\n");
	assert.equal(readNativeUsage(file, new Set()), undefined);
	fs.writeFileSync(file, "not JSON");
	assert.throws(() => readNativeUsage(file, new Set()), SyntaxError);
});
