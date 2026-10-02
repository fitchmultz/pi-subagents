import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "../../shared/native-typebox.ts";
import { SUBAGENT_FANOUT_CHILD_ENV } from "./pi-args.ts";
import { setPromptSection } from "../../shared/prompt-sections.ts";
import { loadConfig } from "../../extension/config.ts";
import { registerChildExecutionCwd } from "./child-execution-cwd.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV, validateStructuredOutputValue } from "./structured-output.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";
import { SessionEntryCursor } from "../../shared/session-entries.ts";

const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
	"This subagent step has a strict structured output contract.",
	"Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
	"Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent with delegation enabled for your assigned task.",
	"You may delegate useful helper work within that task when it saves time or improves quality, using the available delegation tools.",
	"You remain responsible for your assigned result. The original parent owns integration, review synthesis, and final delivery.",
	"Do not broaden the assigned scope or repeat approval requests for already-authorized work.",
	"The native allowSubagents and maxSubagentDepth settings still apply.",
	"If you need to edit files, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);
const ORCHESTRATION_TOOLS = new Set(["subagent", "delegate", "agent_runs", "load_subagent"]);

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	return value !== "0";
}

function isParentOnlySubagentMessage(message: unknown): boolean {
	const m = message as { role?: string; customType?: string };
	return m?.role === "custom"
		&& typeof m.customType === "string"
		&& PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}

function isSubagentExecutionResultMessage(message: unknown): boolean {
	const m = message as { role?: string; toolName?: string };
	return m?.role === "toolResult" && typeof m.toolName === "string" && ORCHESTRATION_TOOLS.has(m.toolName);
}

function isSubagentToolCallBlock(block: unknown): boolean {
	const b = block as { type?: string; name?: string };
	return b?.type === "toolCall" && typeof b.name === "string" && ORCHESTRATION_TOOLS.has(b.name);
}

function stripAssistantSubagentToolCallBlocks(message: unknown): unknown | undefined {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
	if (filteredContent.length === m.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...m, content: filteredContent };
}

