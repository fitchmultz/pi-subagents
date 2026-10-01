import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCompletionDelivery } from "../../src/runs/background/completion-delivery.ts";
import { registerParentUsage } from "../../src/runs/shared/parent-usage.ts";
import { runChildAttempt } from "../../src/runs/shared/child-attempt.ts";
import { detectSubagentError } from "../../src/shared/utils.ts";
import { ownedRunView, repairOwnedRunAccounting, restoreOwnedRuns } from "../../src/runs/shared/run-records.ts";
import { getRunMetadataDir, saveAsyncRunResult, saveQuestionContract, readRunJson } from "../../src/runs/shared/supervisor-questions.ts";
import { createEventBus } from "../support/helpers.ts";

const usage = { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, totalTokens: 26,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 7, total: 13 } };
const message = { role: "assistant", content: [{ type: "text", text: "Completed work 🦄" }], provider: "fixture", model: "faux", stopReason: "stop", usage, timestamp: 7 };
function fixture(t: { after(fn: () => void): void }, script: string) {
	const root = fs.mkdtempSync(path.join(tmpdir(), "pi-subagents-owner-storage-"));
	const bin = path.join(root, "bin"); fs.mkdirSync(bin);
	const child = path.join(root, "child.mjs"); fs.writeFileSync(child, script);
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${child}' "$@"\n`, { mode: 0o755 });
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return { root, env: { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin` } };
}

test("live reception skips a >512 MiB lifecycle aggregate under a 128 MiB heap, keeps final output/counts, and saves only once-stored observations", { timeout: 180_000 }, (t) => {
	const { root, env } = fixture(t, `import {once} from 'node:events';
		async function output(text) { if (!process.stdout.write(text)) await once(process.stdout,'drain'); }
		await output(JSON.stringify({type:'message_start',message:{role:'assistant',content:[{type:'text',text:'x'.repeat(1024*1024)}]}})+'\\n');
		await output(${JSON.stringify(JSON.stringify({ type: "message_end", message }) + "\n")});
		await output('{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"');
		const block='x'.repeat(65536); for(let index=0;index<8193;index++) await output(block);
		await output('"}]}]}\\n'); await output('{"type":"agent_settled"}\\n');`);
	const module = new URL("../../src/runs/shared/child-attempt.ts", import.meta.url).href;
	const auditPath = path.join(root, "audit.log");
	const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", `
		import assert from 'node:assert/strict'; import fs from 'node:fs'; import {runChildAttempt} from ${JSON.stringify(module)};
		let output='',starts=0,ends=0;
		const result=await runChildAttempt({args:[],cwd:process.argv[1],agent:'fixture',auditPath:process.argv[2],
			onOutput:text=>output+=text,onEvent:event=>{if(event.type==='message_start'){starts++;assert.equal(event.message.content,undefined);}if(event.type==='message_end')ends++;}});
		assert.equal(result.exitCode,0); assert.equal(result.error,undefined); assert.equal(result.finalOutput,'Completed work 🦄');
		assert.equal(result.messages.length,1);assert.equal(result.messageCount,1);assert.equal(result.usage.input,3);assert.equal(starts,1);assert.equal(ends,1);
		assert.equal(output,'Completed work 🦄\\n');assert.equal(result.agentProcessExit.code,0);
		assert.ok(fs.statSync(result.auditPath).size<4096,'aggregates never become owner audit copies');
		assert.equal(JSON.parse(fs.readFileSync(result.auditPath,'utf8')).type,'message_end');
		console.log('bounded live receiver: final output/counters/counts/process outcome preserved; aggregate omitted from audit; heap limit 128 MiB');
	`, root, auditPath], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 170_000, maxBuffer: 64 * 1024 });
	assert.equal(child.status, 0, child.stderr);
	t.diagnostic(child.stdout.trim());
});

test("reordered messages, split JSON surrogate escapes, and malformed diagnostics preserve callbacks and exact output without publishing partial decoded text", async (t) => {
	const valid = '{"message":{"content":[{"type":"text","text":"\\uD83E\\uDD84"},{"type":"text","text":"second"}],"role":"assistant","provider":"fixture","model":"faux","stopReason":"stop","usage":' + JSON.stringify(usage) + ',"timestamp":7},"type":"message_end"}\n';
	const malformed = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"DO NOT PUBLISH"}]},"broken":truX}\n';
	const { root, env } = fixture(t, `process.stdout.write(${JSON.stringify(malformed)});for(const byte of Buffer.from(${JSON.stringify(valid)})) process.stdout.write(Buffer.from([byte]));`);
	let output = "", messages = 0;
	const result = await runChildAttempt({ args: [], cwd: root, env, agent: "fixture", auditPath: path.join(root, "audit.log"),
		onOutput: (text) => { output += text; }, onEvent: (event) => { if (event.type === "message_end") messages++; } });
	assert.equal(result.exitCode, 0);
	assert.equal(result.finalOutput, "second");
	assert.equal(messages, 1);
	assert.equal(output, `${malformed}🦄\nsecond\n`);
	assert.deepEqual(result.auditRecords?.map((record) => record.kind), ["diagnostic", "message_end"]);
});

test("compact owner controls skip a 100 MiB discarded nested message under a 32 MiB heap", (t) => {
	const { root } = fixture(t, ""), file = path.join(root, "result.json"), fd = fs.openSync(file, "wx");
	fs.writeSync(fd, '{"id":"saved","state":"complete","success":true,"results":[{"agent":"fixture","messages":[{"content":[{"text":"');
	const block = Buffer.alloc(65536, 120);
	for (let index = 0; index < 1600; index++) fs.writeSync(fd, block);
	fs.writeSync(fd, '"}]}],"finalOutput":"Exact saved answer","exitCode":0}]}');
	fs.closeSync(fd);
	const module = new URL("../../src/runs/shared/supervisor-questions.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", `
		import assert from 'node:assert/strict'; import {readRunJson} from ${JSON.stringify(module)};
		const result=readRunJson(process.argv[1]);
		assert.equal(result.id,'saved');assert.equal(result.success,true);assert.equal(result.state,'complete');
		assert.deepEqual(result.results,[{agent:'fixture',finalOutput:'Exact saved answer',exitCode:0}]);
		console.log('compact owner result preserved; discarded nested100 MiB message never assembled; old-space32 MiB');
	`, file], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 });
	assert.equal(child.status, 0, child.stderr);
	t.diagnostic(child.stdout.trim());
});

for (const receiptOwner of [undefined, "current", "foreign"]) test(`cold completion recovery recognizes published legacy receipts and refuses foreign owners (${receiptOwner ?? "absent"})`, async (t) => {
	const { root } = fixture(t, ""), runId = randomUUID(), manager = SessionManager.create(root, path.join(root, "parent"));
	manager.appendMessage(message);
	const ownerSessionId = manager.getSessionId();
	const run = { runId, rootRunId: runId, ownerSessionId, source: "async", mode: "single", cwd: root, task: "Legacy work", startedAt: 1, children: [],
		delivery: { notifiedAt: 2, intercomDelivered: false } };
	manager.appendCustomEntry("subagent-run", run);
	const receiptId = manager.appendCustomMessageEntry("subagent-notify", "Legacy work completed", false,
		{ completion: { runId, key: `id:${runId}:historical-digest`, ...(receiptOwner ? { ownerSessionId: receiptOwner === "current" ? ownerSessionId : "another-parent" } : {}) } });
	const reopened = SessionManager.open(manager.getSessionFile()!);
	const resultFile = path.join(getRunMetadataDir(runId), "result.json");
	fs.mkdirSync(getRunMetadataDir(runId), { recursive: true });
	const legacy = JSON.stringify({ runtimeVersion: 2, id: runId, sessionId: ownerSessionId, mode: "single", state: "complete", success: true, timestamp: 1, results: [] });
	fs.writeFileSync(resultFile, legacy);
	t.after(() => fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true }));
	const completionKey = `completion:legacy:${runId}:1`;
	const state = { currentSessionId: ownerSessionId, ownedRuns: new Map([[runId, run]]), completionSeen: new Map(),
		lastUiContext: { sessionManager: reopened, isIdle: () => true, hasPendingMessages: () => false } } as Parameters<typeof createCompletionDelivery>[1];
	const sent: unknown[] = [], completed: unknown[] = [];
	const pi = { events: createEventBus(), on: () => {}, sendMessage: (message: unknown) => sent.push(message) } as unknown as Parameters<typeof createCompletionDelivery>[0];
	pi.events.on("subagent:async-complete", (event) => completed.push(event));
	const completion = createCompletionDelivery(pi, state, registerParentUsage(pi));
	try {
		completion.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (receiptOwner === "foreign") {
			assert.equal(state.ownedRuns!.get(runId)!.delivery?.entryId, undefined);
			assert.equal(completed.length, 1, "a foreign receipt cannot suppress the owner's completion");
			assert.equal(sent.length, 1, "the genuine owner still receives a notification");
			return;
		}
		assert.equal(state.ownedRuns!.get(runId)!.delivery?.entryId, receiptId);
		assert.equal(state.ownedRuns!.get(runId)!.completion?.state, "journaled");
		assert.equal(state.ownedRuns!.get(runId)!.completion?.id, completionKey);
		assert.equal(state.completionSeen.size, 0, "a published parent receipt retires the transient key without waiting for TTL expiry");
		assert.equal(fs.readFileSync(resultFile, "utf8"), legacy, "completion reconciliation does not rewrite legacy accounting evidence");
		assert.deepEqual(completed, [], "an already journaled legacy completion never emits another completion");
		assert.deepEqual(sent, [], "the actual old receipt prevents another parent notification turn");
	} finally { completion.stop(); }
});

test("live consumed tool arguments and structured reports retain complete long property names", async (t) => {
	const key = "property".repeat(700), report = { [key]: "Exact report", ok: true };
	const events = [
		{ type: "tool_execution_start", toolName: "write_files", toolCallId: "write", args: { [key]: "Exact argument" } },
		{ type: "message_end", message: { ...message, content: [{ type: "toolCall", id: "report", name: "structured_output", arguments: { value: report } }] } },
	];
	const { root, env } = fixture(t, `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n")});`);
	const received: any[] = [];
	await runChildAttempt({ args: [], cwd: root, env, agent: "fixture", onEvent: (event) => received.push(event) });
	assert.deepEqual(received.find((event) => event.type === "tool_execution_start").args, { [key]: "Exact argument" });
	assert.deepEqual(received.find((event) => event.type === "message_end").message.content[0].arguments.value, report);
});

test("failed accounting preserves successful execution and repairs only the recorded predecessor boundary without another child invocation", async (t) => {
	const runId = randomUUID();
	const { root, env } = fixture(t, `import fs from 'node:fs';
		fs.appendFileSync(process.env.CALLS,'called\\n');
		const message=${JSON.stringify(message)};
		fs.appendFileSync(process.env.JOURNAL,JSON.stringify({type:'message',id:'terminal',parentId:null,timestamp:'2026-01-01T00:00:00Z',message})+'\\n');
		process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');
		process.stdout.write(JSON.stringify({type:'subagent.native',sessionId:'child',leafId:'terminal',persisted:true,messageCount:1,configuration:{model:'fixture/faux'},entries:[{id:'terminal',type:'message',message:{role:'assistant',timestamp:7}}]})+'\\n');
		fs.appendFileSync(process.env.JOURNAL,'malformed required record\\n');`);
	const file = path.join(root, "native.jsonl"), calls = path.join(root, "calls");
	const header = JSON.stringify({ type: "session", id: "child", version: 3, cwd: root }) + "\n";
	fs.writeFileSync(file, header);
	const result = await runChildAttempt({ args: [], cwd: root, env: { ...env, JOURNAL: file, CALLS: calls }, agent: "fixture", sessionFile: file, auditPath: path.join(root, "audit.log") });
	assert.equal(result.agentProcessExit?.code, 0);
	assert.equal(result.exitCode, 0);
	assert.equal(result.error, undefined);
	assert.equal(result.terminalFailure, undefined);
	assert.equal(result.accounting?.state, "incomplete");
	assert.equal(result.finalOutput, "Completed work 🦄");
	assert.equal(result.auditPath, undefined, "verified native message IDs replace audit body copies");
	assert.deepEqual(result.attemptBaseline, ["child"]);
	const durable = { agent: "fixture", task: "work", success: true, exitCode: 0, sessionFile: file, finalOutput: result.finalOutput, usage: result.usage,
		accounting: result.accounting, terminalEntryId: result.terminalEntryId, terminalLeafId: result.terminalLeafId };
	saveQuestionContract(runId, 0, { attemptBaseline: result.attemptBaseline, terminalEntryId: result.terminalEntryId, result: durable, sessionFile: file });
	const saved = saveAsyncRunResult(runId, { id: runId, runtimeVersion: 2, state: "complete", success: true, results: [durable] });
	t.after(() => fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true }));
	// Heal only the isolated corrupt fixture and append a successor's unrelated paid
	// work. Recovery must not rerun providers, tools or acceptance to get the charge.
	fs.writeFileSync(file, header + JSON.stringify({ type: "message", id: "terminal", parentId: null, message }) + "\n"
		+ JSON.stringify({ type: "usage", id: "successor", parentId: "terminal", provider: "later", model: "later", usage }) + "\n");
	repairOwnedRunAccounting({ runId, rootRunId: runId, ownerSessionId: "parent", source: "async", mode: "single", cwd: root, task: "work", startedAt: 0, children: [{ agent: "fixture", index: 0 }] });
	const repaired = readRunJson<typeof saved>(path.join(getRunMetadataDir(runId), "result.json"))!;
	assert.equal(repaired.success, true);
	assert.equal(repaired.completionId, saved.completionId);
	assert.equal(repaired.results![0]!.accounting?.state, "complete");
	assert.deepEqual(repaired.results![0]!.usage?.contributions?.map((value) => value.id), ["child:terminal"]);
	assert.equal(repaired.results![0]!.usage?.input, 3);
	assert.equal(fs.readFileSync(calls, "utf8"), "called\n");
});

