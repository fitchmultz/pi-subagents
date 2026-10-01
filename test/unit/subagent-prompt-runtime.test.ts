import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../src/runs/shared/structured-output.ts";
import registerSubagentPromptRuntime, {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	stripParentOnlySubagentMessages,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
	PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
	PI_SUBAGENT_NATIVE_BASELINE_COUNT: process.env.PI_SUBAGENT_NATIVE_BASELINE_COUNT,
	PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
	PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
	PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE,
	PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA,
};

function promptEvent() {
	return {
		systemPrompt: "Opaque prompt is never parsed",
		systemPromptOptions: {
			customPrompt: "Selected replacement",
			appendSystemPrompt: '<skill name="explicit">Selected instructions</skill>',
			sections: {} as Record<string, string>,
			skills: [{ name: "safe-bash" }, { name: "pi-subagents" }],
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Selected project policy" }],
			forceSystemPrompt: undefined as string | undefined,
		},
	};
}

function registerPromptHandler() {
	let handler: (event: ReturnType<typeof promptEvent>) => unknown;
	registerSubagentPromptRuntime({
		on(name: string, callback: typeof handler) {
			if (name === "before_agent_start") handler = callback;
		},
	} as never);
	return (event: ReturnType<typeof promptEvent>) => handler(event);
}

afterEach(() => {
	for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_NATIVE_BASELINE_COUNT"] as const) {
		if (envSnapshot[key] === undefined) delete process.env[key];
		else process.env[key] = envSnapshot[key];
	}
	if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined) delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	else process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined) delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
	else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
	if (envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME === undefined) delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	else process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	if (envSnapshot.PI_SUBAGENT_FANOUT_CHILD === undefined) delete process.env.PI_SUBAGENT_FANOUT_CHILD;
	else process.env.PI_SUBAGENT_FANOUT_CHILD = envSnapshot.PI_SUBAGENT_FANOUT_CHILD;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE === undefined) delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	else process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA === undefined) delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	else process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
});

