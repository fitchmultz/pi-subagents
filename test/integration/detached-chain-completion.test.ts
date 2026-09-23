import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { OWNED_RUN_ENTRY, restoreOwnedRuns } from "../../src/runs/shared/run-records.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, type SubagentState } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const sdkRoot = process.env.PI_OWNERSHIP_TEST_PACKAGE_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { SessionManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/session-manager.js")).href);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for the controlled detached child to settle");
		await delay(20);
	}
}

describe("detached chain workflow completion", { timeout: 30_000 }, () => {
	const mock = createMockPi();
	before(() => mock.install());
	after(() => mock.uninstall());

	const cases = [
		{ name: "sequential downstream continues after releasing the wait", shape: "sequential", detach: true, downstream: true, expected: "completed" },
		{ name: "static downstream continues after releasing the wait", shape: "static", detach: true, downstream: true, expected: "completed" },
		{ name: "dynamic collection and downstream finish after releasing the wait", shape: "dynamic", detach: true, downstream: true, expected: "completed" },
		{ name: "terminal dynamic collection publishes after releasing the wait", shape: "dynamic", detach: true, expected: "completed" },
		{ name: "terminal dynamic schema failure survives releasing the wait", shape: "dynamic", detach: true, invalidCollection: true, expected: "failed" },
		{ name: "terminal sequential child really completes", shape: "sequential", detach: true, expected: "completed" },
		{ name: "terminal static group really completes", shape: "static", detach: true, expected: "completed" },
		{ name: "terminal child after an empty fanout really completes", shape: "sequential", detach: true, emptyBefore: true, expected: "completed" },
		{ name: "validated terminal dynamic collection really completes", shape: "dynamic", expected: "completed" },
		{ name: "invalid terminal dynamic collection fails without failing children", shape: "dynamic", invalidCollection: true, expected: "failed" },
		{ name: "validated empty terminal collection really completes", shape: "dynamic", empty: true, expected: "completed" },
		{ name: "invalid empty terminal collection fails without failing children", shape: "dynamic", empty: true, invalidCollection: true, expected: "failed" },
	];
	for (const scenario of cases) it(scenario.name, async () => {
		mock.reset();
		const cwd = createTempDir("detached-chain-");
		const release = path.join(cwd, "release-child");
		const parentFile = path.join(cwd, "parent.jsonl");
		fs.writeFileSync(parentFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd, timestamp: new Date().toISOString() })}\n`);
		let parent = SessionManager.open(parentFile);
		const route = createNestedRoute(randomUUID());
		const nestedEnv = {
			PI_SUBAGENT_PARENT_ROOT_RUN_ID: route.rootRunId,
			PI_SUBAGENT_PARENT_RUN_ID: route.rootRunId,
			PI_SUBAGENT_PARENT_CHILD_INDEX: "0",
			PI_SUBAGENT_PARENT_DEPTH: "1",
			PI_SUBAGENT_PARENT_EVENT_SINK: route.eventSink,
			PI_SUBAGENT_PARENT_CONTROL_INBOX: route.controlInbox,
			PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: route.capabilityToken,
		};
		const previousEnv = Object.fromEntries(Object.keys(nestedEnv).map((key) => [key, process.env[key]]));
		Object.assign(process.env, nestedEnv);
		const makeState = () => ({
			baseCwd: cwd, currentSessionId: parentFile, asyncJobs: new Map(), foregroundRuns: new Map(),
			ownedRuns: new Map(), completionSeen: new Map(), cleanupTimers: new Map(), persistOwnedRun: (run) => parent.appendCustomEntry(OWNED_RUN_ENTRY, run),
		} as SubagentState);
		let state = makeState();
		const ctx = { ...makeMinimalCtx(cwd), sessionManager: parent };
		const bus = createEventBus();
		const makeExecutor = () => createSubagentExecutor({
			pi: { events: bus, getSessionName: () => "chain-parent" }, state, config: {}, asyncByDefault: false, tempArtifactsDir: cwd,
			getSubagentSessionRoot: () => path.join(cwd, "sessions"), expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }),
		});
		let executor = makeExecutor();
		const invoke = (params, onUpdate?) => executor.execute(randomUUID(), params, new AbortController().signal, onUpdate, ctx);
		const tokens = scenario.empty ? [] : ["WF_OK", "WF_WAIT"];
		mock.onCall({ matchArgsIncludes: "WF_SOURCE", output: "PREFIX_EVIDENCE", structuredOutput: { items: tokens, empty: [] } });
		mock.onCall({ matchArgsIncludes: "WF_OK", output: "SUCCESSFUL_SIBLING_EVIDENCE" });
		mock.onCall({ matchArgsIncludes: "WF_DOWNSTREAM", output: "DEPENDENT_STEP_FINISHED" });
		mock.onCall({ matchArgsIncludes: "WF_WAIT", steps: [
			...(scenario.detach ? [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision" })] }, { waitForFile: release }] : []),
			{ jsonl: [events.assistantMessage("DETACHED_CHILD_FINISHED")] },
		] });
		const task = (token: string) => ({ agent: "worker", task: token, output: false });
		const dynamic = (outputPath: string, as: string, outputSchema = { type: "array" }) => ({
			expand: { from: { output: "targets", path: outputPath }, maxItems: 2, onEmpty: "skip" },
			parallel: task("{item}"), collect: { as, outputSchema }, concurrency: 1,
		});
		const chain = [
			{ ...task("WF_SOURCE"), as: "targets", outputSchema: { type: "object" } },
			...(scenario.emptyBefore ? [dynamic("/empty", "emptyCollection")] : []),
			scenario.shape === "sequential" ? task("WF_WAIT") : scenario.shape === "static"
				? { parallel: tokens.map(task), concurrency: 1 }
				: dynamic("/items", "collected", { type: scenario.invalidCollection ? "object" : "array" }),
			...(scenario.downstream ? [task("WF_DOWNSTREAM")] : []),
		];
		let runId: string | undefined;
		let detached = false;
		try {
			const response = await invoke({ chain, async: false, context: "fresh", artifacts: false }, (update) => {
				if (!scenario.detach || detached || !update.details?.progress?.some((progress) => progress.currentTool === "contact_supervisor")) return;
				detached = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: randomUUID() });
			});
			runId = response.details.runId ?? response.details.wait?.runId;
			assert.ok(runId, JSON.stringify(response));
			const initial = JSON.parse(JSON.stringify(response));
			if (scenario.detach) {
				assert.equal(detached, true);
				assert.equal(initial.details.wait.status, "yielded");
				assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")), false);
				fs.writeFileSync(release, "");
			}
			await waitFor(() => fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")));
			const beforeReload = await invoke({ action: "status", id: runId });
			const durable = readJson(path.join(getRunMetadataDir(runId), "result.json"));
			assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "foreground.json")), false);
			const nested = fs.readdirSync(route.eventSink).map((file) => readJson(path.join(route.eventSink, file))).filter((event) => event.child?.id === runId && event.type === "subagent.nested.completed");
			const calls = fs.readdirSync(mock.dir).filter((file) => file.startsWith("call-")).sort().map((file) => readJson(path.join(mock.dir, file)));
			parent = SessionManager.open(parentFile);
			ctx.sessionManager = parent;
			state = makeState();
			restoreOwnedRuns(state, ctx);
			executor = makeExecutor();
			const inspection = await invoke({ action: "status", id: runId });
			const parentEntries = parent.getEntries();
			if (process.env.PI_CHAIN_SETTLEMENT_EVIDENCE_DIR) {
				const dir = process.env.PI_CHAIN_SETTLEMENT_EVIDENCE_DIR;
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, `${scenario.name.replaceAll(" ", "-")}.json`), JSON.stringify({ scenario, runId, initial, beforeReload, durable, inspection, nested, calls, parentEntries }, null, 2));
			}
			const saved = inspection.details.run!;
			const expectedCalls = ["WF_SOURCE", ...(scenario.empty ? [] : scenario.shape === "sequential" ? ["WF_WAIT"] : tokens), ...(scenario.downstream ? ["WF_DOWNSTREAM"] : [])];
			assert.deepEqual(calls.map((call) => call.expandedArgs.at(-1).match(/WF_(SOURCE|OK|WAIT|DOWNSTREAM)/)?.[0]), expectedCalls, "releasing a wait must not skip dependent work");
			assert.equal(saved.runId, runId);
			assert.equal(saved.ownerSessionId, parent.getSessionId());
			assert.ok(parentEntries.some((entry) => entry.type === "custom" && entry.customType === OWNED_RUN_ENTRY && entry.data.runId === runId));
			assert.equal(saved.children.length, expectedCalls.length, "workflow-level failures must not invent a child");
			const physical = saved.children.filter((child) => child.result?.agentProcessExit);
			assert.equal(physical.length, expectedCalls.length, "every launched child retains a real process receipt");
			assert.ok(physical.every((child) => child.state === "completed" && child.result?.exitCode === 0 && !child.result?.error), "successful children remain successful even if collection validation fails");
			assert.equal(saved.children[0].result.finalOutput, "PREFIX_EVIDENCE");
			if (!scenario.empty) assert.equal(physical.find((child) => child.task?.startsWith("WF_WAIT")).result.finalOutput, "DETACHED_CHILD_FINISHED");
			if (scenario.downstream) assert.equal(physical.at(-1).result.finalOutput, "DEPENDENT_STEP_FINISHED");
			assert.ok(physical.every((child) => child.configuration === "saved" && fs.existsSync(child.sessionFile)));
			assert.equal(nested.length, 1, "one terminal nested event after settlement");
			assert.ok(nested[0].child.steps.every((child) => child.status === "complete"));
			assert.deepEqual({ beforeReload: beforeReload.details.run.state, saved: saved.state, durable: durable.state, nested: nested[0].child.state }, {
				beforeReload: scenario.expected, saved: scenario.expected, durable: scenario.expected === "completed" ? "complete" : scenario.expected, nested: scenario.expected === "completed" ? "complete" : scenario.expected,
			});
			if (scenario.shape === "dynamic") {
				if (scenario.invalidCollection) assert.equal(durable.outputs.collected, undefined);
				else assert.equal(durable.outputs.collected.structured.length, tokens.length);
			}
		} finally {
			if (runId && !fs.existsSync(path.join(getRunMetadataDir(runId), "result.json"))) {
				await invoke({ action: "interrupt", id: runId });
				await waitFor(() => fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")));
			}
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			if (runId) removeTempDir(getRunMetadataDir(runId));
			removeTempDir(path.dirname(route.eventSink));
			removeTempDir(cwd);
		}
	});
});
