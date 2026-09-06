import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { executeChain } from "../../src/runs/foreground/chain-execution.ts";
import { executeAsyncChain, executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, RESULTS_DIR } from "../../src/shared/types.ts";
import { createMockPi, createTempDir, createEventBus, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const report = (satisfied = true) => "```acceptance-report\n" + JSON.stringify({
	criteriaSatisfied: [{ id: "criterion-1", status: satisfied ? "satisfied" : "not-satisfied", evidence: satisfied ? "Verified final state" : "Still blocked" }],
}) + "\n```";
const acceptance = { criteria: ["Deliver the final result"], maxFinalizationTurns: 1 };

async function waitForResult(id: string) {
	const file = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + 15_000;
	while (!fs.existsSync(file)) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("result contracts", () => {
	const mock = createMockPi();
	let cwd: string;
	let id: string;
	before(() => mock.install());
	after(() => mock.uninstall());
	beforeEach(() => {
		cwd = createTempDir("result-contract-");
		id = `result-contract-${path.basename(cwd)}`;
		mock.reset();
	});
	afterEach(() => {
		removeTempDir(cwd);
		removeTempDir(path.join(ASYNC_DIR, id));
		fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
	});

	function calls() {
		return fs.readdirSync(mock.dir).filter((file) => /^call-.*\.json$/.test(file)).sort()
			.map((file) => JSON.parse(fs.readFileSync(path.join(mock.dir, file), "utf8")));
	}

	for (const background of [false, true]) {
		for (const satisfied of [true, false]) {
			it(`${background ? "background" : "foreground"} finalization publishes authoritative output, acceptance and usage (${satisfied ? "accepted" : "rejected"})`, async () => {
				mock.onCall({ output: `Initial incomplete answer\n${report(false)}` });
				mock.onCall({ output: `Final ${satisfied ? "repaired" : "blocked"} answer\n${report(satisfied)}` });
				const expectedOutput = `Final ${satisfied ? "repaired" : "blocked"} answer`;
				const outputPath = path.join(cwd, "answer.md");
				let result;
				if (background) {
					const started = executeAsyncSingle(id, {
						agent: "worker", task: "Deliver the result", agentConfig: makeAgent("worker"),
						ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id },
						acceptance, output: outputPath, artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), shareEnabled: false, maxSubagentDepth: 2,
					});
					assert.ok(!started.isError, started.content[0]?.text);
					const payload = await waitForResult(id);
					result = payload.results[0];
					const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
					assert.equal(status.steps[0].acceptance.status, satisfied ? "checked" : "rejected");
					assert.equal(payload.exitCode, satisfied ? 0 : 1);
				} else {
					result = await runSync(cwd, [makeAgent("worker")], "worker", "Deliver the result", {
						runId: id, acceptance, outputPath, persistOutputFile: true, artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"),
					});
				}
				const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf8"));
				assert.equal(result.exitCode, satisfied ? 0 : 1);
				assert.equal(metadata.exitCode, result.exitCode);
				assert.deepEqual(metadata.acceptance, result.acceptance);
				assert.equal(metadata.usage.turns, 2);
				assert.equal(result.modelAttempts.reduce((turns, attempt) => turns + attempt.usage.turns, 0), 2);
				if (!background) {
					assert.deepEqual(metadata.usage, result.usage);
					assert.equal(result.progress.turnCount, 2);
				}
				assert.match(result.finalOutput ?? result.output, new RegExp(expectedOutput));
				assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf8"), expectedOutput);
				assert.equal(fs.readFileSync(outputPath, "utf8"), expectedOutput);
				assert.equal(metadata.initialOutput, "Initial incomplete answer");
			});
		}

		it(`${background ? "background" : "foreground"} report-only finalization preserves the useful answer`, async () => {
			mock.onCall({ output: `Useful answer\n${report()}` });
			mock.onCall({ output: report() });
			if (background) {
				executeAsyncSingle(id, {
					agent: "worker", task: "Deliver the result", agentConfig: makeAgent("worker"),
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, acceptance,
					sessionFile: path.join(cwd, "child.jsonl"), shareEnabled: false, maxSubagentDepth: 2,
				});
				assert.equal((await waitForResult(id)).results[0].output, "Useful answer");
			} else {
				const result = await runSync(cwd, [makeAgent("worker")], "worker", "Deliver the result", { runId: id, acceptance });
				assert.equal(result.finalOutput, "Useful answer");
			}
		});

		it(`${background ? "background" : "foreground"} report-only repair summaries replace stale initial prose`, async () => {
			mock.onCall({ output: `Still incomplete\n${report(false)}` });
			mock.onCall({ output: "```acceptance-report\n" + JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Repaired and verified" }], diffSummary: "Repaired the missing work and verified the final result.",
			}) + "\n```" });
			let result;
			if (background) {
				executeAsyncSingle(id, { agent: "worker", task: "Deliver the result", agentConfig: makeAgent("worker"),
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, acceptance,
					artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), shareEnabled: false, maxSubagentDepth: 2 });
				result = (await waitForResult(id)).results[0];
			} else {
				result = await runSync(cwd, [makeAgent("worker")], "worker", "Deliver the result", { runId: id, acceptance, artifactsDir: cwd });
			}
			assert.equal(result.finalOutput ?? result.output, "Repaired the missing work and verified the final result.");
			const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf8"));
			assert.equal(metadata.initialOutput, "Still incomplete");
			assert.equal(metadata.acceptance.finalization.turns[0].report.diffSummary, "Repaired the missing work and verified the final result.");
		});

		it(`${background ? "background" : "foreground"} finalization recaptures repaired output files before verification and file-only publication`, async () => {
			mock.onCall({ output: `Old content\n${report()}` });
			mock.onCall({ output: report(), delay: 400 });
			const outputPath = path.join(cwd, "repaired.md");
			const contract = { ...acceptance, verify: [{ id: "repaired", command: `grep -q 'Repaired file content' '${outputPath}'` }] };
			let completion;
			if (background) {
				executeAsyncSingle(id, { agent: "worker", task: "Deliver the result", agentConfig: makeAgent("worker"),
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, acceptance: contract, output: outputPath, outputMode: "file-only",
					artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), shareEnabled: false, maxSubagentDepth: 2 });
				completion = waitForResult(id).then((payload) => payload.results[0]);
			} else {
				completion = runSync(cwd, [makeAgent("worker")], "worker", "Deliver the result", { runId: id, acceptance: contract,
					outputPath, outputMode: "file-only", artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl") });
			}
			const deadline = Date.now() + 10_000;
			while (mock.callCount() < 2) {
				assert.ok(Date.now() < deadline, "finalization should continue the session");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			fs.writeFileSync(outputPath, "Repaired file content");
			const result = await completion;
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.acceptance.status, "verified");
			assert.match(result.finalOutput ?? result.output, /Output saved to:/);
			assert.doesNotMatch(result.finalOutput ?? result.output, /Repaired file content/);
			assert.equal(fs.readFileSync(outputPath, "utf8"), "Repaired file content");
			assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf8"), "Repaired file content");
		});

		it(`${background ? "background" : "foreground"} dynamic groups namespace explicit relative outputs`, async () => {
			mock.onCall({ output: "Items", structuredOutput: { items: ["a", "b"] } });
			mock.onCall({ output: "One" });
			mock.onCall({ output: "Two" });
			const chainDir = path.join(cwd, "dynamic-output");
			const chain = [
				{ agent: "worker", task: "List items", as: "items", outputSchema: { type: "object" } },
				{ expand: { from: { output: "items", path: "/items" }, maxItems: 2 }, parallel: { agent: "worker", task: "Review {item}", output: "answer.md" }, collect: { as: "answers" }, concurrency: 1 },
			];
			if (background) {
				const started = executeAsyncChain(id, { chain, chainDir, agents: [makeAgent("worker")],
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				assert.ok(!started.isError, started.content[0]?.text);
				assert.equal((await waitForResult(id)).success, true);
			} else {
				const result = await executeChain({ chain, chainDir, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
					shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
				assert.ok(!result.isError, result.content[0]?.text);
			}
			for (const [index, output] of ["One", "Two"].entries()) {
				assert.equal(fs.readFileSync(path.join(chainDir, id, "parallel-1", `${index}-worker`, "answer.md"), "utf8"), output);
			}
		});

		it(`${background ? "background" : "foreground"} chain groups reject duplicate absolute agent-default outputs before spawning`, async () => {
			const output = path.join(cwd, "shared.md");
			const chain = [{ parallel: [{ agent: "worker", task: "First" }, { agent: "worker", task: "Second" }] }];
			const agents = [makeAgent("worker", { output })];
			const result = background
				? executeAsyncChain(id, { chain, agents, ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 })
				: await executeChain({ chain, agents, ctx: makeMinimalCtx(cwd), runId: id, shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
			assert.equal(result.isError, true);
			assert.ok(result.content[0].text.includes(`same path: ${output}`));
			assert.equal(mock.callCount(), 0);
		});

		it(`${background ? "background" : "foreground"} chain parallel groups inherit group cwd and namespace explicit relative outputs`, async () => {
			fs.mkdirSync(path.join(cwd, "group", "child"), { recursive: true });
			mock.onCall({ output: "One" });
			mock.onCall({ output: "Two" });
			const chainDir = path.join(cwd, "chain-output");
			const chain = [{ cwd: "group", concurrency: 1, parallel: [
				{ agent: "worker", task: "First", output: "answer.md" },
				{ agent: "worker", task: "Second", cwd: "child", output: "answer.md" },
			] }];
			if (background) {
				const started = executeAsyncChain(id, {
					chain, chainDir, agents: [makeAgent("worker")], ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id },
					shareEnabled: false, maxSubagentDepth: 2,
				});
				assert.ok(!started.isError, started.content[0]?.text);
				assert.equal((await waitForResult(id)).success, true);
			} else {
				const result = await executeChain({ chain, chainDir, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
					shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
				assert.ok(!result.isError, result.content[0]?.text);
			}
			assert.deepEqual(calls().map((call) => fs.realpathSync(call.cwd)), ["group", "group/child"].map((dir) => fs.realpathSync(path.join(cwd, dir))));
			for (const [index, output] of ["One", "Two"].entries()) {
				assert.equal(fs.readFileSync(path.join(chainDir, id, "parallel-0", `${index}-worker`, "answer.md"), "utf8"), output);
			}
		});
	}

	it("detached finalization publishes the final answer and accounts for both turns", { timeout: 10_000 }, async () => {
		mock.onCall({ steps: [
			{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
			{ delay: 300, jsonl: [events.assistantMessage(`Initial answer\n${report()}`)] },
		] });
		mock.onCall({ output: `Final detached answer\n${report()}` });
		const bus = createEventBus();
		const completion = Promise.withResolvers<Awaited<ReturnType<typeof runSync>>>();
		let detached = false;
		const immediate = await runSync(cwd, [makeAgent("worker")], "worker", "Deliver the result", {
			runId: id, acceptance, artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), allowIntercomDetach: true, intercomEvents: bus,
			onDetachedComplete: completion.resolve,
			onUpdate: (update) => {
				if (!detached && update.details?.progress?.some((progress) => progress.currentTool === "contact_supervisor")) {
					detached = true;
					bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: id });
				}
			},
		});
		assert.equal(immediate.detached, true);
		const result = await completion.promise;
		assert.equal(result.finalOutput, "Final detached answer");
		assert.equal(result.usage.turns, 2);
		assert.equal(result.modelAttempts.reduce((turns, attempt) => turns + attempt.usage.turns, 0), 2);
		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf8"));
		assert.deepEqual(metadata.usage, result.usage);
		assert.deepEqual(metadata.acceptance, result.acceptance);
		assert.equal(metadata.initialOutput, "Initial answer");
		assert.equal(immediate.detached, true);
	});

	function executor() {
		return createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {}, asyncByDefault: false, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd,
			expandTilde: (value) => value, discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
	}

	for (const background of [false, true]) {
		it(`${background ? "background" : "foreground"} fresh children inherit the exact parent model and suppress native context loading`, async () => {
			mock.onCall({ output: "Done" });
			const ctx = { ...makeMinimalCtx(cwd), model: { provider: "parent-provider", id: "specific-model" } };
			const result = await executor().execute("test", { agent: "worker", task: "Say done", async: background }, undefined, undefined, ctx);
			if (background) {
				id = result.details.asyncId;
				await waitForResult(id);
			}
			const args = calls()[0].args;
			assert.equal(args[args.indexOf("--model") + 1], "parent-provider/specific-model");
			assert.ok(args.includes("--no-context-files"));
		});
	}

	it("clarify switching single to background preserves the acceptance contract", async () => {
		mock.onCall({ output: report() });
		mock.onCall({ output: report() });
		const ctx = { ...makeMinimalCtx(cwd), hasUI: true, ui: { custom: async () => ({ confirmed: true, templates: ["Deliver the result"], behaviorOverrides: [{}], runInBackground: true }) } };
		const result = await executor().execute("test", { agent: "worker", task: "Deliver the result", clarify: true, acceptance }, undefined, undefined, ctx);
		assert.ok(!result.isError, result.content[0]?.text);
		id = result.details.asyncId;
		const completed = await waitForResult(id);
		assert.equal(completed.results[0].acceptance.status, "checked");
		assert.equal(completed.results[0].acceptance.finalization.turns.length, 1);
		assert.equal(mock.callCount(), 2);
	});
});