describe("subagent prompt runtime", () => {
	it("reconciles revision batches, off-branch appends, truncation and reused IDs without indexed host APIs", async () => {
		const { SessionEntryCursor } = await import("../../src/shared/session-entries.ts");
		const entry = (id: string, parentId: string | null, sequence: number) => ({
			type: "custom" as const, customType: "fixture", id, parentId, sequence, timestamp: "2026-01-01T00:00:00Z", data: {},
		});
		let entries = [entry("root", null, 0)], leaf = "root", revision = 0, scans = 0;
		const source = {
			getSessionId: () => "fixture", getSessionFile: () => "/fixture.jsonl", getEntries: () => entries, getLeafId: () => leaf, getEntryCount: () => entries.length,
			getEntriesRevision: () => revision, getEntry: (id: string) => entries.find((item) => item.id === id),
			getEntryMetadata: (id: string) => entries.find((item) => item.id === id),
			iterateEntryMetadata: () => { scans++; return entries; },
		};
		const cursor = new SessionEntryCursor();
		assert.equal(cursor.read(source).reset, true);
		entries.push(entry("first", "root", 1), entry("second", "first", 2)); leaf = "second"; revision++;
		assert.deepEqual(cursor.read(source).entries.map(({ id }) => id), ["first", "second"]);
		assert.equal(scans, 2, "one externally refreshed revision can publish multiple entries and requires reconciliation");
		entries.push(entry("abandoned", "root", 3), entry("active", "second", 4)); leaf = "active"; revision += 2;
		assert.deepEqual(cursor.read(source).entries.map(({ id }) => id), ["abandoned", "active"]);
		assert.equal(scans, 3, "active-branch links alone must not hide a physical suffix");
		entries[0] = entry("root", null, 0); revision++;
		const replaced = cursor.read(source);
		assert.equal(replaced.reset, true, "same-ID replacement invalidates previously indexed facts even if the last entry survives");
		assert.equal(replaced.entries.length, 5);
		entries = entries.slice(0, 1); leaf = "root"; revision++;
		assert.equal(cursor.read(source).reset, true);
		const portable = { getSessionId: () => "fixture", getEntries: () => entries };
		assert.equal(cursor.read(portable).reset, true);
		entries.push(entry("portable", "root", 1));
		assert.deepEqual(cursor.read(portable).entries.map(({ id }) => id), ["portable"]);
		assert.deepEqual(cursor.read(portable).entries, []);
		const transient = { ...source, getSessionFile: () => undefined, getEntryMetadata: () => { throw new Error("In-memory metadata must not be repeatedly projected"); } };
		assert.equal(cursor.read(transient).reset, true);
		assert.deepEqual(cursor.read(transient).entries, []);
	});

	it("observes append-only native history with work proportional to new entries", (t) => {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_NATIVE_BASELINE_COUNT = "4000";
		const manager = SessionManager.inMemory("/fixture");
		for (let index = 0; index < 4000; index++) manager.appendCustomEntry("baseline", index);
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "native-observation-")), "session.jsonl");
		fs.writeFileSync(file, "");
		t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
		let visits = 0, lookups = 0;
		const source = {
			getSessionId: () => manager.getSessionId(), getSessionFile: () => file, getLeafId: () => manager.getLeafId(),
			getEntryCount: () => manager.getEntryCount(),
			getEntry: (id: string) => { visits++; lookups++; return manager.getEntry(id); },
			getEntryMetadata: (id: string) => { visits++; lookups++; return manager.getEntry(id); },
			iterateEntryMetadata: () => { const entries = manager.getEntries(); visits += entries.length; return entries; },
			getEntries: () => { const entries = manager.getEntries(); visits += entries.length; return entries; },
		};
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		registerSubagentPromptRuntime({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
			getThinkingLevel: () => "off" } as never);
		const emitted: string[] = [];
		t.mock.method(process.stdout, "write", (chunk: unknown) => { emitted.push(String(chunk)); return true; });
		const ctx = { sessionManager: source, model: { provider: "fixture", id: "faux" } };
		handlers.get("session_start")!({}, ctx);
		assert.ok(lookups < 10, `startup must use bulk references, not one filesystem-refreshing lookup per historical entry: ${lookups}`);
		const ids: string[] = [];
		for (let index = 0; index < 2000; index++) {
			ids.push(manager.appendMessage({ role: "user", content: `New ${index}`, timestamp: index }));
			handlers.get("message_end")!({ message: { role: "user" } }, ctx);
			handlers.get("turn_end")!({}, ctx);
		}
		handlers.get("agent_settled")!({}, ctx);
		t.mock.restoreAll();
		const records = emitted.map((line) => JSON.parse(line));
		assert.equal(records[0].type, "subagent.native_baseline");
		assert.equal(records[0].entryIds.length, 4000);
		assert.deepEqual(records.slice(1, -1).map((record) => record.entries.map((entry: { id: string }) => entry.id)), ids.map((id) => [id]));
		assert.deepEqual(records.at(-1).entries, []);
		assert.equal(records.at(-1).messageCount, 2000);
		assert.deepEqual(records.at(-1).configuration, { model: "fixture/faux", thinking: "off" });
		t.diagnostic(`4000 inherited + 2000 new entries: ${visits} native entry visits`);
		assert.ok(visits < 20_000, `native entry visits must not rescan the baseline on every turn: ${visits}`);
	});

	it("retains initial in-memory entries, off-branch appends, and replacement entries", (t) => {
		process.env.PI_SUBAGENT_CHILD = "1";
		const manager = SessionManager.inMemory("/fixture");
		const root = manager.appendCustomEntry("root", {});
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		registerSubagentPromptRuntime({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
			getThinkingLevel: () => "off" } as never);
		const emitted: string[] = [];
		t.mock.method(process.stdout, "write", (chunk: unknown) => { emitted.push(String(chunk)); return true; });
		const ctx = { sessionManager: manager };
		handlers.get("session_start")!({}, ctx);
		handlers.get("turn_end")!({}, ctx);
		const first = manager.appendCustomEntry("first", {});
		handlers.get("turn_end")!({}, ctx);
		manager.branch(root);
		const abandoned = manager.appendCustomEntry("abandoned", {});
		manager.branch(first);
		const active = manager.appendCustomEntry("active", {});
		handlers.get("turn_end")!({}, ctx);
		ctx.sessionManager = SessionManager.inMemory("/fixture");
		const replacement = ctx.sessionManager.appendCustomEntry("replacement", {});
		handlers.get("session_start")!({}, ctx);
		handlers.get("turn_end")!({}, ctx);
		t.mock.restoreAll();
		assert.deepEqual(emitted.map((line) => JSON.parse(line).entries.map((entry: { id: string }) => entry.id)),
			[[root], [first], [abandoned, active], [replacement]]);
	});

	it("registered structured_output tool accepts valid schema output and writes the capture file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-runtime-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			const outputPath = path.join(dir, "output.json");
			fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }), "utf-8");
			process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
			process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
			let execute: ((_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }>) | undefined;

			registerSubagentPromptRuntime({
				registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }) {
					if (tool.name === "structured_output") execute = tool.execute;
				},
				on() {},
			} as { registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }): void; on(): void });

			assert.ok(execute, "structured_output tool should be registered");
			const result = await execute("tool-1", { value: { ok: true } });
			assert.equal(result.terminate, true);
			assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { ok: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("adds child sections without reparsing selected skills, project policy, or replacement prompts", () => {
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
		const event = promptEvent();
		assert.equal(registerPromptHandler()(event), undefined);
		assert.equal(event.systemPromptOptions.sections.subagent_role, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
		assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);
		assert.equal(event.systemPromptOptions.customPrompt, "Selected replacement");
		assert.equal(event.systemPromptOptions.appendSystemPrompt, '<skill name="explicit">Selected instructions</skill>');
		assert.deepEqual(event.systemPromptOptions.contextFiles, [{ path: "/repo/AGENTS.md", content: "Selected project policy" }]);
		assert.deepEqual(event.systemPromptOptions.skills, [{ name: "safe-bash" }]);
	});

	it("replaces only its structured boundary when switching fanout policy", () => {
		const run = registerPromptHandler();
		const event = promptEvent();
		for (const allowed of [false, true, false]) {
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = allowed ? "1" : "0";
			run(event);
			if (allowed) {
				assert.ok(event.systemPromptOptions.sections.subagent_role.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS + "\n"));
				assert.match(event.systemPromptOptions.sections.subagent_role, /agent_runs.*profiles.*delegate.*load_subagent/);
			} else assert.equal(event.systemPromptOptions.sections.subagent_role, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
			if (allowed) {
				assert.match(event.systemPromptOptions.sections.subagent_role, /useful helper work within that task/);
				assert.match(event.systemPromptOptions.sections.subagent_role, /original parent owns integration/);
				assert.doesNotMatch(event.systemPromptOptions.sections.subagent_role, /only for the fanout work explicitly requested/);
			}
			assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);
		}
	});

	it("preserves an earlier opaque full override and makes the child boundary visible", () => {
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
		const event = promptEvent();
		event.systemPromptOptions.forceSystemPrompt = "EXACT OVERRIDE";
		registerPromptHandler()(event);
		assert.equal(event.systemPromptOptions.forceSystemPrompt, `EXACT OVERRIDE\n\n<subagent_role>\n${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}\n</subagent_role>`);
	});

	it("strips parent-only subagent custom messages from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const notify = { role: "custom", customType: "subagent-notify", content: "Background task completed" };
		const control = { role: "custom", customType: "subagent_control_notice", content: "needs attention" };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(stripParentOnlySubagentMessages([user, instruction, slashResult, notify, control, otherCustom]), [user, otherCustom]);
	});

	it("strips prior parent subagent tool calls and results from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const readResult = { role: "toolResult", toolName: "read", content: "file contents" };
		const mixedAssistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the repo." },
				{ type: "toolCall", name: "subagent", input: { agent: "worker" } },
				{ type: "toolCall", name: "read", input: { path: "README.md" } },
			],
		};
		const pureSubagentCall = {
			role: "assistant",
			content: [{ type: "toolCall", name: "subagent", input: { agent: "reviewer" } }],
		};

		assert.deepEqual(
			stripParentOnlySubagentMessages([user, subagentResult, readResult, mixedAssistant, pureSubagentCall]),
			[
				user,
				readResult,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the repo." },
						{ type: "toolCall", name: "read", input: { path: "README.md" } },
					],
				},
			],
		);
	});

	it("sets the child intercom session name from env during agent startup", async () => {
		let sessionName: string | undefined;
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			setSessionName(name: string) {
				sessionName = name;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; setSessionName(name: string): void });

		await beforeAgentStart?.(promptEvent());
		assert.equal(sessionName, "subagent-worker-78f659a3");
	});

	it("retains fanout call/result history, including on resumed children", () => {
		const messages = [
			{ role: "custom", customType: "subagent-orchestration-instructions", content: "Parent instructions" },
			...["subagent", "delegate", "agent_runs", "load_subagent"].flatMap((name) => [
				{ role: "assistant", content: [{ type: "toolCall", name, id: `${name}-call` }] },
				{ role: "toolResult", toolName: name, toolCallId: `${name}-call`, content: "result" },
			]),
		];
		const saved = structuredClone(messages);
		assert.deepEqual(stripParentOnlySubagentMessages(messages), []);
		assert.deepEqual(stripParentOnlySubagentMessages(messages, true), messages.slice(1));
		assert.deepEqual(messages, saved);
	});

	it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const priorParentTurn = { role: "user", content: "Earlier we said planner → worker → reviewers → worker." };
		const currentTask = { role: "user", content: "Now implement only the assigned fix." };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "worker" } }] };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(contextHandler?.({ messages: [priorParentTurn, instruction, slashResult, subagentCall, subagentResult, otherCustom, currentTask] }), {
			messages: [priorParentTurn, otherCustom, currentTask],
		});
	});

	it("does not rewrite child context when no parent-only artifacts are present", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const messages = [
			{ role: "user", content: "Task" },
			{ role: "toolResult", toolName: "read", content: "file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }] },
		];

		assert.equal(contextHandler?.({ messages }), undefined);
	});
});