test("compact observations preserve late bash errors, partial edit receipts and full stderr while a bare zero exit stays unconfirmed", async (t) => {
	const diagnostics = "diagnostic start\n" + "x".repeat(32_768) + "\ndiagnostic end\n";
	const events = [
		{ type: "tool_execution_start", toolName: "write_files", toolCallId: "edit", args: { files: [{ path: "changed" }] } },
		{ type: "message_end", message: { role: "toolResult", toolName: "write_files", toolCallId: "edit", timestamp: 1, isError: true,
			content: [{ type: "text", text: "Partial publication" }], details: { modifiedFiles: ["changed"] } } },
		{ type: "message_end", message: { role: "toolResult", toolName: "bash", toolCallId: "shell", timestamp: 2, isError: false,
			content: [{ type: "text", text: "x".repeat(16_384) + "\nProcess exited with code 17" }] } },
		{ type: "message_end", message },
	];
	const { root, env } = fixture(t, `process.stderr.write(${JSON.stringify(diagnostics)});process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n")});`);
	const result = await runChildAttempt({ args: [], cwd: root, env, agent: "fixture", auditPath: path.join(root, "audit") });
	assert.equal(result.exitCode, 0);
	assert.equal(result.observedCompletedMutation, true, "partial publication remains a completed mutation even when the tool reports an error");
	assert.equal(detectSubagentError(result.messages.filter((value) => value.role === "toolResult" && value.toolName === "bash")).exitCode, 17);
	assert.equal(result.stderr.length, 16_384);
	const record = result.auditRecords!.find((record) => record.kind === "stderr")!;
	assert.equal(fs.readFileSync(result.auditPath!).subarray(record.offset, record.offset + record.length).toString(), diagnostics);
	const bare = fixture(t, "process.exit(0)");
	const unconfirmed = await runChildAttempt({ args: [], cwd: bare.root, env: bare.env, agent: "fixture" });
	assert.equal(unconfirmed.exitCode, 1);
	assert.match(unconfirmed.error!, /no completed assistant result/);
});

