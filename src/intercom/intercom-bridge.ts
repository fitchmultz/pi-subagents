import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/agents.ts";
import {
	SUBAGENT_INTERCOM_IDENTITY_REQUEST_EVENT,
	SUBAGENT_INTERCOM_IDENTITY_RESPONSE_EVENT,
	type IntercomEventBus,
} from "../shared/types.ts";

const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";
// Resolve the bundled intercom extension next to this module in both layouts:
// TypeScript sources (tests, jiti) and compiled dist output.
const BUNDLED_INTERCOM_EXTENSION_PATH = fileURLToPath(
	new URL(import.meta.url.endsWith(".ts") ? "../pi-intercom/index.ts" : "../pi-intercom/index.js", import.meta.url),
);
export const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";
const DEFAULT_INTERCOM_BRIDGE_TEMPLATE = `The inherited thread is reference-only. Do not continue that conversation or send questions, status updates, or completion handoffs to the supervisor in normal assistant text.

Use contact_supervisor first. It resolves the supervisor session "{orchestratorTarget}" and run metadata automatically.
- If you cannot safely continue without one decision, approval, or product/API/scope clarification: contact_supervisor({ reason: "need_decision", message: "<question>" }). It steers the supervisor and keeps this ephemeral child alive for the reply.
- If you cannot safely continue until the supervisor provides multiple structured answers: contact_supervisor({ reason: "interview_request", message: "<context>", interview: { questions: [{ id: "<id>", type: "text", question: "<question>" }] } }). It also steers and keeps this child alive.
- After blocking contact_supervisor decisions or interviews, continue only after the reply arrives. Do not finish your final response with a choose-one question.
- Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions. Review-only/no-edit wins; leave files unchanged and mention the conflict in your final result only if it matters.
- A concise material update that may intentionally wait behind the supervisor's active work: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })
- Generic intercom is lower-level fallback only. Use blocking intercom({ action: "ask", to: "{orchestratorTarget}", delivery: "steer", message: "<question>" }) only when this child must remain alive for the answer.
- Treat a supervisor nudge as supplemental coordination within the active task: incorporate relevant context and continue. Replace the task only when the nudge explicitly says so. If it requests an answer, respond with intercom({ action: "send", to: "{orchestratorTarget}", delivery: "steer", message: "<answer>" }).

Do not use contact_supervisor or intercom for routine completion handoffs. If no coordination is needed, return a focused task result.`;

export interface IntercomBridgeState {
	orchestratorTarget: string;
	instruction: string;
}

export function resolveIntercomSessionTarget(sessionName: string | undefined, sessionId: string): string {
	const trimmedName = sessionName?.trim();
	if (trimmedName) return trimmedName;
	const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
	return `${DEFAULT_INTERCOM_TARGET_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}

export function resolveOrchestratorIntercomTarget(events: IntercomEventBus, fallback: string): string {
	if (typeof events.on !== "function" || typeof events.emit !== "function") return fallback;
	const requestId = randomUUID();
	let exactTarget: string | undefined;
	let unsubscribe: (() => void) | undefined;
	let failed = false;
	try {
		unsubscribe = events.on(SUBAGENT_INTERCOM_IDENTITY_RESPONSE_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			const response = payload as { requestId?: unknown; sessionId?: unknown };
			if (response.requestId === requestId && typeof response.sessionId === "string" && response.sessionId.trim()) exactTarget = response.sessionId;
		});
		events.emit(SUBAGENT_INTERCOM_IDENTITY_REQUEST_EVENT, { requestId });
	} catch {
		failed = true;
	} finally {
		try { unsubscribe?.(); } catch { failed = true; }
	}
	return failed ? fallback : exactTarget ?? fallback;
}

function sanitizeIntercomTargetPart(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function resolveSubagentIntercomTarget(runId: string, agent: string, index?: number): string {
	const stepSuffix = index !== undefined ? `-${index + 1}` : "";
	return `subagent-${sanitizeIntercomTargetPart(agent)}-${sanitizeIntercomTargetPart(runId)}${stepSuffix}`;
}

function isIntercomExtensionEntry(entry: string): boolean {
	return entry.trim().replaceAll("\\", "/").toLowerCase().split("/").includes("pi-intercom");
}

function extensionSandboxAllowsIntercom(extensions: string[] | undefined): boolean {
	return extensions === undefined || extensions.some(isIntercomExtensionEntry);
}

function resolveBundledIntercomExtensions(extensions: string[] | undefined): string[] | undefined {
	if (extensions === undefined) return undefined;
	const resolved = [...new Set(extensions.map((entry) => isIntercomExtensionEntry(entry) ? BUNDLED_INTERCOM_EXTENSION_PATH : entry))];
	return resolved.length === extensions.length && resolved.every((entry, index) => entry === extensions[index]) ? extensions : resolved;
}

function buildIntercomBridgeInstruction(orchestratorTarget: string): string {
	return `${INTERCOM_BRIDGE_MARKER}
${DEFAULT_INTERCOM_BRIDGE_TEMPLATE.replaceAll("{orchestratorTarget}", orchestratorTarget).trim()}`;
}

export function resolveIntercomBridge(orchestratorTarget: string): IntercomBridgeState {
	const target = orchestratorTarget.trim();
	return {
		orchestratorTarget: target,
		instruction: buildIntercomBridgeInstruction(target),
	};
}

export function applyIntercomBridgeToAgent(agent: AgentConfig, bridge: IntercomBridgeState): AgentConfig {
	if (!extensionSandboxAllowsIntercom(agent.extensions)) return agent;

	const bridgeTools = ["intercom", "contact_supervisor"];
	const missingTools = agent.tools ? bridgeTools.filter((tool) => !agent.tools?.includes(tool)) : [];
	const tools = agent.tools && missingTools.length ? [...agent.tools, ...missingTools] : agent.tools;
	const extensions = resolveBundledIntercomExtensions(agent.extensions);
	const instruction = bridge.instruction;
	const trimmedPrompt = agent.systemPrompt?.trim() || "";
	const systemPrompt = trimmedPrompt.includes(INTERCOM_BRIDGE_MARKER)
		? trimmedPrompt
		: trimmedPrompt
			? `${trimmedPrompt}\n\n${instruction}`
			: instruction;

	if (tools === agent.tools && systemPrompt === agent.systemPrompt && extensions === agent.extensions) return agent;
	return {
		...agent,
		tools,
		systemPrompt,
		extensions,
	};
}
