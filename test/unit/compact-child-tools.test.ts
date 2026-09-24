import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, it } from "node:test";
import { Compile } from "typebox/compile";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "compact-child-tools-"));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
Object.assign(process.env, { PI_CODING_AGENT_DIR: root, PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"), PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_FANOUT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2" });
const { default: register } = await import("../../src/extension/fanout-child.ts");
const { formatRunAction } = await import("../../src/shared/status-format.ts");
const { buildPiArgs } = await import("../../src/runs/shared/pi-args.ts");
const { default: registerPrompt } = await import("../../src/runs/shared/subagent-prompt-runtime.ts");
const { OWNED_RUN_ENTRY } = await import("../../src/runs/shared/run-records.ts");
const configPath = path.join(root, "extensions/subagent/config.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const shutdowns: Array<() => unknown> = [];
afterEach(async () => { for (const shutdown of shutdowns.splice(0)) await shutdown(); delete process.env.PI_SUBAGENT_EAGER_TOOL; });
after(() => { process.env = savedEnv; fs.rmSync(root, { recursive: true, force: true }); });

function fixture(config: object = {}, allowed?: string[], entries: any[] = []) {
	fs.writeFileSync(configPath, JSON.stringify(config));
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	let active = ["read"];
	const pi = {
		events: { on() { return () => {}; }, emit() {} },
		registerTool(tool: any) { tools.set(tool.name, tool); if (!allowed || allowed.includes(tool.name)) active.push(tool.name); },
		on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); if (event === "session_shutdown") shutdowns.push(handler); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		getActiveTools() { return [...active]; },
		getAllTools() { return [...tools.values()].filter((tool) => !allowed || allowed.includes(tool.name)); },
		setActiveTools(names: string[]) { active = names.filter((name) => name === "read" || !allowed || allowed.includes(name)); },
		getSessionName() { return undefined; },
	};
	const ctx = {
		cwd: root, mode: "json", hasUI: false, isProjectTrusted() { return false; },
		sessionManager: { getSessionId() { return "child-owner"; }, getSessionFile() { return null; }, getEntries() { return entries; }, getHeader() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
	};
	register(pi as any);
	const emit = async (event: string, payload: object = {}) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); };
	const call = (name: string, params: object = {}) => tools.get(name).execute("call-" + name, params, undefined, undefined, ctx);
	const definitions = () => pi.getAllTools().filter((tool) => active.includes(tool.name)).map(({ name, description, parameters, promptSnippet, promptGuidelines }) => ({ name, description, parameters, promptSnippet, promptGuidelines }));
	return { pi, tools, ctx, handlers, call, emit, definitions };
}

it("starts compact, lazily activates the complete advanced schema, and resets additively", async () => {
	const f = fixture();
	await f.emit("session_start");
	assert.deepEqual(f.pi.getActiveTools(), ["read", "delegate", "agent_runs", "load_subagent"]);
	assert.match(f.tools.get("delegate").description, /Foreground by default/);
	assert.match(f.tools.get("delegate").parameters.properties.async.description, /Foreground by default/);
	assert.match(f.tools.get("delegate").promptGuidelines.join("\n"), /original parent owns integration/);
	assert.match(f.tools.get("delegate").promptGuidelines.join("\n"), /maxFinalizationTurns/);
	assert.match(f.tools.get("delegate").promptGuidelines.join("\n"), /implementation handoffs/);
	assert.match(f.tools.get("load_subagent").description, /get, extend and doctor/);
	assert.notEqual((await f.call("agent_runs", { action: "profiles" })).isError, true);
	await f.call("load_subagent");
	assert.ok(f.pi.getActiveTools().includes("subagent"));
	const advanced = f.tools.get("subagent");
	const schema = Compile(advanced.parameters);
	for (const params of [
		{ tasks: [{ agent: "probe", task: "parallel", acceptance: { criteria: ["preserve flexible criteria"] } }], concurrency: 2, worktree: true },
		{ chain: [{ agent: "probe", task: "seed", as: "seed", outputSchema: { type: "object" } }, { expand: { from: { output: "seed", path: "/items" }, maxItems: 2 }, parallel: { agent: "probe", task: "{item}" }, collect: { as: "results" } }] },
		{ action: "get", chainName: "workflow" }, { action: "doctor" }, { action: "extend", id: "run", extendMs: 1000 },
	]) assert.ok(schema.Check(params), JSON.stringify(params));
	for (const action of ["create", "update", "delete"]) {
		const blocked = await f.call("subagent", { action, agent: "probe", config: { name: "probe" } });
		assert.equal(blocked.isError, true);
		assert.match(blocked.content[0].text, /not available from child-safe/);
	}
	for (const lifecycle of ["session_tree", "session_compact", "session_start"]) {
		await f.emit(lifecycle);
		assert.deepEqual(f.pi.getActiveTools(), ["read", "delegate", "agent_runs", "load_subagent"]);
		await f.call("load_subagent");
	}
});

