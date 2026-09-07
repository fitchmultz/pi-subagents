import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSubagentExecutor, type SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import { createSupervisorQuestion, getRunMetadataDir, questionProcessAlive, readQuestionContract, saveQuestionContract } from "../../src/runs/shared/supervisor-questions.ts";
import { ASYNC_DIR, RESULTS_DIR, getAsyncConfigPath, type AsyncResultFile, type ForegroundResumeRun, type SubagentExecutionResult } from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent, makeMinimalCtx, removeTempDir, type MockPi } from "../support/helpers.ts";

async function waitFor(check: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!check()) {
		assert.ok(Date.now() < deadline, message);
		await delay(20);
	}
}

function savedLaunch(runId: string, index = 0) {
	const launch = readQuestionContract(runId, index)?.launch;
	assert.ok(launch, `missing saved launch for ${runId}:${index}`);
	return launch;
}

function contractBytes(runId: string, index = 0): Buffer {
	return fs.readFileSync(path.join(getRunMetadataDir(runId), "contracts", `${index}.json`));
}

const writer = { agent: "writer", task: "Write the report", outputMode: "file-only" as const };
const producer = { agent: "producer", task: "Prepare inputs" };
const routes: Array<{ name: string; params: SubagentParamsLike; indices: number[]; structured?: boolean }> = [
	{ name: "single", params: writer, indices: [0] },
	{ name: "parallel", params: { tasks: [writer, writer] }, indices: [0, 1] },
	{ name: "sequential chain", params: { chain: [producer, writer] }, indices: [1] },
	{ name: "parallel chain", params: { chain: [{ parallel: [writer, writer] }] }, indices: [0, 1] },
	{
		name: "dynamic fanout",
		params: { chain: [
			{ ...producer, as: "inputs", outputSchema: { type: "object" } },
			{ expand: { from: { output: "inputs", path: "/items" }, maxItems: 2 }, parallel: writer, collect: { as: "reports" } },
		] },
		indices: [1, 2],
		structured: true,
	},
];

