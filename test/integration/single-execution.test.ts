/** Single-agent contracts through the public executor and detached owner. */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents } from "../../src/agents/agents.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_INHERITED_EXTENSIONS_JSON_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { setTimeout as delay } from "node:timers/promises";
import { RESULTS_DIR } from "../../src/shared/types.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";

import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
} from "../support/helpers.ts";

function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}

describe("single owner execution", () => {
	let tempDir: string;
	let mockPi: MockPi;
	let state;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
		state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), ownedRuns: new Map(), lastForegroundControlId: null };
	});

	afterEach(() => {
		for (const run of state.ownedRuns.values()) {
			removeTempDir(getRunMetadataDir(run.runId));
			fs.rmSync(path.join(RESULTS_DIR, `${run.runId}.json`), { force: true });
		}
		removeTempDir(tempDir);
	});

	function readLastCall(): { args: string[]; expandedArgs?: string[]; cwd?: string; env?: Record<string, string | null> } {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[]; expandedArgs?: string[]; cwd?: string; env?: Record<string, string | null> };
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return { args: payload.args, expandedArgs: payload.expandedArgs, cwd: payload.cwd, env: payload.env };
	}

	function readCallArgs(): string[] {
		return readLastCall().args;
	}

	function makeExecutor(agents = [makeAgent("echo")]) {
		return createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	it("launches long and task-named agents with separate prompt files and long task contents", async () => {
		const agentDir = path.join(tempDir, ".pi", "agents");
		fs.mkdirSync(agentDir, { recursive: true });
		const task = "Analyze ".repeat(2000);
		for (const name of ["a".repeat(246), "task"]) {
			fs.writeFileSync(path.join(agentDir, "probe.md"), `---\nname: ${name}\ndescription: filename boundary\nsystemPromptMode: replace\n---\nRead-only reviewer.`);
			const { agents } = discoverAgents(tempDir, "project");
			mockPi.reset();
			mockPi.onCall({ output: "Review complete." });
			const result = await makeExecutor(agents).execute("long", { agent: name, task }, undefined, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			assert.equal(result.details.results[0].finalOutput, "Review complete.");
			assert.equal(mockPi.callCount(), 1);
			const call = readLastCall();
			const taskArg = call.args.at(-1)!;
			assert.ok(taskArg.startsWith("@"));
			assert.ok(call.args.includes("--system-prompt"));
			assert.notEqual(call.args[call.args.indexOf("--system-prompt") + 1], taskArg.slice(1));
			assert.equal(call.expandedArgs?.at(-1), `${taskArg}\nTask: ${task}`);
		}
	});

	it("ignores null JSON records without losing the final answer", async () => {
		mockPi.onCall({ jsonl: [null, events.assistantMessage("still completed")] });
		const result = await makeExecutor().execute("null", { agent: "echo", task: "Handle output" }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined);
		assert.equal(result.details.results[0].finalOutput, "still completed");
	});

	it("inherits bridge permissions, extensions and effective cwd through the owner", async () => {
		const taskCwd = path.join(tempDir, "nested");
		fs.mkdirSync(taskCwd);
		writePackageSkill(tempDir, "runtime-fallback-skill");
		const keys = [SUBAGENT_INHERITED_EXTENSIONS_JSON_ENV, "REPOPROMPT_PI_PERMISSION_LEVEL", "REPOPROMPT_PI_MANAGED_RUN"];
		const saved = keys.map((key) => process.env[key]);
		try {
			process.env[SUBAGENT_INHERITED_EXTENSIONS_JSON_ENV] = JSON.stringify(["/tmp/repoprompt-bridge-window-1.ts"]);
			process.env.REPOPROMPT_PI_PERMISSION_LEVEL = "readOnly";
			process.env.REPOPROMPT_PI_MANAGED_RUN = "1";
			mockPi.onCall({ output: "Done", echoEnv: keys.slice(1) });
			const agent = makeAgent("echo", { skills: ["runtime-fallback-skill"], extensions: ["./allowed-ext.ts"], tools: ["read", "./custom-tool.ts"] });
			const result = await makeExecutor([agent]).execute("bridge", { tasks: [{ agent: "echo", task: "Inspect", cwd: "nested" }] }, undefined, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			assert.deepEqual(result.details.results[0].skills, ["runtime-fallback-skill"]);
			const call = readLastCall();
			assert.equal(fs.realpathSync(call.cwd!), fs.realpathSync(taskCwd));
			assert.deepEqual(call.env, { REPOPROMPT_PI_PERMISSION_LEVEL: "readOnly", REPOPROMPT_PI_MANAGED_RUN: "1" });
			assert.ok(call.args.includes("--no-extensions"));
			const extensions = call.args.filter((arg, index) => call.args[index - 1] === "--extension");
			for (const extension of ["/tmp/repoprompt-bridge-window-1.ts", "./allowed-ext.ts", "./custom-tool.ts"]) assert.ok(extensions.includes(extension));
			assert.ok(extensions.some((extension) => extension.endsWith("subagent-prompt-runtime.ts")));
		} finally { keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }); }
	});

	for (const allowed of [false, true, "implicit"] as const) it(`passes nested routing only for allowed fanout (${allowed})`, async () => {
		const keys = [SUBAGENT_FANOUT_CHILD_ENV, SUBAGENT_PARENT_EVENT_SINK_ENV, SUBAGENT_PARENT_CONTROL_INBOX_ENV, SUBAGENT_PARENT_RUN_ID_ENV, SUBAGENT_PARENT_CHILD_INDEX_ENV];
		mockPi.onCall({ echoEnv: keys });
		const agent = makeAgent("echo", allowed === "implicit" ? { allowSubagents: true } : { tools: allowed ? ["read", "subagent"] : ["read"] });
		const result = await makeExecutor([agent]).execute("fanout", { agent: "echo", task: "Inspect" }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const env = readLastCall().env!;
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], allowed ? "1" : "0");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], allowed ? result.details.runId : "");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], allowed ? "0" : "");
		for (const key of [SUBAGENT_PARENT_EVENT_SINK_ENV, SUBAGENT_PARENT_CONTROL_INBOX_ENV]) assert.equal(Boolean(env[key]), Boolean(allowed));
	});

	it("keeps every exhausted fallback failure and baselines output per attempt", async () => {
		const output = path.join(tempDir, "fallback.md");
		const agent = makeAgent("echo", { model: "mock/primary", fallbackModels: ["mock/fallback"] });
		for (const recover of [false, true]) {
			mockPi.reset();
			const failure = { jsonl: [{ type: "message_end", message: { role: "assistant", content: [], errorMessage: "429 quota exceeded", stopReason: "error" } }] };
			mockPi.onCall({ ...failure, delay: 300 });
			mockPi.onCall(recover ? { output: "fresh fallback answer" } : failure);
			const pending = makeExecutor([agent]).execute("fallback", { agent: "echo", task: "Work", output }, undefined, undefined, makeMinimalCtx(tempDir));
			while (!mockPi.callCount()) await delay(10);
			fs.writeFileSync(output, "stale primary output");
			const result = await pending;
			const child = result.details.results[0];
			assert.equal(child.exitCode, recover ? 0 : 1);
			assert.deepEqual(child.modelAttempts.map((attempt) => attempt.success), [false, recover]);
			assert.deepEqual(child.attemptedModels, ["mock/primary", "mock/fallback"]);
			if (recover) {
				assert.equal(child.finalOutput, "fresh fallback answer");
				assert.equal(fs.readFileSync(output, "utf8"), "fresh fallback answer");
			} else assert.match(child.error, /429 quota exceeded/);
		}
	});

	it("does not retry ordinary task failures", async () => {
		mockPi.onCall({ jsonl: [events.toolResult("bash", "process exited with code 127")], exitCode: 0 });
		const result = await makeExecutor([makeAgent("echo", { model: "mock/primary", fallbackModels: ["mock/fallback"] })])
			.execute("ordinary", { agent: "echo", task: "Work" }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.details.results[0].exitCode, 127);
		assert.equal(mockPi.callCount(), 1);
	});

	for (const failure of [{ exitCode: 143 }, { exitCode: 1, stderr: "database is locked" }]) it(`recovers on the same model from ${failure.stderr ?? failure.exitCode}`, async () => {
		mockPi.onCall(failure);
		mockPi.onCall({ output: "Recovered" });
		const result = await makeExecutor([makeAgent("echo", { model: "mock/primary", fallbackModels: ["mock/fallback"] })])
			.execute("recovery", { agent: "echo", task: "Work" }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(result.details.results[0].finalOutput, "Recovered");
		assert.deepEqual(result.details.results[0].attemptedModels, ["mock/primary", "mock/primary"]);
		assert.match(result.details.results[0].modelAttempts[0].error, /143|database is locked/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("retains informative prior failure when same-model recovery is empty", async () => {
		mockPi.onCall({ jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Partial work" }], stopReason: "tool_use" } }], exitCode: 143 });
		mockPi.onCall({ exitCode: 1 });
		const result = await makeExecutor([makeAgent("echo", { model: "mock/primary" })]).execute("empty-retry", { agent: "echo", task: "Work" }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, true);
		const child = result.details.results[0];
		assert.equal(child.modelAttempts.length, 2);
		assert.match(child.error, /without producing a final assistant response/);
		assert.match(child.error, /Previous attempt.*143/);
	});

	it("timeout does not fall back and no-deadline extension is rejected", async () => {
		const executor = makeExecutor([makeAgent("echo", { model: "mock/primary", fallbackModels: ["mock/fallback"] })]);
		mockPi.onCall({ delay: 10000 });
		const timed = await executor.execute("timeout", { agent: "echo", task: "Work", timeoutMs: 500 }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(timed.details.results[0].timedOut, true);
		assert.deepEqual(timed.details.results[0].attemptedModels, ["mock/primary"]);
		mockPi.onCall({ delay: 800, output: "Done" });
		const pending = executor.execute("no-deadline", { agent: "echo", task: "Work" }, undefined, undefined, makeMinimalCtx(tempDir));
		while (state.ownedRuns.size < 2) await delay(10);
		const id = [...state.ownedRuns.keys()].at(-1);
		const extended = await executor.execute("extend", { action: "extend", id, extendMs: 1000 }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(extended.isError, true);
		assert.match(extended.content[0].text, /No live run with an extendable timeout/);
		assert.equal((await pending).isError, undefined);
	});

	it("keeps deadline extensions across same-model recovery", async () => {
		mockPi.onCall({ exitCode: 143, delay: 200 });
		mockPi.onCall({ output: "Recovered after extension", delay: 1200 });
		const executor = makeExecutor([makeAgent("echo", { model: "mock/primary" })]);
		const pending = executor.execute("extend-recovery", { agent: "echo", task: "Work", timeoutMs: 1000 }, undefined, undefined, makeMinimalCtx(tempDir));
		while (!mockPi.callCount()) await delay(10);
		const id = [...state.ownedRuns.keys()][0];
		const extended = await executor.execute("extend", { action: "extend", id, extendMs: 5000 }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(extended.isError, undefined, JSON.stringify(extended.content));
		const result = await pending;
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.deepEqual(result.details.results[0].attemptedModels, ["mock/primary", "mock/primary"]);
	});

	it("passes the owning Pi root through foreground spawn", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_ROOT_SESSION_ID"] });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => "actual-owner-uuid";
		const result = await executor.execute("root-inheritance", { agent: "echo", task: "Check root", output: false }, new AbortController().signal, undefined, ctx) as any;
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(readLastCall().env?.PI_SUBAGENT_ROOT_SESSION_ID, "actual-owner-uuid");
	});

	it("keeps explicit single output paths in the workspace", async () => {
		mockPi.onCall({ output: "workspace report" });
		const executor = makeExecutor([makeAgent("echo")]);
		const outputPath = path.join(tempDir, "explicit-report.md");

		const result = await executor.execute(
			"single-explicit-output",
			{ agent: "echo", task: "Write report", output: "explicit-report.md" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		) as any;

		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "workspace report");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, outputPath);
		assert.equal(result.details?.results?.[0]?.outputCleanup, undefined);
		assert.match(result.content[0]?.text ?? "", /Output saved to:/);
	});

	it("supports outputSchema for top-level single runs", async () => {
		mockPi.onCall({ output: "structured prose", structuredOutput: { ok: true } });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-output-schema",
			{ agent: "echo", task: "Return structured", outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		) as any;

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.results?.[0]?.structuredOutput, { ok: true });
	});

	it("materializes agent-default output while debug artifacts are disabled", async () => {
		mockPi.onCall({ output: "default report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

		const result = await executor.execute(
			"single-default-output-artifact",
			{ agent: "echo", task: "Write report", artifacts: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		const details = (result as any).details;
		const outputReference = details?.results?.[0]?.outputReference?.path ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /default report/);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.match(outputReference, /requested-outputs/);
		assert.match(outputReference, /[a-f0-9]{8}_echo_0_default-report\.md$/);
		assert.equal(details?.results?.[0]?.artifactPaths, undefined);
		assert.equal(details?.results?.[0]?.outputCleanup?.action, "deleted");
		assert.match(readCallArgs().join("\n"), /requested-outputs/);
	});

	it("uses a run-artifact path for agent-default single file-only output", async () => {
		mockPi.onCall({ output: "full default file-only report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-file-only.md" })]);

		const result = await executor.execute(
			"single-default-output-file-only",
			{ agent: "echo", task: "Write report", outputMode: "file-only" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		const details = (result as any).details;
		const outputPath = details?.results?.[0]?.savedOutputPath ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /Output saved to:/);
		assert.doesNotMatch(text, /full default file-only report/);
		assert.equal(fs.existsSync(path.join(tempDir, "default-file-only.md")), false);
		assert.match(outputPath, /requested-outputs/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "full default file-only report");
	});

	it("treats string false as disabled output in foreground single runs", async () => {
		mockPi.onCall({ output: "inline report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

		const result = await executor.execute(
			"single-string-false-output",
			{ agent: "echo", task: "Write report", output: "false" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /inline report/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to:/);
	});

	it("makes skill: false disable inherited skills", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INHERIT_SKILLS"] });
		const executor = makeExecutor([makeAgent("echo", { inheritSkills: true })]);
		const result = await executor.execute(
			"disable-inherited-skills",
			{ agent: "echo", task: "Run without skills", skill: false, output: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		) as any;

		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(readLastCall().env?.PI_SUBAGENT_INHERIT_SKILLS, "0");
		assert.ok(readCallArgs().includes("--no-skills"));
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await makeExecutor(agents).execute("stderr", { agent: "echo", task: "Task" }, undefined, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined);
	});

});