it("restores the old full surface with the flag and honors eager/filtered advanced policies", async () => {
	const legacy = fixture({ compactChildTools: false });
	await legacy.emit("session_start");
	assert.deepEqual(legacy.pi.getActiveTools(), ["read", "subagent"]);
	assert.equal(legacy.tools.has("load_subagent"), false);
	assert.match(formatRunAction("resume", "run", { message: "continue" }, true), /^subagent\(\{ action: "resume"/);
	assert.doesNotMatch(formatRunAction("extend", "run", {}, true), /load_subagent/);
	const filtered = fixture({}, ["subagent"]);
	await filtered.emit("session_start");
	assert.deepEqual(filtered.pi.getActiveTools(), ["read", "subagent"]);
	process.env.PI_SUBAGENT_EAGER_TOOL = "1";
	const eager = fixture();
	await eager.emit("session_start");
	assert.ok(eager.pi.getActiveTools().includes("subagent"));
	const denied = fixture({}, ["delegate", "agent_runs", "load_subagent"]);
	await denied.emit("session_start");
	await assert.rejects(() => denied.call("load_subagent"), /full tool is excluded/);
});

it("retains permitted advanced tools for pending native recovery and hides them once settled", async () => {
	const f = fixture();
	let pending = [{ toolCallId: "advanced-call", toolName: "subagent", state: "detached" }];
	Object.assign(f.ctx, { getPendingToolCalls: () => pending });
	await f.emit("session_start");
	assert.ok(f.pi.getActiveTools().includes("subagent"));
	f.pi.setActiveTools(["read", "delegate", "agent_runs", "load_subagent"]);
	await f.emit("session_tree");
	assert.ok(f.pi.getActiveTools().includes("subagent"), "a selected native call remains recoverable even if prior selection hid it");
	pending = [];
	await f.emit("session_compact");
	assert.equal(f.pi.getActiveTools().includes("subagent"), false);
	const denied = fixture({}, ["load_subagent"]);
	Object.assign(denied.ctx, { getPendingToolCalls: () => [{ toolName: "subagent" }] });
	await denied.emit("session_start");
	assert.equal(denied.pi.getActiveTools().includes("subagent"), false, "native recovery does not override an explicit tool exclusion");
});

it("lists only restored direct-owned runs and preserves scoped exact-ID controls", async () => {
	const run = (runId: string, ownerSessionId: string) => ({ runId, ownerSessionId, rootRunId: runId, source: "foreground", mode: "single", cwd: root, task: "Check ownership", startedAt: 1, children: [] });
	const f = fixture({}, ["delegate", "agent_runs", "load_subagent", "subagent"], [
		{ type: "custom", customType: OWNED_RUN_ENTRY, data: run("own-a", "child-owner") },
		{ type: "custom", customType: OWNED_RUN_ENTRY, data: run("own-b", "child-owner") },
		{ type: "custom", customType: OWNED_RUN_ENTRY, data: run("foreign-run", "another-owner") },
	]);
	// Listing before session_start must also restore ownership.
	const listed = await f.call("agent_runs", { action: "list", limit: 1 });
	assert.equal(listed.isError, undefined);
	assert.equal(listed.details.runList.total, 2);
	assert.equal(listed.details.runList.nextOffset, 1);
	assert.equal(listed.details.runs.length, 1);
	assert.doesNotMatch(listed.content[0].text, /foreign-run/);
	assert.match(listed.content[0].text, /Next: agent_runs/);
	const next = await f.call("agent_runs", { action: "list", offset: 1, limit: 1 });
	assert.notEqual(next.details.runs[0].runId, listed.details.runs[0].runId);
	for (const action of ["inspect", "stop", "nudge"]) {
		const denied = await f.call("agent_runs", { action, id: "foreign-run", ...(action === "nudge" ? { message: "stay scoped" } : {}) });
		assert.equal(denied.isError, true, action);
	}
	const advancedList = await f.call("subagent", { action: "status" });
	assert.equal(advancedList.isError, true, "legacy global enumeration remains forbidden");
});

it("routes compact validation, worktrees, depth checks, async recovery, and error hooks through the child executor", async () => {
	const f = fixture();
	for (const name of ["delegate", "agent_runs", "subagent"]) {
		assert.equal(f.tools.get(name).async, true);
		assert.equal(typeof f.tools.get(name).resume, "function");
		assert.equal(await f.tools.get(name).resume("unknown-call", {}, undefined, undefined, f.ctx), undefined);
		const patched = f.handlers.get("tool_result")!.map((handler) => handler({ toolName: name, details: { mode: "single", results: [], isError: true } }, f.ctx)).find((result) => result?.isError);
		assert.equal(patched.isError, true);
		assert.equal(patched.details.isError, undefined);
	}
	for (const worktree of [false, true]) {
		const missing = await f.call("delegate", { agent: "__missing__", task: "Check normalization", worktree, acceptance: { criteria: [{ id: "proof", must: "normalize" }], verify: [{ id: "check", command: "true", env: [{ name: "A", value: "B" }] }] } });
		assert.match(missing.content[0].text, /Unknown agent: __missing__/);
		assert.equal(missing.details.mode, worktree ? "parallel" : "single");
	}
	await assert.rejects(() => f.call("agent_runs", { action: "continue", id: "run" }), /Invalid agent_runs arguments/);
	process.env.PI_SUBAGENT_MAX_DEPTH = "1";
	try {
		const blocked = await f.call("delegate", { agent: "worker", task: "Must not launch" });
		assert.match(blocked.content[0].text, /Nested subagent call blocked/);
	} finally { process.env.PI_SUBAGENT_MAX_DEPTH = "2"; }
	assert.match(formatRunAction("resume", "run", { message: "continue" }, true), /^agent_runs\(\{ action: "continue"/);
	assert.match(formatRunAction("extend", "run", { extendMs: 1000 }, true), /^load_subagent\(\{\}\), then subagent/);
	assert.match(fixture({ asyncByDefault: true }).tools.get("delegate").parameters.properties.async.description, /Background by default/);
});

it("keeps launch allowlists and prompt discovery aligned with the reversible flag", async () => {
	const base = { baseArgs: ["-p"], task: "Check", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false };
	for (const compactChildTools of [false, true]) {
		fixture({ compactChildTools });
		process.env.PI_SUBAGENT_EAGER_TOOL = "1";
		const launched = buildPiArgs({ ...base, allowSubagents: true, tools: ["read"] });
		assert.equal(launched.args[launched.args.indexOf("--tools") + 1], compactChildTools ? "read,subagent,delegate,agent_runs,load_subagent" : "read,subagent");
		assert.equal(launched.env.PI_SUBAGENT_EAGER_TOOL, undefined, "ordinary profiles do not inherit an ancestor's eager policy");
		const explicit = buildPiArgs({ ...base, tools: ["subagent", "read"] });
		assert.equal(explicit.env.PI_SUBAGENT_EAGER_TOOL, "1");
		for (const name of ["delegate", "agent_runs", "load_subagent"]) {
			assert.equal(buildPiArgs({ ...base, tools: [name] }).env.PI_SUBAGENT_FANOUT_CHILD, "0", "compact names alone do not grant delegation permission");
		}
		let beforeStart: any;
		registerPrompt({ on(name: string, handler: unknown) { if (name === "before_agent_start") beforeStart = handler; } } as any);
		const event = { systemPrompt: "Parent policy", systemPromptOptions: { sections: {}, skills: [] } };
		beforeStart(event);
		const role = event.systemPromptOptions.sections.subagent_role;
		assert.match(role, compactChildTools ? /agent_runs.*profiles.*delegate.*load_subagent/ : /subagent\(\{action:'list'\}\)/);
		if (!compactChildTools) assert.doesNotMatch(role, /agent_runs|load_subagent/);
	}
});

it("measures serialized active startup definitions rather than tokens", async () => {
	const legacy = fixture({ compactChildTools: false });
	await legacy.emit("session_start");
	const beforeChars = JSON.stringify(legacy.definitions()).length;
	const compact = fixture();
	await compact.emit("session_start");
	const afterChars = JSON.stringify(compact.definitions()).length;
	assert.ok(afterChars < beforeChars * 0.5, `${beforeChars} -> ${afterChars} serialized characters`);
	console.log(JSON.stringify({ measurement: "serialized active child delegation definitions (name, description, parameters, promptSnippet, promptGuidelines); characters, not tokens", beforeChars, afterChars, savedChars: beforeChars - afterChars }));
});