describe("saved output choices", () => {
	let mockPi: MockPi;
	let tempDir: string;
	let profile: ReturnType<typeof makeAgent>;
	let ctx: ReturnType<typeof makeMinimalCtx>;
	let executor: ReturnType<typeof createSubagentExecutor>;
	let discoveries: number;
	let runIds: Set<string>;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});
	after(() => mockPi.uninstall());

	beforeEach(() => {
		tempDir = createTempDir("pi-output-revival-");
		profile = makeAgent("writer", { output: "reports/frozen.md" });
		ctx = makeMinimalCtx(tempDir);
		discoveries = 0;
		runIds = new Set();
		mockPi.reset();
		executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: path.join(tempDir, "artifacts"),
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (value: string) => value,
			discoverAgents: () => { discoveries++; return { agents: [profile, makeAgent("producer")] }; },
		});
	});

	afterEach(() => {
		for (const runId of runIds) {
			removeTempDir(getRunMetadataDir(runId));
			removeTempDir(path.join(ASYNC_DIR, runId));
			fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
			fs.rmSync(getAsyncConfigPath(runId), { force: true });
		}
		removeTempDir(tempDir);
	});

	async function run(params: SubagentParamsLike): Promise<SubagentExecutionResult> {
		const result = await executor.execute("output-revival", params, undefined, undefined, ctx);
		assert.ok(!result.isError, result.content.map((part) => part.text).join("\n"));
		const id = result.details.runId ?? result.details.asyncId;
		assert.ok(id);
		runIds.add(id);
		if (result.details.asyncId) {
			const resultPath = path.join(RESULTS_DIR, `${id}.json`);
			await waitFor(() => fs.existsSync(resultPath), `missing async result for ${id}`);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultFile;
			assert.equal(payload.success, true, JSON.stringify(payload));
			const pid = readStatus(result.details.asyncDir!)?.pid;
			assert.ok(pid);
			await waitFor(() => !questionProcessAlive({ pid }), `async runner ${pid} did not exit`);
		}
		return result;
	}

	async function continueWithOwnOutput(runId: string, index = 0, overrides: SubagentParamsLike = {}) {
		const previous = savedLaunch(runId, index);
		assert.ok(typeof previous.output === "string");
		const bytes = fs.existsSync(previous.output) ? fs.readFileSync(previous.output) : undefined;
		const receipt = contractBytes(runId, index);
		const resultPath = ["result.json", "foreground.json"].map((name) => path.join(getRunMetadataDir(runId), name)).find((file) => fs.existsSync(file));
		assert.ok(resultPath);
		const resultBytes = fs.readFileSync(resultPath);
		const savedResult: AsyncResultFile | ForegroundResumeRun = JSON.parse(resultBytes.toString());
		const artifactPath = "children" in savedResult ? savedResult.children.find((child) => child.index === index)?.artifactPath : savedResult.results?.[index]?.artifactPaths?.outputPath;
		if (previous.artifacts) assert.ok(artifactPath, "expected predecessor output artifact");
		const artifactBytes = artifactPath ? fs.readFileSync(artifactPath) : undefined;
		const discoveryCount = discoveries;
		profile.output = "changed-current-profile.md";
		mockPi.onCall({ output: "Successor report — new bytes" });
		const continued = await run({ action: "resume", id: runId, index, message: "Write a follow-up report", ...overrides });
		const successorId = continued.details.asyncId!;
		const successor = savedLaunch(successorId);
		assert.ok(typeof successor.output === "string");
		assert.notEqual(successor.output, previous.output, "continuation must not reuse the predecessor output path");
		assert.ok(path.basename(successor.output).startsWith(`${successorId}_writer_0_`));
		assert.ok(successor.output.endsWith("_frozen.md"), "use the frozen saved filename, not the current profile");
		if (bytes) assert.deepEqual(fs.readFileSync(previous.output), bytes, "predecessor bytes must stay intact");
		else assert.equal(fs.existsSync(previous.output), false, "do not recreate a consumed predecessor file");
		assert.deepEqual(contractBytes(runId, index), receipt, "continuation must not rewrite its predecessor receipt");
		assert.deepEqual(fs.readFileSync(resultPath), resultBytes, "predecessor result must stay intact");
		if (artifactPath) assert.deepEqual(fs.readFileSync(artifactPath), artifactBytes, "predecessor artifact must stay intact");
		assert.equal(discoveries, discoveryCount, "saved continuation must not rediscover the profile");
		assert.equal(previous.generatedOutputFilename, "frozen.md");
		assert.equal(successor.generatedOutputFilename, "frozen.md");
		assert.equal(successor.agent.output, "reports/frozen.md");
		assert.equal(successor.outputMode, overrides.outputMode ?? previous.outputMode);
		if (successor.outputMode === "file-only") {
			assert.equal(fs.readFileSync(successor.output, "utf8"), "Successor report — new bytes");
			const payload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${successorId}.json`), "utf8")) as AsyncResultFile;
			assert.match(payload.results![0]!.output!, /Output saved to:/);
			assert.doesNotMatch(payload.results![0]!.output!, /Successor report/);
		} else {
			assert.equal(fs.existsSync(successor.output), false, "inline generated output is consumed after capture");
			const payload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${successorId}.json`), "utf8")) as AsyncResultFile;
			assert.match(payload.results![0]!.output!, /Successor report/);
			assert.match(payload.results![0]!.output!, /Output file consumed:/);
		}
		return successorId;
	}

	for (const async of [true, false]) {
		for (const route of routes) {
			it(`${async ? "async" : "foreground"} ${route.name} regenerates default outputs from saved launches`, async () => {
				if (route.structured) mockPi.onCall({ output: "Inputs", structuredOutput: { items: ["a", "b"] } });
				mockPi.onCall({ output: "Predecessor report — preserved bytes\n" });
				const original = await run({ ...route.params, async });
				const id = original.details.runId!;
				for (const index of route.indices) {
					await continueWithOwnOutput(id, index);
				}
			});
		}
	}

	for (const route of routes.filter((entry) => ["single", "parallel", "sequential chain"].includes(entry.name))) {
		it(`clarify-to-background ${route.name} preserves generated output origin`, async () => {
			ctx.hasUI = true;
			ctx.ui.custom = async () => ({
				confirmed: true,
				templates: route.name === "single" ? [writer.task] : ["Prepare inputs", writer.task],
				behaviorOverrides: [],
				runInBackground: true,
			});
			mockPi.onCall({ output: "Predecessor report" });
			const original = await run({ ...route.params, async: true, clarify: true });
			assert.ok(original.details.asyncId);
			for (const index of route.indices) await continueWithOwnOutput(original.details.asyncId, index);
		});
	}

	for (const output of [true, "true"] as const) {
		it(`explicit output:${JSON.stringify(output)} keeps the generated default over repeated continuations`, async () => {
			mockPi.onCall({ output: "Predecessor report" });
			const original = await run({ ...writer, async: true, output });
			const successorId = await continueWithOwnOutput(original.details.asyncId!);
			await continueWithOwnOutput(successorId);
		});
	}

	it("an inline continuation consumes only its new generated file", async () => {
		mockPi.onCall({ output: "Predecessor report" });
		const original = await run({ ...writer, async: true });
		await continueWithOwnOutput(original.details.asyncId!, 0, { outputMode: "inline" });
	});

	it("inline launches preserve predecessor artifacts and results while consuming both temporary files", async () => {
		mockPi.onCall({ output: "Inline predecessor report" });
		const original = await run({ ...writer, async: true, outputMode: "inline" });
		const previous = savedLaunch(original.details.asyncId!);
		assert.ok(typeof previous.output === "string");
		assert.equal(fs.existsSync(previous.output), false);
		await continueWithOwnOutput(original.details.asyncId!);
	});

	for (const async of [true, false]) {
		for (const choice of ["explicit", "absolute-default", "disabled"] as const) {
			it(`${async ? "async" : "foreground"} ${choice} output retains its fixed or disabled contract`, async () => {
				const fixedPath = path.join(tempDir, "fixed.md");
				if (choice === "explicit") profile.output = "fixed.md";
				if (choice === "absolute-default") profile.output = fixedPath;
				mockPi.onCall({ output: "First report" });
				const original = await run({
					...writer, async,
					...(choice === "explicit" ? { output: "fixed.md" } : {}),
					...(choice === "disabled" ? { output: false, outputMode: "inline" } : {}),
				});
				const id = original.details.runId!;
				const previous = savedLaunch(id);
				const receipt = contractBytes(id);
				assert.equal(previous.generatedOutputFilename, undefined);
				assert.equal(previous.output, choice === "disabled" ? false : fixedPath);
				mockPi.onCall({ output: "Replacement report" });
				const continued = await run({ action: "resume", id, message: "Replace the report" });
				const successor = savedLaunch(continued.details.asyncId!);
				assert.equal(successor.output, previous.output);
				assert.equal(successor.generatedOutputFilename, undefined);
				assert.equal(successor.outputMode, previous.outputMode);
				assert.deepEqual(contractBytes(id), receipt);
				if (choice !== "disabled") assert.equal(fs.readFileSync(fixedPath, "utf8"), "Replacement report");
				else assert.equal(fs.existsSync(fixedPath), false);
			});
		}
	}

	for (const output of ["override.md", false] as const) {
		it(`explicit continuation output:${JSON.stringify(output)} replaces only the output choice`, async () => {
			mockPi.onCall({ output: "Predecessor report" });
			const original = await run({ ...writer, async: true });
			const id = original.details.asyncId!;
			const previous = savedLaunch(id);
			assert.ok(typeof previous.output === "string");
			const bytes = fs.readFileSync(previous.output);
			mockPi.onCall({ output: "Override report" });
			const continued = await run({ action: "resume", id, message: "Use the override", output, outputMode: output === false ? "inline" : "file-only" });
			const successor = savedLaunch(continued.details.asyncId!);
			assert.equal(successor.generatedOutputFilename, undefined);
			assert.equal(successor.output, output === false ? false : path.join(tempDir, output));
			assert.deepEqual(fs.readFileSync(previous.output), bytes);
			if (typeof successor.output === "string") assert.equal(fs.readFileSync(successor.output, "utf8"), "Override report");
		});
	}

	it("generated output survives continuation with debug artifacts disabled", async () => {
		mockPi.onCall({ output: "Predecessor report" });
		const original = await run({ ...writer, async: true, artifacts: false });
		assert.equal(savedLaunch(original.details.asyncId!).artifacts, false);
		await continueWithOwnOutput(original.details.asyncId!);
	});

	it("explicit continuation output:true selects the saved default instead of an earlier fixed override", async () => {
		mockPi.onCall({ output: "Fixed predecessor" });
		const original = await run({ ...writer, async: true, output: "fixed.md" });
		profile.output = "changed-current-profile.md";
		mockPi.onCall({ output: "New default report" });
		const continued = await run({ action: "resume", id: original.details.asyncId, message: "Use the default", output: true });
		const successor = savedLaunch(continued.details.asyncId!);
		assert.ok(typeof successor.output === "string");
		assert.ok(path.basename(successor.output).startsWith(`${continued.details.asyncId}_writer_0_`));
		assert.ok(successor.output.endsWith("_frozen.md"));
		assert.equal(successor.generatedOutputFilename, "frozen.md");
		assert.equal(fs.readFileSync(successor.output, "utf8"), "New default report");
		assert.equal(fs.readFileSync(path.join(tempDir, "fixed.md"), "utf8"), "Fixed predecessor");
	});

	for (const clarify of [false, true]) {
		it(`async absolute default remains fixed in inline mode (clarify:${clarify})`, async () => {
			profile.output = path.join(tempDir, "absolute.md");
			ctx.hasUI = clarify;
			ctx.ui.custom = async () => ({ confirmed: true, templates: [writer.task], behaviorOverrides: [], runInBackground: true });
			mockPi.onCall({ output: "Absolute predecessor" });
			const original = await run({ ...writer, async: true, clarify, outputMode: "inline" });
			assert.equal(savedLaunch(original.details.asyncId!).generatedOutputFilename, undefined);
			assert.equal(fs.readFileSync(profile.output, "utf8"), "Absolute predecessor");
			mockPi.onCall({ output: "Absolute successor" });
			const continued = await run({ action: "resume", id: original.details.asyncId, message: "Replace fixed output" });
			assert.equal(savedLaunch(continued.details.asyncId!).output, profile.output);
			assert.equal(fs.readFileSync(profile.output, "utf8"), "Absolute successor");
		});
	}

	it("a successor's newly written file wins over its assistant receipt without touching the predecessor", async () => {
		mockPi.onCall({ output: "Predecessor report" });
		const original = await run({ ...writer, async: true });
		const previous = savedLaunch(original.details.asyncId!);
		assert.ok(typeof previous.output === "string");
		const bytes = fs.readFileSync(previous.output);
		mockPi.onCall({ output: "Short assistant receipt", delay: 300 });
		const pending = run({ action: "resume", id: original.details.asyncId, message: "Write the detailed successor report" });
		await waitFor(() => mockPi.callCount() === 2, "successor child must start before its file is written");
		const successor = savedLaunch([...runIds].at(-1)!);
		assert.ok(typeof successor.output === "string");
		fs.mkdirSync(path.dirname(successor.output), { recursive: true });
		fs.writeFileSync(successor.output, "Detailed child-written report\n");
		const continued = await pending;
		const payload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${continued.details.asyncId}.json`), "utf8")) as AsyncResultFile;
		const artifactPath = payload.results?.[0]?.artifactPaths?.outputPath;
		assert.ok(artifactPath);
		assert.equal(fs.readFileSync(artifactPath, "utf8"), "Detailed child-written report");
		assert.equal(fs.readFileSync(successor.output, "utf8"), "Detailed child-written report\n");
		assert.deepEqual(fs.readFileSync(previous.output), bytes);
	});

	it("legacy snapshots without origin proof retain matching-looking generated paths", async () => {
		mockPi.onCall({ output: "Legacy report" });
		const original = await run({ ...writer, async: true });
		const id = original.details.asyncId!;
		const legacy = { ...savedLaunch(id) };
		delete legacy.generatedOutputFilename;
		saveQuestionContract(id, 0, { launch: legacy });
		const receipt = contractBytes(id);
		assert.ok(typeof legacy.output === "string");
		assert.ok(legacy.output.includes(id));
		mockPi.onCall({ output: "Legacy replacement" });
		const continued = await run({ action: "resume", id, message: "Use the saved output choice" });
		const successor = savedLaunch(continued.details.asyncId!);
		assert.equal(successor.output, legacy.output);
		assert.equal(successor.generatedOutputFilename, undefined);
		assert.equal(fs.readFileSync(legacy.output, "utf8"), "Legacy replacement");
		assert.deepEqual(contractBytes(id), receipt, "do not migrate legacy receipts");
	});

	for (const action of ["resume", "answer"] as const) {
		for (const outputMode of ["inline", "file-only"] as const) {
			it(`explicit profile ${action} retains the original generated filename (${outputMode})`, async () => {
				mockPi.onCall({ output: "Predecessor report" });
				const original = await run({ ...writer, async: true, outputMode });
				const id = original.details.asyncId!;
				const previous = savedLaunch(id);
				assert.ok(typeof previous.output === "string");
				const receipt = contractBytes(id);
				const bytes = fs.existsSync(previous.output) ? fs.readFileSync(previous.output) : undefined;
				const contract = readQuestionContract(id, 0)!;
				const question = action === "answer" ? createSupervisorQuestion({
					runId: id, index: 0, agent: "writer", ownerTarget: "fixture-parent", childTarget: "fixture-child", childSessionId: "fixture-session",
					sessionFile: contract.sessionFile!, cwd: tempDir, pid: contract.pid!, reason: "need_decision", message: "May I continue?",
				}) : undefined;
				profile.output = "changed-current-profile.md";
				profile.systemPrompt = "Use the explicitly selected current profile.";
				mockPi.onCall({ output: "Current-profile successor report" });
				const continued = await run({ action, id, agent: "writer", questionId: question?.questionId, message: "Continue with the current profile" });
				const successor = savedLaunch(continued.details.asyncId!);
				assert.ok(typeof successor.output === "string");
				assert.notEqual(successor.output, previous.output);
				assert.ok(path.basename(successor.output).startsWith(`${continued.details.asyncId}_writer_0_`));
				assert.ok(successor.output.endsWith("_frozen.md"), "profile selection does not replace the saved output choice");
				assert.equal(successor.agent.output, profile.output, "the saved profile must remain the current selected profile");
				assert.match(successor.systemPrompt, /explicitly selected current profile/);
				assert.equal(successor.outputMode, outputMode);
				if (bytes) assert.deepEqual(fs.readFileSync(previous.output), bytes);
				else assert.equal(fs.existsSync(previous.output), false);
				assert.deepEqual(contractBytes(id), receipt);
				if (outputMode === "file-only") assert.equal(fs.readFileSync(successor.output, "utf8"), "Current-profile successor report");
				else assert.equal(fs.existsSync(successor.output), false, "generated inline output still gets consumed");

				mockPi.onCall({ output: "Repeated successor report" });
				const repeated = await run({ action: "resume", id: continued.details.asyncId, message: "Continue again without selecting a profile" });
				const latest = savedLaunch(repeated.details.asyncId!);
				assert.ok(typeof latest.output === "string");
				assert.notEqual(latest.output, successor.output);
				assert.ok(latest.output.endsWith("_frozen.md"), "the preserved filename survives another saved continuation");
				assert.equal(latest.agent.output, profile.output);
				if (outputMode === "file-only") assert.equal(fs.readFileSync(latest.output, "utf8"), "Repeated successor report");
				else assert.equal(fs.existsSync(latest.output), false);
			});
		}
	}

	for (const choice of ["explicit", "absolute-default", "disabled", "legacy", "no-launch", "new-default"] as const) {
		it(`explicit profile selection preserves ${choice} output intent`, async () => {
			if (choice === "absolute-default") profile.output = path.join(tempDir, "absolute.md");
			mockPi.onCall({ output: "Predecessor report" });
			const original = await run({ ...writer, async: true,
				...(choice === "explicit" ? { output: "fixed.md" } : {}),
				...(choice === "disabled" ? { output: false, outputMode: "inline" } : {}),
			});
			const id = original.details.asyncId!;
			const previous = savedLaunch(id);
			if (choice === "legacy") {
				const legacy = { ...previous };
				delete legacy.generatedOutputFilename;
				Reflect.deleteProperty(legacy, "outputFromAgentDefault");
				saveQuestionContract(id, 0, { launch: legacy });
			}
			if (choice === "no-launch") saveQuestionContract(id, 0, { launch: undefined });
			const receipt = contractBytes(id);
			profile.output = "changed-current-profile.md";
			mockPi.onCall({ output: "Current-profile report" });
			const continued = await run({ action: "resume", id, agent: "writer", message: "Use the current profile",
				...(choice === "new-default" ? { output: true } : {}),
			});
			const successor = savedLaunch(continued.details.asyncId!);
			assert.equal(successor.agent.output, profile.output);
			assert.deepEqual(contractBytes(id), receipt);
			if (choice === "new-default") {
				assert.ok(typeof successor.output === "string");
				assert.ok(successor.output.endsWith("_changed-current-profile.md"));
				assert.notEqual(successor.output, previous.output);
			} else {
				assert.equal(successor.output, previous.output, "fixed, disabled and unproven choices remain unchanged");
				assert.equal(successor.generatedOutputFilename, undefined);
			}
		});
	}

	for (const action of ["answer", "resume"] as const) {
		it(`${action} revives an exited question with a successor-owned default output`, async () => {
			mockPi.onCall({ output: "Predecessor report" });
			const original = await run({ ...writer, async: true });
			const id = original.details.asyncId!;
			const contract = readQuestionContract(id, 0)!;
			const previous = savedLaunch(id);
			assert.ok(typeof previous.output === "string");
			const bytes = fs.readFileSync(previous.output);
			assert.ok(contract.pid && !questionProcessAlive({ pid: contract.pid }));
			const question = createSupervisorQuestion({
				runId: id, index: 0, agent: "writer", ownerTarget: "fixture-parent", childTarget: "fixture-child", childSessionId: "fixture-session",
				sessionFile: contract.sessionFile!, cwd: tempDir, pid: contract.pid,
				reason: "need_decision", message: "May I write the follow-up?",
			});
			const receipt = contractBytes(id);
			profile.output = "changed-current-profile.md";
			mockPi.onCall({ output: "Answered report" });
			const continued = await run({ action, id, questionId: question.questionId, message: "Yes, write the follow-up" });
			const successor = savedLaunch(continued.details.asyncId!);
			assert.ok(typeof successor.output === "string");
			assert.notEqual(successor.output, previous.output);
			assert.ok(path.basename(successor.output).startsWith(`${continued.details.asyncId}_writer_0_`));
			assert.ok(successor.output.endsWith("_frozen.md"));
			assert.equal(successor.generatedOutputFilename, "frozen.md");
			assert.equal(successor.outputMode, "file-only");
			assert.equal(fs.readFileSync(successor.output, "utf8"), "Answered report");
			assert.deepEqual(fs.readFileSync(previous.output), bytes);
			assert.deepEqual(contractBytes(id), receipt);
		});
	}

	it("rejects file-only with output:false before any child starts", async () => {
		const result = await executor.execute("disabled-file-only", { ...writer, output: false, async: true }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content.map((part) => part.text).join("\n"), /does not configure an output file/);
		assert.equal(mockPi.callCount(), 0);
	});
});
