import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import * as records from "../../src/runs/shared/run-records.ts";
import { getRunMetadataDir, listSupervisorQuestions, saveQuestionAnswer, questionProcessAlive } from "../../src/runs/shared/supervisor-questions.ts";
import { loadRunsForAgent } from "../../src/runs/shared/run-history.ts";
import { RESULTS_DIR } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const repo = path.resolve(".");
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);

describe("unified owner result retention through actual router", () => {
	const mock = createMockPi();
	let cwd: string;
	let runFiles: string;
	let state;
	before(() => mock.install());
	after(() => mock.uninstall());
	beforeEach(() => {
		mock.reset();
		cwd = createTempDir("owned-retention-");
		runFiles = createTempDir("owned-retention-state-");
		state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), ownedRuns: new Map() };
	});
	afterEach(() => {
		for (const run of state.ownedRuns.values()) {
			removeTempDir(getRunMetadataDir(run.runId));
			fs.rmSync(path.join(RESULTS_DIR, `${run.runId}.json`), { force: true });
		}
		removeTempDir(cwd);
		removeTempDir(runFiles);
	});
	function executor(agent = makeAgent("worker")) {
		return createSubagentExecutor({ pi: { events: createEventBus(), getSessionName: () => undefined }, state, config: {}, asyncByDefault: false,
			tempArtifactsDir: path.join(runFiles, "artifacts"), getSubagentSessionRoot: () => path.join(runFiles, "sessions"),
			expandTilde: (value) => value, discoverAgents: () => ({ agents: [agent] }) });
	}
	function saved(result) {
		return JSON.parse(fs.readFileSync(path.join(getRunMetadataDir(result.details.runId), "result.json"), "utf8"));
	}

	it("retains explicit file-only provenance, JSON payload, and artifact references", async () => {
		const output = path.join(cwd, "report.md");
		const body = "Complete findings saved in the requested file.";
		mock.onCall({ output: body, structuredOutput: { items: ["kept"] } });
		const result = await executor().execute("file", { agent: "worker", task: "Write findings", output, outputMode: "file-only", maxOutput: { bytes: 40, lines: 1 },
			outputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] } }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const child = result.details.results[0];
		assert.equal(child.outputMode, "file-only");
		assert.equal(child.savedOutputPath, output);
		assert.equal(child.outputReference.path, output);
		assert.equal(child.finalOutput, child.outputReference.message);
		assert.equal(result.content[0].text, child.outputReference.message);
		assert.equal(child.outputReference.bytes, Buffer.byteLength(body));
		assert.equal(result.content[0].text.split("Output saved to:").length, 2);
		assert.doesNotMatch(result.content[0].text, /Complete findings/);
		assert.equal(fs.readFileSync(output, "utf8"), body);
		assert.equal(fs.readFileSync(child.artifactPaths.outputPath, "utf8"), body);
		assert.deepEqual(child.structuredOutput, { items: ["kept"] });
		assert.deepEqual(saved(result).results[0].outputReference, child.outputReference);
		assert.equal(result.details.artifacts.files[0].metadataPath, child.artifactPaths.metadataPath);
	});

	it("retains generated-output cleanup provenance", async () => {
		mock.onCall({ output: "Inline findings" });
		const result = await executor(makeAgent("worker", { output: "report.md" })).execute("generated", { agent: "worker", task: "Review", artifacts: false }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, undefined);
		const child = result.details.results[0];
		assert.equal(child.outputMode, "inline");
		assert.equal(child.outputCleanup.action, "deleted");
		assert.equal(child.savedOutputPath, undefined);
		assert.match(child.outputReference.path, /requested-outputs/);
		assert.equal(fs.existsSync(child.outputReference.path), false);
		assert.equal(child.finalOutput, "Inline findings");
		assert.equal(result.content[0].text.split("Inline findings").length, 2);
	});

	it("bounds the model projection while durable results and artifacts retain full output", async () => {
		const full = Array.from({ length: 400 }, (_, index) => `Line ${index}: ${"proof ".repeat(30)}`).join("\n");
		mock.onCall({ output: full });
		const result = await executor().execute("bounded", { agent: "worker", task: "Report", maxOutput: { bytes: 600, lines: 6 } }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /TRUNCATED/);
		assert.ok(result.content[0].text.length < 1200);
		assert.ok(result.details.results[0].finalOutput.length < 1200);
		assert.ok(result.details.run.children[0].result.finalOutput.length < 1200);
		assert.equal(result.details.truncation.truncated, true);
		assert.equal(saved(result).results[0].finalOutput, full.trimEnd());
		assert.equal(saved(result).summary, full.trimEnd());
		assert.equal(saved(result).truncated, false, "durable evidence is complete even when the model projection is bounded");
		assert.equal(fs.readFileSync(result.details.results[0].artifactPaths.outputPath, "utf8"), full.trimEnd());
	});

	for (const mode of ["parallel", "chain"] as const) it(`${mode} timeout keeps configured deadline, partial output and completed siblings`, async () => {
		mock.onCall({ matchArgsIncludes: "Fast", output: "Completed sibling evidence" });
		mock.onCall({ matchArgsIncludes: "Slow", steps: [{ jsonl: [events.assistantMessage("Partial slow evidence")] }, { delay: 3000, jsonl: [events.assistantMessage("Too late")] }] });
		const tasks = [{ agent: "worker", task: "Fast" }, { agent: "worker", task: "Slow" }];
		const result = await executor().execute("timeout", { ...(mode === "parallel" ? { tasks, concurrency: 1 } : { chain: tasks }), timeoutMs: 600 }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, mode === "parallel" ? /Parallel run timed out/ : /Chain timed out/);
		assert.match(result.content[0].text, /Timed out after 600ms\./);
		assert.match(result.content[0].text, /Completed sibling evidence/);
		assert.match(result.content[0].text, /Partial slow evidence/);
		assert.equal(result.details.results[0].exitCode, 0);
		assert.equal(result.details.results[1].timedOut, true);
		assert.equal(result.details.results[1].error, "Timed out after 600ms.");
		assert.match(result.details.results[1].finalOutput, /Partial output before timeout/);
	});

	it("records owner-side duration history used by subsequent planner budgets", async () => {
		const name = `planner-${path.basename(cwd)}`;
		const execute = executor(makeAgent(name));
		for (let index = 0; index < 3; index++) {
			mock.onCall({ output: "Seed finished", delay: 400 });
			const result = await execute.execute(`seed-${index}`, { agent: name, task: `Seed ${index}`, artifacts: false }, undefined, undefined, makeMinimalCtx(cwd));
			assert.equal(result.isError, undefined);
		}
		const history = loadRunsForAgent(name);
		assert.equal(history.length, 3);
		assert.ok(history.every((entry) => entry.status === "ok" && entry.duration >= 400));
		mock.onCall({ output: "Planner finished within its historical budget", delay: 250 });
		const result = await execute.execute("planner", { agent: name, task: "Plan", timeoutMs: 180, artifacts: false }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.match(result.content[0].text, /Planner finished/);
		assert.equal(loadRunsForAgent(name).length, 4);
	});

	it("projects real tool progress and retains compact summaries without raw tool payloads", async () => {
		mock.onCall({ steps: [
			{ jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "source.ts" } }], stopReason: "toolUse" } }, events.toolStart("read", { path: "source.ts" })] },
			{ delay: 500, jsonl: [events.toolResult("read", "large raw payload ".repeat(5000)), events.toolEnd("read"), { type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working summary" } }] },
			{ delay: 500, jsonl: [events.assistantMessage("Finished compactly")] },
		] });
		const pending = executor().execute("progress", { agent: "worker", task: "Inspect", includeProgress: true }, undefined, undefined, makeMinimalCtx(cwd));
		const observed = [];
		let finished = false;
		void pending.finally(() => { finished = true; });
		while (!finished) {
			const run = [...state.ownedRuns.values()][0];
			if (run && typeof records.ownedRunProgressResult === "function") observed.push(records.ownedRunProgressResult(run, state));
			await delay(25);
		}
		const result = await pending;
		assert.ok(observed.some((update) => update.details.progress?.[0]?.currentTool === "read"));
		assert.ok(observed.some((update) => update.details.progress?.[0]?.streamingText === "Working summary"));
		const progress = result.details.progress?.[0];
		assert.ok(progress, "includeProgress must retain owner progress in the final public executor result");
		assert.equal(progress.agent, "worker");
		assert.equal(progress.task, "Inspect");
		assert.equal(progress.status, "complete");
		assert.equal(progress.toolCount, 1);
		assert.ok(progress.durationMs >= 1000);
		const ownerProgress = records.ownedRunProgressResult(state.ownedRuns.get(result.details.runId), state);
		assert.deepEqual(result.details.progress, ownerProgress.details.progress);
		assert.equal(ownerProgress.details.results[0].finalOutput, "Finished compactly", "completed children keep their final output in live workflow updates");
		assert.doesNotMatch(JSON.stringify(result), /large raw payload/);
		const child = result.details.results[0];
		assert.equal(child.messages, undefined);
		assert.equal(child.progress, undefined);
		assert.equal(child.progressSummary.toolCount, 1);
		assert.ok(child.progressSummary.durationMs >= 1000);
		assert.equal(child.toolCalls[0].text, "read source.ts");
		assert.ok(JSON.stringify(result).length < 80_000);
	});

	for (const includeProgress of [undefined, false]) it(`keeps final results compact with includeProgress ${includeProgress}`, async () => {
		mock.onCall({ output: "Compact result" });
		const result = await executor().execute("compact", { agent: "worker", task: "Inspect", ...(includeProgress === undefined ? {} : { includeProgress }) }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, undefined);
		assert.equal(result.details.progress, undefined);
		assert.equal(result.details.results[0].progress, undefined);
		assert.equal(result.details.results[0].messages, undefined);
		assert.ok(result.details.progressSummary.durationMs > 0);
	});

	for (const outcome of ["success", "error", "disabled"]) it(`retains explicitly requested session sharing ${outcome} in the final result`, async () => {
		const before = { PATH: process.env.PATH, PI_DRIVER_FIXTURE: process.env.PI_DRIVER_FIXTURE, PI_INTERCOM_TEST_SDK: process.env.PI_INTERCOM_TEST_SDK };
		const bin = path.join(cwd, "bin"), input = path.join(cwd, "native.json"), calls = path.join(cwd, "gh-calls.txt");
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(sdkRoot, "dist/cli.js")}' "$@"\n`, { mode: 0o755 });
		fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = auth ]; then exit 0; fi\n${outcome === "error" ? "echo 'Fixture share failure' >&2\nexit 1" : "echo 'https://gist.github.com/fixture/local-only-fixture'"}\n`, { mode: 0o755 });
		fs.writeFileSync(input, JSON.stringify({ scenario: "success", receiptPath: path.join(cwd, "receipt.json") }));
		Object.assign(process.env, { PATH: `${bin}${path.delimiter}${before.PATH}`, PI_DRIVER_FIXTURE: input, PI_INTERCOM_TEST_SDK: sdkRoot });
		try {
			const result = await executor(makeAgent("worker", { model: "driver-fixture/faux-1", extensions: [path.join(repo, "test/fixtures/native-child-attempt.mjs")] }))
				.execute("share", { agent: "worker", task: "Inspect", ...(outcome === "disabled" ? {} : { share: true }), artifacts: false }, undefined, undefined, makeMinimalCtx(cwd));
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			const durable = saved(result);
			if (outcome === "success") {
				assert.equal(durable.shareUrl, "https://shittycodingagent.ai/session/?local-only-fixture");
				assert.equal(result.details.shareUrl, durable.shareUrl);
				assert.equal(result.details.gistUrl, "https://gist.github.com/fixture/local-only-fixture");
				assert.ok(result.content[0].text.includes(durable.shareUrl));
			} else if (outcome === "error") {
				assert.match(durable.shareError, /Fixture share failure/);
				assert.equal(result.details.shareError, durable.shareError);
				assert.match(result.content[0].text, /Session share error:.*Fixture share failure/);
			} else {
				assert.equal(fs.existsSync(calls), false, "sharing must remain opt-in");
				assert.equal(result.details.shareUrl, undefined);
				assert.equal(result.details.gistUrl, undefined);
				assert.equal(result.details.shareError, undefined);
			}
		} finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
	});

	it("preserves binary worktree patch references in the model and durable result", async () => {
		const git = (...args) => { const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };
		git("init", "-q"); fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n"); git("add", "tracked.txt");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
		mock.onCall({ output: "Binary change complete", delay: 700 });
		const pending = executor().execute("patch", { tasks: [{ agent: "worker", task: "Create binary" }], worktree: true, artifacts: false }, undefined, undefined, makeMinimalCtx(cwd));
		let settled = false;
		void pending.then(() => { settled = true; });
		while (!mock.callCount() && !settled) await delay(10);
		assert.ok(mock.callCount(), JSON.stringify(settled ? (await pending).content : []));
		const callFile = fs.readdirSync(mock.dir).find((file) => file.startsWith("call-"));
		const call = JSON.parse(fs.readFileSync(path.join(mock.dir, callFile!), "utf8"));
		fs.writeFileSync(path.join(call.cwd, "image.bin"), Buffer.from([0, 255, 0, 128, 1, 0]));
		const result = await pending;
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const patchDir = result.content[0].text.match(/Full patches: ([^\n]+)/)?.[1];
		assert.ok(patchDir, result.content[0].text);
		const patch = path.join(patchDir, fs.readdirSync(patchDir).find((file) => file.endsWith(".patch"))!);
		assert.match(fs.readFileSync(patch, "utf8"), /GIT binary patch/);
		assert.ok(saved(result).summary.includes(patchDir));
	});

	for (const scenario of ["blocked", "public-output", "dynamic", "question-initial", "question-review"]) it(`retains actual native ${scenario} acceptance through the router`, async () => {
		const before = { PATH: process.env.PATH, PI_DRIVER_FIXTURE: process.env.PI_DRIVER_FIXTURE, PI_INTERCOM_TEST_SDK: process.env.PI_INTERCOM_TEST_SDK };
		const bin = path.join(cwd, "bin"), input = path.join(cwd, "native.json"); fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(sdkRoot, "dist/cli.js")}' "$@"\n`, { mode: 0o755 });
		fs.writeFileSync(input, JSON.stringify({ scenario: scenario === "dynamic" ? "public-output" : scenario, ...(scenario === "dynamic" ? { items: ["a", "b"] } : {}), receiptPath: path.join(cwd, "receipt.json"), report: { criteriaSatisfied: [{ id: "deliver", status: "satisfied", evidence: "fixture" }] } }));
		Object.assign(process.env, { PATH: `${bin}${path.delimiter}${before.PATH}`, PI_DRIVER_FIXTURE: input, PI_INTERCOM_TEST_SDK: sdkRoot });
		try {
			const launch = executor(makeAgent("worker", { model: "driver-fixture/faux-1", extensions: [path.join(repo, "test/fixtures/native-child-attempt.mjs"), ...(scenario.startsWith("question-") ? ["pi-intercom"] : [])] }));
			const acceptance = { criteria: [{ id: "deliver", must: "Complete fixture" }] };
			const outputSchema = { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] };
			const result = await launch.execute("native", scenario === "dynamic" ? { chain: [
				{ agent: "worker", task: "List items", as: "items", outputSchema },
				{ expand: { from: { output: "items", path: "/items" }, maxItems: 2 }, parallel: { agent: "worker", task: "Review {item}", acceptance, outputSchema }, collect: { as: "reviews" }, concurrency: 1 },
			] } : { agent: "worker", task: "Complete fixture", acceptance,
				...(scenario === "public-output" ? { output: path.join(cwd, "native-report.md"), outputMode: "file-only", outputSchema } : {}) }, undefined, undefined, makeMinimalCtx(cwd));
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			if (scenario.startsWith("question-")) {
				assert.equal(result.details.wait.status, "awaiting_input");
				const runId = result.details.wait.runId;
				const question = listSupervisorQuestions("session-123", runId).find((question) => question.state === "awaiting_input")!;
				assert.ok(question);
				const receipt = JSON.parse(fs.readFileSync(path.join(cwd, "receipt.json"), "utf8"));
				assert.equal(receipt.calls, scenario === "question-initial" ? 1 : 2);
				assert.equal(questionProcessAlive({ pid: receipt.pid }), true);
				assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")), false);
				saveQuestionAnswer(question, "Proceed with the fixture.");
				const deadline = Date.now() + 10_000;
				while (!fs.existsSync(path.join(getRunMetadataDir(runId), "result.json"))) { assert.ok(Date.now() < deadline, "owner must complete after answer"); await delay(20); }
				const completed = saved({ details: { runId } });
				assert.equal(completed.success, true, JSON.stringify(completed));
				assert.equal(completed.results[0].finalOutput, "Reviewed answer");
				assert.equal(completed.results[0].acceptance.finalization.turns.length, 1);
				assert.equal(completed.results[0].agentProcessExit.pid, receipt.pid);
				const terminalEvents = fs.readFileSync(path.join(getRunMetadataDir(runId), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
				assert.equal(terminalEvents.filter((event) => event.type === "subagent.run.completed").length, 1);
				return;
			}
			if (scenario === "dynamic") {
				assert.deepEqual(result.details.workflowGraph.nodes[1].children.map((child) => child.acceptanceStatus), ["checked", "checked"]);
				assert.equal(result.details.outputs.reviews.structured.length, 2);
				return;
			}
			const child = result.details.results[0];
			if (scenario === "blocked") {
				assert.match(result.content[0].text, /Needs your action/);
				assert.match(result.content[0].text, /Complete Touch ID/);
				assert.equal(child.acceptance.status, "blocked");
				assert.equal(child.acceptance.finalization, undefined);
			} else {
				assert.equal(child.outputMode, "file-only");
				assert.equal(child.savedOutputPath, path.join(cwd, "native-report.md"));
				assert.equal(child.finalOutput, child.outputReference.message);
				assert.equal(fs.readFileSync(child.savedOutputPath, "utf8"), "Reviewed answer");
				assert.deepEqual(child.structuredOutput, { items: ["public payload"] });
				assert.equal(child.acceptance.finalization.turns.length, 1);
				assert.equal(child.initialOutput, "");
				assert.equal(child.usage.turns, 2);
			}
		} finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
	});
});