test("startup isolates an unreadable unrelated foreground owner", (t) => {
	const healthy = randomUUID(), broken = randomUUID(), manager = SessionManager.inMemory("/fixture");
	for (const runId of [healthy, broken]) manager.appendCustomEntry("subagent-run", { runId, rootRunId: runId,
		ownerSessionId: manager.getSessionId(), source: "foreground", mode: "single", cwd: "/fixture", task: "Saved work", startedAt: 1, children: [] });
	for (const runId of [healthy, broken]) fs.mkdirSync(getRunMetadataDir(runId), { recursive: true });
	fs.writeFileSync(path.join(getRunMetadataDir(healthy), "foreground.json"), JSON.stringify({ runId: healthy, mode: "single", cwd: "/fixture", updatedAt: 2, children: [] }));
	fs.writeFileSync(path.join(getRunMetadataDir(broken), "foreground.json"), "{");
	t.after(() => { for (const runId of [healthy, broken]) fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true }); });
	const state = {} as Parameters<typeof restoreOwnedRuns>[0], ctx = { cwd: "/fixture", sessionManager: manager } as Parameters<typeof restoreOwnedRuns>[1];
	restoreOwnedRuns(state, ctx);
	assert.equal(state.foregroundRuns!.get(healthy)!.updatedAt, 2);
	assert.equal(state.ownedRuns!.has(healthy), true);
});

