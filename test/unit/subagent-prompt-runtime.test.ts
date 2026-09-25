import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../src/runs/shared/structured-output.ts";
import registerSubagentPromptRuntime, {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	stripParentOnlySubagentMessages,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
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
