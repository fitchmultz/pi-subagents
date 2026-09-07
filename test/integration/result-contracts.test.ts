import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { executeChain } from "../../src/runs/foreground/chain-execution.ts";
import { executeAsyncChain, executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, RESULTS_DIR, type ForegroundControlState } from "../../src/shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../src/intercom/intercom-bridge.ts";
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
		it(`${background ? "background" : "foreground"} falls back after exhausted short-lived transport recovery`, async () => {
			mock.onCall({ exitCode: 143 });
			mock.onCall({ exitCode: 143 });
			mock.onCall({ output: "Recovered on the configured fallback" });
			const agent = makeAgent("worker", { model: "mock/primary", fallbackModels: ["mock/fallback"] });
			let result;
			if (background) {
				executeAsyncSingle(id, { agent: "worker", task: "Deliver the result", agentConfig: agent,
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id },
					shareEnabled: false, maxSubagentDepth: 2 });
				result = (await waitForResult(id)).results[0];
			} else {
				result = await runSync(cwd, [agent], "worker", "Deliver the result", { runId: id });
			}
			assert.equal(result.exitCode, 0, result.error);
			assert.deepEqual(result.attemptedModels, ["mock/primary", "mock/primary", "mock/fallback"]);
			assert.equal(mock.callCount(), 3);
			assert.match(result.finalOutput ?? result.output, /Recovered on the configured fallback/);
		});

		it(`${background ? "background" : "foreground"} passes configured thinking on the first child attempt`, async () => {
			mock.onCall({ output: "Done" });
			const agent = makeAgent("worker", { model: "mock/primary", thinking: "high" });
			if (background) {
				executeAsyncSingle(id, { agent: "worker", task: "Deliver the result", agentConfig: agent,
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id },
					shareEnabled: false, maxSubagentDepth: 2 });
				assert.equal((await waitForResult(id)).success, true);
			} else {
				assert.equal((await runSync(cwd, [agent], "worker", "Deliver the result", { runId: id })).exitCode, 0);
			}
			const args = calls()[0].args;
			assert.equal(args[args.indexOf("--model") + 1], "mock/primary:high");
		});

		it(`${background ? "background" : "foreground"} interruption during verification pauses before publishing terminal metadata`, async () => {
			mock.onCall({ output: `Initial report\n${report()}` });
			mock.onCall({ output: `Reviewed report\n${report()}` });
			const marker = path.join(cwd, "verification-started");
			const contract = { ...acceptance, verify: [{ id: "wait", command: `touch '${marker}'; sleep 20`, timeoutMs: 30_000 }] };
			const controller = new AbortController();
			let completion;
			if (background) {
				executeAsyncSingle(id, { agent: "worker", task: "Deliver the result", agentConfig: makeAgent("worker"),
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, acceptance: contract,
					artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), shareEnabled: false, maxSubagentDepth: 2 });
				completion = waitForResult(id).then((payload) => {
					assert.equal(payload.state, "paused");
					return payload.results[0];
				});
			} else {
				completion = runSync(cwd, [makeAgent("worker")], "worker", "Deliver the result", { runId: id,
					acceptance: contract, artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), interruptSignal: controller.signal });
			}
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(marker)) {
				assert.ok(Date.now() < deadline, "verification must start");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			if (background) {
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
				assert.ok(Number.isSafeInteger(status.pid) && status.pid > 0);
				process.kill(status.pid, "SIGUSR2");
			} else controller.abort();
			const result = await completion;
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.interrupted, true);
			const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf8"));
			assert.equal(metadata.exitCode, result.exitCode);
			assert.equal(metadata.interrupted, true);
			assert.equal(mock.callCount(), 2, "must not start another review after interruption");
		});

		for (const satisfied of [true, false]) {
			it(`${background ? "background" : "foreground"} finalization publishes authoritative output, acceptance and usage (${satisfied ? "accepted" : "rejected"})`, async () => {
				mock.onCall({ output: `Initial incomplete answer\n${report(false)}` });
				mock.onCall({ output: `Final ${satisfied ? "repaired" : "blocked"} answer\n${report(satisfied)}` });
				const expectedOutput = `Final ${satisfied ? "repaired" : "blocked"} answer`;
				const childCwd = path.join(cwd, "child");
				fs.mkdirSync(childCwd);
				let result;
				if (background) {
					const started = executeAsyncSingle(id, {
						agent: "worker", task: "Deliver the result", agentConfig: makeAgent("worker"),
						ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id },
						cwd: childCwd, acceptance, artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), shareEnabled: false, maxSubagentDepth: 2,
					});
					assert.ok(!started.isError, started.content[0]?.text);
					const payload = await waitForResult(id);
					result = payload.results[0];
					const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
					assert.equal(status.steps[0].acceptance.status, satisfied ? "checked" : "rejected");
					assert.equal(payload.exitCode, satisfied ? 0 : 1);
				} else {
					result = await runSync(cwd, [makeAgent("worker")], "worker", "Deliver the result", {
						runId: id, cwd: childCwd, acceptance, artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"),
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
				assert.equal(metadata.initialOutput, "Initial incomplete answer");
				const attempts = calls();
				assert.equal(attempts.length, 2);
				for (const call of attempts) {
					assert.equal(call.cwd, fs.realpathSync(childCwd));
					assert.equal(call.args[call.args.indexOf("--session") + 1], path.join(cwd, "child.jsonl"));
					assert.equal(call.args[call.args.indexOf("--session-cwd") + 1], childCwd);
				}
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

		it(`${background ? "background" : "foreground"} finalization preserves an unchanged detailed handoff instead of overwriting it with review prose`, async () => {
			mock.onCall({ output: `Wrote the report\n${report()}`, delay: 300 });
			mock.onCall({ output: `Report is complete; no changes needed.\n${report()}` });
			const outputPath = path.join(cwd, "report.md");
			const contract = { ...acceptance, verify: [{ id: "contents", command: `grep -q 'CRITICAL DETAIL' '${outputPath}'` }] };
			let completion;
			if (background) {
				executeAsyncSingle(id, { agent: "worker", task: "Write the report", agentConfig: makeAgent("worker"),
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, acceptance: contract, output: outputPath, outputMode: "file-only",
					artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), shareEnabled: false, maxSubagentDepth: 2 });
				completion = waitForResult(id).then((payload) => payload.results[0]);
			} else {
				completion = runSync(cwd, [makeAgent("worker")], "worker", "Write the report", { runId: id, acceptance: contract,
					outputPath, outputMode: "file-only", artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl") });
			}
			const deadline = Date.now() + 10_000;
			while (!mock.callCount()) {
				assert.ok(Date.now() < deadline, "initial child must start");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			fs.writeFileSync(outputPath, "Detailed report\nCRITICAL DETAIL: preserve this artifact.\n");
			const result = await completion;
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.acceptance.status, "verified");
			assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf8"), "Detailed report\nCRITICAL DETAIL: preserve this artifact.");
			assert.equal(fs.readFileSync(outputPath, "utf8"), "Detailed report\nCRITICAL DETAIL: preserve this artifact.\n");
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

		it(`${background ? "background" : "foreground"} omitted first tasks use the supplied task and later tasks receive previous output`, async () => {
			mock.onCall({ output: "First answer" });
			mock.onCall({ output: "Second answer" });
			const chain = [{ agent: "worker" }, { agent: "worker", task: "Continue without a placeholder" }];
			if (background) {
				executeAsyncChain(id, { chain, task: "Owner supplied task", agents: [makeAgent("worker")],
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				assert.equal((await waitForResult(id)).success, true);
			} else {
				const result = await executeChain({ chain, task: "Owner supplied task", agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
					shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
				assert.ok(!result.isError, result.content[0]?.text);
			}
			assert.match(calls()[0].expandedArgs.at(-1), /Owner supplied task/);
			assert.match(calls()[1].expandedArgs.at(-1), /Continue without a placeholder[\s\S]*Previous step output:\nFirst answer/);
		});

		it(`${background ? "background" : "foreground"} task, previous and named-output substitutions remain literal`, async () => {
			const text = "$& $` $' {task} {previous} {chain_dir} {outputs.data}";
			const task = "Owner $& {previous} {outputs.data}";
			mock.onCall({ output: text });
			mock.onCall({ output: "Done" });
			const chain = [{ agent: "worker", task: "Produce data", as: "data" }, { agent: "worker", task: "BEGIN {previous} MID {outputs.data} END {task}" }];
			if (background) {
				executeAsyncChain(id, { chain, task, agents: [makeAgent("worker")],
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				assert.equal((await waitForResult(id)).success, true);
			} else {
				const result = await executeChain({ chain, task, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
					shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
				assert.ok(!result.isError, result.content[0]?.text);
			}
			assert.equal(calls()[1].expandedArgs.at(-1).replace(/^@[^\n]+\n/, "").replace(/^Task: /, ""), `BEGIN ${text} MID ${text} END ${task}`);
		});

		it(`${background ? "background" : "foreground"} dynamic item text is not reinterpreted as workflow template syntax`, async () => {
			const item = "$& {previous} {outputs.items} {task}";
			const source = "Source $& {previous}";
			const task = "Owner $& {previous}";
			mock.onCall({ output: source, structuredOutput: { items: [item] } });
			mock.onCall({ output: "Done" });
			const chain = [{ agent: "worker", task: "Produce", as: "items", outputSchema: { type: "object" } },
				{ expand: { from: { output: "items", path: "/items" }, maxItems: 1 }, parallel: { agent: "worker", task: "Review {item} / Named {outputs.items} / Previous {previous} / Original {task}" }, collect: { as: "answers" } }];
			if (background) {
				executeAsyncChain(id, { chain, task, agents: [makeAgent("worker")],
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				assert.equal((await waitForResult(id)).success, true);
			} else {
				const result = await executeChain({ chain, task, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
					shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
				assert.ok(!result.isError, result.content[0]?.text);
			}
			assert.equal(calls()[1].expandedArgs.at(-1).replace(/^@[^\n]+\n/, "").replace(/^Task: /, ""),
				`Review ${item} / Named ${JSON.stringify({ items: [item] })} / Previous ${source} / Original ${task}`);
		});

		it(`${background ? "background" : "foreground"} empty and multiple fanouts keep executed indices separate from reserved fork sessions`, async () => {
			const echoEnv = ["PI_SUBAGENT_CHILD_INDEX", "PI_SUBAGENT_INTERCOM_SESSION_NAME"];
			mock.onCall({ output: "Items", structuredOutput: { empty: [], a: ["one", "two"], b: ["three"] }, echoEnv });
			for (const item of ["A one", "A two", "B three"]) mock.onCall({ matchArgsIncludes: `Review ${item}`, output: item, echoEnv });
			mock.onCall({ matchArgsIncludes: "Fail consumer", exitCode: 1, stderr: "Expected consumer failure", echoEnv });
			const chain = [
				{ agent: "worker", task: "List items", as: "items", outputSchema: { type: "object" } },
				{ expand: { from: { output: "items", path: "/empty" }, maxItems: 2 }, parallel: { agent: "worker", task: "Empty {item}" }, collect: { as: "empty" } },
				{ expand: { from: { output: "items", path: "/a" }, maxItems: 3 }, parallel: { agent: "worker", task: "Review A {item}" }, collect: { as: "a" }, concurrency: 1 },
				{ expand: { from: { output: "items", path: "/b" }, maxItems: 2 }, parallel: { agent: "worker", task: "Review B {item}" }, collect: { as: "b" }, concurrency: 1 },
				{ agent: "worker", task: "Fail consumer" },
			];
			const sessions = Array.from({ length: 9 }, (_, index) => path.join(cwd, `fork-${index}.jsonl`));
			for (const session of sessions) fs.writeFileSync(session, "");
			const childIntercomTarget = (agent, index) => resolveSubagentIntercomTarget(id, agent, index);
			let results, outputs, graph;
			if (background) {
				executeAsyncChain(id, { chain, agents: [makeAgent("worker")], artifactsDir: cwd, sessionFilesByFlatIndex: sessions, childIntercomTarget,
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				const payload = await waitForResult(id);
				({ results, outputs, workflowGraph: graph } = payload);
				assert.equal(payload.state, "failed");
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
				assert.equal(status.steps.length, 5);
				assert.equal(status.steps[4].status, "failed");
				assert.equal(status.currentStep, 4);
				assert.deepEqual(status.parallelGroups, [{ start: 1, count: 0, stepIndex: 1 }, { start: 1, count: 2, stepIndex: 2 }, { start: 3, count: 1, stepIndex: 3 }]);
			} else {
				const result = await executeChain({ chain, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id, childIntercomTarget,
					artifactsDir: cwd, shareEnabled: false, sessionDirForIndex: () => undefined, sessionFileForIndex: (index) => sessions[index], maxSubagentDepth: 2 });
				assert.equal(result.isError, true);
				({ results, outputs, workflowGraph: graph } = result.details);
			}
			assert.equal(results.length, 5);
			assert.deepEqual(outputs.empty.structured, []);
			assert.equal(graph.nodes[1].status, "completed");
			assert.deepEqual(graph.nodes[1].children, []);
			assert.deepEqual(graph.nodes[2].children.map((child) => child.flatIndex), [1, 2]);
			assert.deepEqual(graph.nodes[3].children.map((child) => child.flatIndex), [3]);
			assert.equal(graph.nodes[4].flatIndex, 4);
			assert.equal(graph.nodes[4].status, "failed");
			assert.deepEqual(calls().map((call) => call.args[call.args.indexOf("--session") + 1]), [0, 3, 4, 6, 8].map((index) => sessions[index]));
			assert.deepEqual(calls().map((call) => call.env.PI_SUBAGENT_CHILD_INDEX), ["0", "1", "2", "3", "4"]);
			assert.deepEqual(calls().map((call) => call.env.PI_SUBAGENT_INTERCOM_SESSION_NAME), [0, 1, 2, 3, 4].map((index) => childIntercomTarget("worker", index)));
		});

		it(`${background ? "background" : "foreground"} live dynamic graphs keep out-of-order child outcomes at their own indices`, async () => {
			mock.onCall({ output: "Items", structuredOutput: { items: ["Slow first", "Fail second"] } });
			mock.onCall({ matchArgsIncludes: "Review Slow first", steps: [
				{ jsonl: [events.toolStart("read", { path: "still-running" })] },
				{ delay: 700, jsonl: [events.assistantMessage("Finished first")] },
			] });
			mock.onCall({ matchArgsIncludes: "Review Fail second", waitForCalls: 3, exitCode: 1, stderr: "Second child failed" });
			const chain = [{ agent: "worker", task: "Produce", as: "items", outputSchema: { type: "object" } },
				{ expand: { from: { output: "items", path: "/items" }, maxItems: 2 }, parallel: { agent: "worker", task: "Review {item}" }, collect: { as: "answers" }, concurrency: 2 }];
			let children;
			if (background) {
				executeAsyncChain(id, { chain, agents: [makeAgent("worker")],
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				const statusPath = path.join(ASYNC_DIR, id, "status.json");
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					if (fs.existsSync(statusPath)) {
						const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
						if (status.steps[1]?.status === "running" && status.steps[2]?.status === "failed") {
							children = status.workflowGraph.nodes[1].children;
							break;
						}
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				await waitForResult(id);
			} else {
				await executeChain({ chain, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
					shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2,
					onUpdate: (update) => {
						if (!children && update.details?.results?.some((result) => result.exitCode === 1)) children = update.details.workflowGraph.nodes[1].children;
					} });
			}
			assert.ok(children, "must observe the second child failing while the first is still running");
			assert.deepEqual(children.map((child) => [child.flatIndex, child.status]), [[1, "running"], [2, "failed"]]);
		});

		it(`${background ? "background" : "foreground"} failed groups retain successful sibling outputs without advancing`, async () => {
			mock.onCall({ matchArgsIncludes: "Keep evidence", output: "Preserved sibling evidence" });
			mock.onCall({ matchArgsIncludes: "Fail sibling", exitCode: 1, stderr: "Expected sibling failure" });
			const chain = [
				{ parallel: [{ agent: "worker", task: "Keep evidence", as: "evidence" }, { agent: "worker", task: "Fail sibling", as: "failed" }], concurrency: 1 },
				{ agent: "worker", task: "Downstream must not run: {outputs.evidence}" },
			];
			let results, outputs, graph;
			if (background) {
				executeAsyncChain(id, { chain, agents: [makeAgent("worker")], artifactsDir: cwd,
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				const payload = await waitForResult(id);
				({ results, outputs, workflowGraph: graph } = payload);
				assert.equal(payload.state, "failed");
			} else {
				const result = await executeChain({ chain, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
					artifactsDir: cwd, shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
				assert.equal(result.isError, true);
				({ results, outputs, workflowGraph: graph } = result.details);
			}
			assert.equal(outputs?.evidence?.text, "Preserved sibling evidence");
			assert.equal(outputs?.failed, undefined);
			assert.equal(results.length, 2);
			assert.equal(fs.readFileSync(results[0].artifactPaths.outputPath, "utf8"), "Preserved sibling evidence");
			assert.equal(graph.nodes[0].status, "failed");
			assert.equal(graph.nodes[1].status, "pending");
			assert.equal(mock.callCount(), 2);
		});

		it(`${background ? "background" : "foreground"} paused groups retain completed evidence and never start queued or downstream work`, async () => {
			mock.onCall({ matchArgsIncludes: "Keep evidence", output: "Completed evidence" });
			mock.onCall({ matchArgsIncludes: "Pause sibling", steps: [
				{ jsonl: [events.toolStart("read", { path: "waiting" })] },
				{ delay: 5_000, jsonl: [events.assistantMessage("Should not finish")] },
			] });
			const chain = [{ parallel: [{ agent: "worker", task: "Keep evidence", as: "evidence" }, { agent: "worker", task: "Pause sibling", as: "unfinished" },
				{ agent: "worker", task: "Queued must not run" }], concurrency: 1 }, { agent: "worker", task: "Downstream must not run" }];
			let results, outputs;
			if (background) {
				executeAsyncChain(id, { chain, agents: [makeAgent("worker")], artifactsDir: cwd,
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				const deadline = Date.now() + 10_000;
				while (mock.callCount() < 2) {
					assert.ok(Date.now() < deadline, "second child must start");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				fs.writeFileSync(path.join(ASYNC_DIR, id, "control-request.json"), JSON.stringify({ requestId: id, runId: id, action: "interrupt" }));
				const payload = await waitForResult(id);
				({ results, outputs } = payload);
				assert.equal(payload.state, "paused");
			} else {
				const control: ForegroundControlState = { runId: id, mode: "chain", startedAt: Date.now(), updatedAt: Date.now() };
				let paused = false;
				const result = await executeChain({ chain, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
					artifactsDir: cwd, shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2, foregroundControl: control,
					onUpdate: (update) => {
						if (!paused && update.details?.progress?.some((progress) => progress.currentTool === "read")) {
							paused = true;
							assert.equal(control.interrupt?.(), true);
						}
					} });
				({ results, outputs } = result.details);
				assert.match(result.content[0].text, /Chain paused/);
			}
			assert.equal(outputs.evidence.text, "Completed evidence");
			assert.equal(outputs.unfinished, undefined);
			assert.equal(results[1].interrupted, true);
			assert.equal(results[2].interrupted, true);
			assert.equal(mock.callCount(), 2);
			assert.equal(fs.readFileSync(results[0].artifactPaths.outputPath, "utf8"), "Completed evidence");
		});

		if (!background) it("foreground detached groups retain completed evidence and stop queued work without losing the live child", async () => {
			mock.onCall({ matchArgsIncludes: "Keep evidence", output: "Completed evidence" });
			mock.onCall({ matchArgsIncludes: "Ask sibling", steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need input" })] },
				{ delay: 200, jsonl: [events.assistantMessage("Completed after reply")] },
			] });
			const bus = createEventBus();
			const finished = Promise.withResolvers<Awaited<ReturnType<typeof runSync>>>();
			let detached = false;
			const chain = [{ parallel: [{ agent: "worker", task: "Keep evidence", as: "evidence" }, { agent: "worker", task: "Ask sibling", as: "unfinished" },
				{ agent: "worker", task: "Queued must not run" }], concurrency: 1 }, { agent: "worker", task: "Downstream must not run" }];
			const result = await executeChain({ chain, agents: [makeAgent("worker", { systemPrompt: "Intercom orchestration channel:" })], ctx: makeMinimalCtx(cwd), runId: id,
				artifactsDir: cwd, shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2, intercomEvents: bus,
				onDetachedComplete: finished.resolve,
				onUpdate: (update) => {
					if (!detached && update.details?.progress?.some((progress) => progress.currentTool === "contact_supervisor")) {
						detached = true;
						bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: id });
					}
				} });
			const completed = await finished.promise;
			assert.match(result.content[0].text, /Chain detached/);
			assert.equal(result.details.outputs.evidence.text, "Completed evidence");
			assert.equal(result.details.outputs.unfinished, undefined);
			assert.equal(result.details.results[1].detached, true);
			assert.equal(result.details.results[2].exitCode, -1);
			assert.equal(completed.finalOutput, "Completed after reply");
			assert.equal(mock.callCount(), 2);
		});

		it(`${background ? "background" : "foreground"} fail-fast during sibling verification stops the verifier without publishing a pause`, async () => {
			for (const model of ["mock/fail", "mock/slow"]) for (let turn = 0; turn < 2; turn++) mock.onCall({ matchArgsIncludes: model, output: report() });
			const verifying = path.join(cwd, "verifying");
			const survived = path.join(cwd, "verifier-survived");
			const chain = [{ parallel: [
				{ agent: "fail", task: "Verify failure", acceptance: { ...acceptance, verify: [{ id: "failure", command: `while [ ! -f ${JSON.stringify(verifying)} ]; do sleep 0.01; done; exit 1`, timeoutMs: 5_000 }] } },
				{ agent: "slow", task: "Verify slowly", acceptance: { ...acceptance, verify: [{ id: "slow", command: `touch ${JSON.stringify(verifying)}; sleep 5; touch ${JSON.stringify(survived)}`, timeoutMs: 10_000 }] } },
				{ agent: "fail", task: "Queued must not run" },
			], concurrency: 2, failFast: true }];
			const agents = [makeAgent("fail", { model: "mock/fail" }), makeAgent("slow", { model: "mock/slow" })];
			const sessions = [0, 1, 2].map((index) => path.join(cwd, `verify-${index}.jsonl`));
			let results;
			if (background) {
				executeAsyncChain(id, { chain, agents, artifactsDir: cwd, sessionFilesByFlatIndex: sessions,
					ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
				const payload = await waitForResult(id);
				results = payload.results;
				assert.equal(payload.state, "failed");
			} else {
				const result = await executeChain({ chain, agents, ctx: makeMinimalCtx(cwd), runId: id, artifactsDir: cwd, shareEnabled: false,
					sessionDirForIndex: () => undefined, sessionFileForIndex: (index) => sessions[index], maxSubagentDepth: 2 });
				results = result.details.results;
				assert.equal(result.isError, true);
			}
			assert.equal(fs.existsSync(verifying), true);
			assert.equal(fs.existsSync(survived), false);
			assert.equal(mock.callCount(), 4);
			assert.equal(results[1].exitCode, -1);
			assert.ok(!results[1].interrupted);
			assert.match(results[1].error, /Interrupted due to fail-fast/);
			const metadata = JSON.parse(fs.readFileSync(results[1].artifactPaths.metadataPath, "utf8"));
			assert.equal(metadata.exitCode, -1);
			assert.ok(!metadata.interrupted);
			assert.equal(metadata.error, results[1].error);
		});

		for (const dynamic of [false, true]) {
			it(`${background ? "background" : "foreground"} ${dynamic ? "dynamic" : "static"} fail-fast stops running and queued siblings without publishing pause metadata`, async () => {
				if (dynamic) mock.onCall({ output: "Items", structuredOutput: { items: ["Fail now", "Wait slowly", "Queued must not run"] } });
				mock.onCall({ matchArgsIncludes: "Fail now", waitForCalls: dynamic ? 3 : 2, delay: 100, exitCode: 1, stderr: "Expected task failure" });
				mock.onCall({ matchArgsIncludes: "Wait slowly", delay: 5_000, output: "Must be stopped" });
				const group = dynamic
					? { expand: { from: { output: "items", path: "/items" }, maxItems: 3 }, parallel: { agent: "worker", task: "{item}" }, collect: { as: "answers" }, concurrency: 2, failFast: true }
					: { parallel: ["Fail now", "Wait slowly", "Queued must not run"].map((task) => ({ agent: "worker", task })), concurrency: 2, failFast: true };
				const chain = [...(dynamic ? [{ agent: "worker", task: "List items", as: "items", outputSchema: { type: "object" } }] : []), group,
					{ agent: "worker", task: "Downstream must not run" }];
				let results, outputs;
				if (background) {
					executeAsyncChain(id, { chain, agents: [makeAgent("worker")], artifactsDir: cwd,
						ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
					const payload = await waitForResult(id);
					({ results, outputs } = payload);
					assert.equal(payload.state, "failed");
				} else {
					const result = await executeChain({ chain, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id,
						artifactsDir: cwd, shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
					assert.equal(result.isError, true);
					({ results, outputs } = result.details);
				}
				const offset = dynamic ? 1 : 0;
				assert.equal(mock.callCount(), offset + 2);
				assert.equal(results[offset + 1].exitCode, -1);
				assert.ok(!results[offset + 1].interrupted, "fail-fast is not a user pause");
				assert.match(results[offset + 1].error, /Interrupted due to fail-fast/);
				assert.equal(results[offset + 2].exitCode, -1);
				assert.equal(outputs?.answers, undefined);
				const metadata = JSON.parse(fs.readFileSync(results[offset + 1].artifactPaths.metadataPath, "utf8"));
				assert.equal(metadata.exitCode, -1);
				assert.ok(!metadata.interrupted, "terminal metadata must not publish a user pause");
				assert.equal(metadata.error, results[offset + 1].error);
			});
		}

		for (const limit of ["maxExecutionTimeMs", "maxTokens"]) {
			it(`${background ? "background" : "foreground"} dynamic children enforce ${limit} without publishing a collection`, async () => {
				mock.onCall({ output: "Items", structuredOutput: { items: ["a"] } });
				mock.onCall({ output: "Over budget", ...(limit === "maxExecutionTimeMs" ? { delay: 2_000 } : {}) });
				const chain = [
					{ agent: "producer", task: "List items", as: "items", outputSchema: { type: "object" } },
					{ expand: { from: { output: "items", path: "/items" }, maxItems: 1 }, parallel: { agent: "worker", task: "Review {item}" }, collect: { as: "answers" } },
					{ agent: "producer", task: "Downstream must not run" },
				];
				const agents = [makeAgent("producer"), makeAgent("worker", { [limit]: 100 })];
				let results, outputs, graph;
				if (background) {
					const started = executeAsyncChain(id, { chain, agents,
						ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, artifactsDir: cwd,
						shareEnabled: false, maxSubagentDepth: 2 });
					assert.ok(!started.isError, started.content[0]?.text);
					const payload = await waitForResult(id);
					({ results, outputs, workflowGraph: graph } = payload);
					assert.equal(payload.state, "failed");
				} else {
					const result = await executeChain({ chain, agents, ctx: makeMinimalCtx(cwd), runId: id, artifactsDir: cwd,
						shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
					assert.equal(result.isError, true);
					({ results, outputs, workflowGraph: graph } = result.details);
				}
				assert.match(results[1]?.error ?? "", /Resource limit exceeded/);
				assert.equal(results[1]?.resourceLimitExceeded?.kind, limit);
				assert.equal(results[1]?.resourceLimitExceeded?.limit, 100);
				assert.equal(outputs?.answers, undefined);
				assert.equal(graph.nodes[1].status, "failed");
				assert.equal(graph.nodes[2].status, "pending");
				assert.equal(mock.callCount(), 2);
				const metadata = JSON.parse(fs.readFileSync(results[1].artifactPaths.metadataPath, "utf8"));
				assert.equal(metadata.exitCode, 1);
				assert.equal(metadata.resourceLimitExceeded.kind, limit);
			});
		}

		it(`${background ? "background" : "foreground"} dynamic group-level acceptance is rejected before any child starts`, async () => {
			mock.onCall({ output: "Items", structuredOutput: { items: ["a"] } });
			const chain = [{ agent: "worker", task: "Produce", as: "items", outputSchema: { type: "object" } },
				{ expand: { from: { output: "items", path: "/items" }, maxItems: 1 }, parallel: { agent: "worker", task: "Review {item}" }, collect: { as: "answers" }, acceptance }];
			const result = background
				? executeAsyncChain(id, { chain, agents: [makeAgent("worker")], ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 })
				: await executeChain({ chain, agents: [makeAgent("worker")], ctx: makeMinimalCtx(cwd), runId: id, shareEnabled: false, sessionDirForIndex: () => undefined, maxSubagentDepth: 2 });
			if (background && !result.isError) await waitForResult(id);
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /does not support group-level acceptance/);
			assert.equal(mock.callCount(), 0);
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

	it("foreground timeout extensions carry into recovery attempts", async () => {
		mock.onCall({ exitCode: 1, stderr: "connection reset", delay: 350 });
		mock.onCall({ output: "Recovered inside the extended deadline", delay: 350 });
		let registered = 0;
		const result = await runSync(cwd, [makeAgent("worker", { model: "mock/primary" })], "worker", "Deliver the result", {
			runId: id, timeoutMs: 250,
			registerTimeoutExtension: (extend) => {
				if (registered++ === 0) assert.equal(extend(1500).ok, true);
			},
		});
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.finalOutput, "Recovered inside the extended deadline");
		assert.equal(mock.callCount(), 2);
	});

	it("background cancellation after a successful prefix never reports the pending workflow complete", async () => {
		mock.onCall({ output: "Completed first step" });
		const preloadPath = path.join(cwd, "cancel-prefix.cjs");
		const statusPath = path.join(ASYNC_DIR, id, "status.json");
		// Stop at the published successful prefix, before the next child can start.
		fs.writeFileSync(preloadPath, `
if (process.argv[1]?.endsWith("subagent-runner.ts")) {
  const fs = require("node:fs");
  const rename = fs.renameSync;
  let cancelled = false;
  fs.renameSync = (...args) => {
    const result = rename(...args);
    if (!cancelled && args[1] === ${JSON.stringify(statusPath)}) {
      const status = JSON.parse(fs.readFileSync(args[1], "utf8"));
      if (status.steps[0]?.status === "complete" && status.steps[1]?.status === "pending") {
        cancelled = true;
        process.emit("SIGTERM");
      }
    }
    return result;
  };
  require("node:module").syncBuiltinESMExports();
}
`);
		const nodeOptions = process.env.NODE_OPTIONS;
		process.env.NODE_OPTIONS = [nodeOptions, `--require ${JSON.stringify(preloadPath)}`].filter(Boolean).join(" ");
		try {
			executeAsyncChain(id, { chain: [{ agent: "worker", task: "First" }, { agent: "worker", task: "Downstream must not run" }], agents: [makeAgent("worker")],
				ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, shareEnabled: false, maxSubagentDepth: 2 });
			const payload = await waitForResult(id);
			assert.equal(payload.state, "failed");
			assert.equal(payload.success, false);
			assert.equal(payload.results.length, 1);
			assert.equal(payload.results[0].success, true);
			assert.equal(payload.workflowGraph.nodes[1].status, "pending");
			assert.equal(mock.callCount(), 1);
		} finally {
			if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = nodeOptions;
		}
	});

	for (const questionPhase of ["initial", "finalization"]) it(`a question during ${questionPhase} releases the parent while the complete acceptance operation keeps running`, { timeout: 10_000 }, async () => {
		for (const [phase, output] of [["initial", "Initial answer"], ["finalization", "Final detached answer"]]) {
			mock.onCall(phase === questionPhase ? { steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 300, jsonl: [events.assistantMessage(`${output}\n${report()}`)] },
			] } : { output: `${output}\n${report()}` });
		}
		const bus = createEventBus();
		const completion = Promise.withResolvers<Awaited<ReturnType<typeof runSync>>>();
		let detached = false;
		let settled = 0;
		const immediate = await runSync(cwd, [makeAgent("worker")], "worker", "Deliver the result", {
			runId: id, acceptance, artifactsDir: cwd, sessionFile: path.join(cwd, "child.jsonl"), allowIntercomDetach: true, intercomEvents: bus,
			onDetachedComplete: completion.resolve,
			onRunSettled: () => settled++,
			onUpdate: (update) => {
				if (!detached && update.details?.progress?.some((progress) => progress.currentTool === "contact_supervisor")) {
					detached = true;
					bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: id });
				}
			},
		});
		assert.equal(immediate.detached, true);
		assert.equal(settled, 0);
		const result = await completion.promise;
		assert.equal(settled, 1);
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
			if (background) assert.equal(path.basename(path.dirname(path.dirname(args[args.indexOf("--session") + 1]))), result.details.asyncId);
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
		assert.equal(path.basename(path.dirname(path.dirname(completed.results[0].sessionFile))), id);
		assert.equal(completed.results[0].acceptance.status, "checked");
		assert.equal(completed.results[0].acceptance.finalization.turns.length, 1);
		assert.equal(mock.callCount(), 2);
	});
});