function stripParentOnlySubagentMessages<T>(messages: T[], fanoutChild = false): T[] {
	let changed = false;
	const filtered: T[] = [];
	for (const message of messages) {
		if (isParentOnlySubagentMessage(message) || (!fanoutChild && isSubagentExecutionResultMessage(message))) {
			changed = true;
			continue;
		}
		const stripped = fanoutChild ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		if (stripped !== message) changed = true;
		filtered.push(stripped as T);
	}
	return changed ? filtered : messages;
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	registerChildExecutionCwd(pi);
	// Print-mode observation uses the existing child runtime. turn_end follows native
	// message append; message_end itself is deliberately never called a commit receipt.
	let observedMessages = 0;
	const cursor = new SessionEntryCursor();
	let previousIds = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		cursor.reset();
		observedMessages = 0;
		const { entries } = cursor.read(ctx.sessionManager);
		const baseline = process.env.PI_SUBAGENT_NATIVE_BASELINE_COUNT;
		if (baseline && /^\d+$/.test(baseline)) process.stdout.write(`${JSON.stringify({ type: "subagent.native_baseline", sessionId: ctx.sessionManager.getSessionId(), entryIds: entries.slice(0, Number(baseline)).map((entry) => entry.id) })}\n`);
		const file = ctx.sessionManager.getSessionFile();
		previousIds = file && fs.existsSync(file) ? new Set(entries.map((entry) => entry.id)) : new Set();
		if (!file || !fs.existsSync(file)) cursor.reset();
	});
	pi.on("message_end", (event) => { if (["assistant", "user", "toolResult"].includes(event.message.role)) observedMessages++; });
	const observe = (ctx: import("@earendil-works/pi-coding-agent").ExtensionContext, boundary: string) => {
		if (process.env.PI_SUBAGENT_CHILD !== "1") return;
		const entries = [];
		for (const entry of cursor.read(ctx.sessionManager).entries) if (!previousIds.has(entry.id)) {
			previousIds.add(entry.id);
			const message = entry.type === "message" ? entry.message : undefined;
			entries.push({ id: entry.id, type: entry.type, parentId: entry.parentId,
				...("checkpoint" in entry ? { checkpoint: entry.checkpoint } : {}),
				...(entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? { usage: entry.usage } : {}),
				...(entry.type === "usage" ? { provider: entry.provider, model: entry.model } : {}),
				...(message ? { message: { role: message.role, timestamp: message.timestamp,
					...("usage" in message ? { usage: message.usage } : {}),
					...(message.role === "assistant" ? { provider: message.provider, model: message.model, responseModel: message.responseModel } : {}),
					...("toolCallId" in message ? { toolCallId: message.toolCallId } : {}) } } : {}) });
		}
		const sessionFile = ctx.sessionManager.getSessionFile();
		process.stdout.write(`${JSON.stringify({ type: "subagent.native", boundary, entries,
			sessionId: ctx.sessionManager.getSessionId(), sessionFile, leafId: ctx.sessionManager.getLeafId(),
			persisted: Boolean(sessionFile && fs.existsSync(sessionFile)), messageCount: observedMessages,
			configuration: { ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}), thinking: pi.getThinkingLevel() } })}\n`);
	};
	pi.on("turn_end", (_event, ctx) => observe(ctx, "turn"));
	pi.on("agent_settled", (_event, ctx) => observe(ctx, "settled"));
	const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (structuredOutputPath && structuredSchemaPath) {
		const schema = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8")) as JsonSchemaObject;
		const parameters = Type.Object({ value: Type.Unsafe(schema) }, { additionalProperties: false });
		pi.registerTool({
			name: "structured_output",
			label: "Structured Output",
			description: "Submit the required final structured output for this subagent step. This terminates the step.",
			parameters,
			constrainedSampling: { type: "json_schema", strict: "prefer" },
			async execute(_id: string, params: { value: unknown }) {
				const validation = validateStructuredOutputValue(schema, params.value);
				if (validation.status === "invalid") {
					throw new Error(`Structured output validation failed: ${validation.message}`);
				}
				fs.mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
				fs.writeFileSync(structuredOutputPath, JSON.stringify(params.value), { mode: 0o600 });
				return {
					content: [{ type: "text", text: "Structured output captured." }],
					details: { path: structuredOutputPath },
					terminate: true,
				};
			},
		});
		pi.on("session_start", () => {
			pi.setActiveTools([...new Set([...pi.getActiveTools(), "structured_output"])]);
		});
	}

	pi.on("context", (event) => {
		// Filtering changes the provider prefix, never the saved journal. Fanout children
		// need their own nested calls/results on later turns and resumes, so retain tool history.
		const messages = stripParentOnlySubagentMessages(event.messages, readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV) === true);
		if (messages === event.messages) return;
		return { messages };
	});

	pi.on("before_agent_start", (event) => {
		const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
		const fanoutChild = readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV);
		if (inheritProjectContext === undefined && inheritSkills === undefined && fanoutChild === undefined) return;
		const options = event.systemPromptOptions;
		// --no-skills/--no-context-files govern discovery. Keep explicitly selected
		// skill bodies and context intact; never parse the rendered prompt to remove resources.
		options.skills = options.skills.filter((skill) => skill.name !== "pi-subagents");
		setPromptSection(options, "subagent_role", fanoutChild === true
			? `${CHILD_FANOUT_BOUNDARY_INSTRUCTIONS}\n${loadConfig().compactChildTools === false
				? "Use subagent({action:'list'}) to discover agents before delegation."
				: "Use load_subagent({advanced:false}), then agent_runs({action:'profiles'}) to discover agents, delegate for ordinary work, and load_subagent for advanced workflows."}`
			: CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
		if (structuredOutputPath) setPromptSection(options, "subagent_output", STRUCTURED_OUTPUT_INSTRUCTIONS);
	});
}