test("legacy receipt recovery retains a malformed-child run as incomplete without hiding a healthy owner", (t) => {
	const { root } = fixture(t, "");
	const file = path.join(root, "malformed-child.jsonl"); fs.writeFileSync(file, "not a native journal\n");
	const manager = SessionManager.inMemory(root), healthy = randomUUID(), broken = randomUUID();
	manager.appendCustomEntry("subagent-run", { runId: healthy, rootRunId: healthy, ownerSessionId: manager.getSessionId(),
		source: "foreground", mode: "single", cwd: root, task: "Healthy saved work", startedAt: 1, children: [] });
	manager.appendMessage({ role: "toolResult", toolCallId: "legacy", toolName: "delegate", timestamp: 1, isError: false,
		content: [{ type: "text", text: "Genuine retained receipt" }], details: { mode: "single", runId: broken, results: [{ agent: "fixture", task: "Legacy work", sessionFile: file, exitCode: 0, usage: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: 13, turns: 1 } }] } });
	t.after(() => { for (const runId of [healthy, broken]) fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true }); });
	const state = {} as Parameters<typeof restoreOwnedRuns>[0], ctx = { cwd: root, sessionManager: manager } as Parameters<typeof restoreOwnedRuns>[1];
	restoreOwnedRuns(state, ctx);
	assert.equal(state.ownedRuns!.has(healthy), true);
	const retained = state.ownedRuns!.get(broken)!;
	assert.equal(ownedRunView(retained, state).state, "unknown");
	assert.match(ownedRunView(retained, state).diagnosis!, /recovery remains incomplete/);
	assert.equal(fs.existsSync(path.join(getRunMetadataDir(broken), "foreground.json")), false, "no invented output or success snapshot is published");
});

