import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { RESULTS_DIR } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

describe("chain contracts through the detached owner", () => {
	const mock = createMockPi();
	let cwd: string;
	let state;
	before(() => mock.install());
	after(() => mock.uninstall());
	beforeEach(() => {
		cwd = createTempDir("chain-owner-");
		mock.reset();
		state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), ownedRuns: new Map(), lastForegroundControlId: null };
	});
	afterEach(() => {
		for (const run of state.ownedRuns.values()) {
			removeTempDir(getRunMetadataDir(run.runId));
			fs.rmSync(path.join(RESULTS_DIR, `${run.runId}.json`), { force: true });
		}
		removeTempDir(cwd);
	});
	function executor(agents = [makeAgent("worker")]) {
		return createSubagentExecutor({ pi: { events: createEventBus(), getSessionName: () => undefined }, state,
			config: {}, asyncByDefault: false, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd,
			expandTilde: (value) => value, discoverAgents: () => ({ agents }) });
	}
	function calls() {
		return fs.readdirSync(mock.dir).filter((file) => /^call-.*\.json$/.test(file)).sort()
			.map((file) => JSON.parse(fs.readFileSync(path.join(mock.dir, file), "utf8")));
	}

	it("does not open preview merely because a UI is available", async () => {
		mock.onCall({ output: "Done" });
		const ctx = { ...makeMinimalCtx(cwd), hasUI: true, ui: { custom: async () => { assert.fail("No preview requested"); } } };
		const result = await executor().execute("preview", { chain: [{ agent: "worker", task: "Inspect" }] }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(result.details.results[0].finalOutput, "Done");
	});

	for (const parallel of [false, true]) it(`passes file references and named outputs downstream (${parallel ? "parallel" : "sequential"})`, async () => {
		mock.onCall({ output: "full chain output\nwith details" });
		mock.onCall({ output: "Consumed references" });
		const producer = { agent: "worker", task: "Produce", as: "report", output: "report.md", outputMode: "file-only" };
		const chain = [parallel ? { parallel: [producer] } : producer, { agent: "worker", task: "Previous {previous}; Named {outputs.report}" }];
		const result = await executor().execute("files", { chain, chainDir: cwd }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const child = result.details.results[0];
		assert.match(child.finalOutput, /Output saved to:/);
		assert.equal(fs.readFileSync(child.savedOutputPath, "utf8"), "full chain output\nwith details");
		const task = calls()[1].expandedArgs.at(-1);
		assert.match(task, /Previous[\s\S]*Output saved to:[\s\S]*Named[\s\S]*Output saved to:/);
		assert.match(task, /2 lines/);
		assert.doesNotMatch(task, /full chain output/);
	});

	it("passes successful static named outputs to downstream consumers", async () => {
		mock.onCall({ matchArgsIncludes: "First", output: "FIRST_EVIDENCE" });
		mock.onCall({ matchArgsIncludes: "Second", output: "SECOND_EVIDENCE" });
		mock.onCall({ matchArgsIncludes: "Consume", output: "Done" });
		const chain = [{ parallel: [{ agent: "worker", task: "First", as: "first" }, { agent: "worker", task: "Second", as: "second" }] },
			{ agent: "worker", task: "Consume {outputs.first} and {outputs.second}" }];
		const result = await executor().execute("names", { chain }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(result.details.outputs.first.text, "FIRST_EVIDENCE");
		assert.equal(result.details.outputs.second.text, "SECOND_EVIDENCE");
		assert.match(calls()[2].expandedArgs.at(-1), /Consume FIRST_EVIDENCE and SECOND_EVIDENCE/);
	});

	it("preflights static file-only groups before starting any sibling", async () => {
		const result = await executor().execute("invalid-group", { chain: [{ parallel: [
			{ agent: "worker", task: "Valid sibling" }, { agent: "worker", task: "Invalid sibling", outputMode: "file-only" },
		] }] }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /outputMode: "file-only"/);
		assert.equal(mock.callCount(), 0);
		assert.equal(state.ownedRuns.size, 0, "rejected plans must not leave phantom owned children");
	});

	it("rejects duplicate, unknown and malformed output references before spawning", async () => {
		for (const [chain, expected] of [
			[[{ agent: "worker", task: "One", as: "same" }, { agent: "worker", task: "Two", as: "same" }], /Duplicate chain output name 'same'/],
			[[{ agent: "worker", task: "Use {outputs.missing}" }], /Unknown chain output reference/],
			[[{ agent: "worker", task: "Use {outputs.bad-name}" }], /Invalid chain output reference/],
		]) {
			const result = await executor().execute("invalid-name", { chain }, undefined, undefined, makeMinimalCtx(cwd));
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, expected);
			assert.equal(mock.callCount(), 0);
			assert.equal(state.ownedRuns.size, 0, "invalid output bindings must not register a run");
		}
	});

	it("requires valid structured output and leaves downstream work pending on failure", async () => {
		const outputSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
		for (const [structuredOutput, expected] of [[undefined, /Missing structured_output call/], [{ ok: "yes" }, /Structured output validation failed/]]) {
			mock.reset();
			mock.onCall({ output: "prose", structuredOutput });
			const result = await executor().execute("schema", { chain: [
				{ agent: "worker", task: "Return structured", outputSchema, as: "payload" }, { agent: "worker", task: "Must not run" },
			] }, undefined, undefined, makeMinimalCtx(cwd));
			assert.equal(result.isError, true);
			assert.match(result.details.results[0].error, expected);
			assert.equal(result.details.workflowGraph.nodes[0].status, "failed");
			assert.equal(result.details.workflowGraph.nodes[1].status, "pending");
			assert.equal(mock.callCount(), 1);
		}
	});

	it("rejects dynamic file-only children without launching them", async () => {
		mock.onCall({ output: "Targets", structuredOutput: { items: ["a"] } });
		const result = await executor().execute("dynamic-file", { chain: [
			{ agent: "worker", task: "List", as: "targets", outputSchema: { type: "object" } },
			{ expand: { from: { output: "targets", path: "/items" }, maxItems: 2 }, parallel: { agent: "worker", task: "Review {item}", outputMode: "file-only" }, collect: { as: "reviews" } },
		] }, undefined, undefined, makeMinimalCtx(cwd));
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /outputMode: "file-only"/);
		assert.equal(mock.callCount(), 0, "the router rejects invalid file-only templates before launching the source");
	});

	it("tightens recursion per agent without relaxing an inherited maximum", async () => {
		const saved = process.env.PI_SUBAGENT_MAX_DEPTH;
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		try {
			for (const [maxSubagentDepth, expected] of [[1, "1"], [9, "2"]]) {
				mock.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
				const result = await executor([makeAgent("worker", { maxSubagentDepth })]).execute("depth", { chain: [{ agent: "worker", task: "Inspect depth" }] }, undefined, undefined, makeMinimalCtx(cwd));
				assert.equal(result.isError, undefined, JSON.stringify(result.content));
				assert.deepEqual(calls().at(-1).env, { PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: expected });
			}
		} finally { if (saved === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH; else process.env.PI_SUBAGENT_MAX_DEPTH = saved; }
	});
});