test("missing stream usage or an unverified native-reference claim preserves execution and audit with incomplete accounting", async (t) => {
	for (const claimed of [false, true]) {
		const observed = { ...message, ...(claimed ? {} : { usage: undefined }) };
		const native = { type: "subagent.native", sessionId: "child", leafId: "not-published", persisted: true, configuration: { model: "fixture/faux" },
			entries: [{ id: "not-published", type: "message", message: { role: "assistant", timestamp: 7 } }] };
		const { root, env } = fixture(t, `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "message_end", message: observed }) + "\n" + (claimed ? JSON.stringify(native) + "\n" : ""))});`);
		const file = path.join(root, "native.jsonl");
		if (claimed) fs.writeFileSync(file, '{"type":"session","id":"child","version":3}\n');
		const result = await runChildAttempt({ args: [], cwd: root, env, agent: "fixture", ...(claimed ? { sessionFile: file } : {}), auditPath: path.join(root, "audit") });
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.accounting?.state, "incomplete");
		assert.equal(result.finalOutput, "Completed work 🦄");
		assert.equal(result.nativeReferences, undefined, "a child claim or file locator is not a native commit receipt");
		assert.equal(JSON.parse(fs.readFileSync(result.auditPath!, "utf8")).type, "message_end");
		if (claimed) assert.equal(result.usage.input, 3, "reported usage is not replaced with a fabricated native zero");
	}
});

for (const claimed of [false, true]) test(`native LF publication owns final accounting and audit release (${claimed ? "claimed persisted" : "journal fallback"})`, async (t) => {
	for (const published of [false, true]) {
		const { root, env } = fixture(t, `import fs from 'node:fs';
			const message=${JSON.stringify(message)};
			fs.appendFileSync(process.env.JOURNAL,JSON.stringify({type:'message',id:'terminal',parentId:null,message})+${JSON.stringify(published ? "\n" : "")});
			process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');
			${claimed ? `process.stdout.write(JSON.stringify({type:'subagent.native',sessionId:'child',leafId:'terminal',persisted:true,configuration:{model:'fixture/faux'},entries:[{type:'message',id:'terminal',message:{role:'assistant',timestamp:7}}]})+'\\n');` : ""}`);
		const file = path.join(root, "native.jsonl"), audit = path.join(root, "audit");
		fs.writeFileSync(file, '{"type":"session","id":"child","version":3}\n');
		const result = await runChildAttempt({ args: [], cwd: root, env: { ...env, JOURNAL: file }, agent: "fixture", sessionFile: file, auditPath: audit });
		assert.equal(result.agentProcessExit?.code, 0);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.terminalFailure, undefined);
		assert.equal(result.finalOutput, "Completed work 🦄");
		assert.deepEqual([result.usage.input, result.usage.output, result.usage.cost, result.usage.turns], [3, 5, 13, 1]);
		assert.equal(result.accounting?.state, published ? "complete" : "incomplete", "syntax completion and the persisted flag cannot publish a native entry");
		assert.deepEqual(result.nativeReferences, published ? [{ messageNumber: 1, entryId: "terminal" }] : undefined);
		if (published) {
			assert.equal(result.auditPath, undefined);
			assert.equal(fs.existsSync(audit), false);
			assert.deepEqual(result.usage.contributions?.map((value) => value.id), ["child:terminal"]);
		} else {
			assert.equal(result.auditPath, audit);
			assert.deepEqual(JSON.parse(fs.readFileSync(audit, "utf8")), { type: "message_end", message });
			assert.deepEqual(result.auditRecords?.map(({ kind, messageNumber }) => ({ kind, messageNumber })), [{ kind: "message_end", messageNumber: 1 }]);
			if (!claimed) {
				assert.equal(result.terminalEntryId, undefined, "configuration fallback cannot promote a sealed EOF observation to a terminal reference");
				assert.equal(result.effectiveConfiguration?.model, undefined);
			}
		}
	}
});
