import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai/compat";
import type { Usage } from "../../shared/types.ts";

const PREFIX = "claude-code/";
const DEFAULT_CONTEXT = "300k";
const CONTEXT_TOKENS: Record<"300k" | "1m", string> = {
	"300k": "300000",
	"1m": "1000000",
};
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FAMILY_ALIASES = new Set(["fable", "opus", "sonnet", "haiku"]);
const SESSION_EVENT_TYPE = "claude_code_session";

export interface ClaudeCodeModelSpec {
	inputModel: string;
	family: "fable" | "opus" | "sonnet" | "haiku";
	context: "300k" | "1m" | "native";
	thinking?: string;
	cliModel: string;
	autoCompactWindow?: string;
}

export interface ClaudeCodeSessionMetadata {
	sessionId: string;
	model: string;
	cliModel: string;
	family: ClaudeCodeModelSpec["family"];
	context: ClaudeCodeModelSpec["context"];
	updatedAt: number;
}

export interface ClaudeCodeInvocation {
	command: string;
	args: string[];
	env: Record<string, string | undefined>;
	sessionId: string;
	resuming: boolean;
	model: ClaudeCodeModelSpec;
}

export interface ClaudeCodeResultEvent {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	api_error_status?: number | null;
	result?: string;
	stop_reason?: string;
	session_id?: string;
	total_cost_usd?: number;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	modelUsage?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>;
}

export function isClaudeCodeModel(model: string | undefined): boolean {
	return Boolean(model?.startsWith(PREFIX));
}

function splitThinking(input: string): { model: string; thinking?: string } {
	const idx = input.lastIndexOf(":");
	if (idx === -1) return { model: input };
	const suffix = input.slice(idx + 1);
	if (!THINKING_LEVELS.has(suffix)) return { model: input };
	return { model: input.slice(0, idx), thinking: suffix };
}

export function parseClaudeCodeModel(model: string): ClaudeCodeModelSpec {
	if (!isClaudeCodeModel(model)) throw new Error(`Not a Claude Code model: ${model}`);
	const { model: withoutThinking, thinking } = splitThinking(model);
	const raw = withoutThinking.slice(PREFIX.length).trim().toLowerCase();
	const [familyRaw, contextRaw] = raw.split("@", 2);
	if (!FAMILY_ALIASES.has(familyRaw)) {
		throw new Error(`Unsupported Claude Code model '${model}'. Use claude-code/fable, claude-code/opus, claude-code/sonnet, or claude-code/haiku.`);
	}
	const family = familyRaw as ClaudeCodeModelSpec["family"];
	const context = contextRaw ?? (family === "haiku" ? "native" : DEFAULT_CONTEXT);
	if (context !== "300k" && context !== "1m" && context !== "native") {
		throw new Error(`Unsupported Claude Code context '${context}' in '${model}'. Use @300k or @1m.`);
	}
	if (family === "haiku" && context === "1m") throw new Error("Claude Code haiku does not support @1m context.");
	if (family === "haiku" && context === "300k") throw new Error("Claude Code haiku does not support @300k context.");
	const cliModel = context === "1m" && (family === "opus" || family === "sonnet") ? `${family}[1m]` : family;
	return {
		inputModel: model,
		family,
		context,
		...(thinking && thinking !== "off" ? { thinking } : {}),
		cliModel,
		...(context === "300k" ? { autoCompactWindow: CONTEXT_TOKENS[context] } : {}),
	};
}

export function readClaudeCodeSessionMetadata(sessionFile: string | undefined): ClaudeCodeSessionMetadata | undefined {
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;
	for (const line of fs.readFileSync(sessionFile, "utf-8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { type?: string; claudeCode?: Partial<ClaudeCodeSessionMetadata> };
			if (parsed.type !== SESSION_EVENT_TYPE || !parsed.claudeCode) continue;
			const sessionId = parsed.claudeCode.sessionId;
			const model = parsed.claudeCode.model;
			const cliModel = parsed.claudeCode.cliModel;
			const family = parsed.claudeCode.family;
			const context = parsed.claudeCode.context;
			if (typeof sessionId !== "string" || !sessionId) continue;
			if (typeof model !== "string" || typeof cliModel !== "string") continue;
			if (family !== "fable" && family !== "opus" && family !== "sonnet" && family !== "haiku") continue;
			if (context !== "300k" && context !== "1m" && context !== "native") continue;
			return { sessionId, model, cliModel, family, context, updatedAt: Number(parsed.claudeCode.updatedAt) || 0 };
		} catch {
			// Ignore non-metadata jsonl lines.
		}
	}
	return undefined;
}

export function writeClaudeCodeSessionMetadata(sessionFile: string, metadata: ClaudeCodeSessionMetadata): void {
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	const existing = fs.existsSync(sessionFile)
		? fs.readFileSync(sessionFile, "utf-8").split(/\r?\n/).filter((line) => {
			if (!line.trim()) return false;
			try {
				return (JSON.parse(line) as { type?: string }).type !== SESSION_EVENT_TYPE;
			} catch {
				return true;
			}
		})
		: [];
	const metadataLine = JSON.stringify({ type: SESSION_EVENT_TYPE, claudeCode: metadata });
	fs.writeFileSync(sessionFile, `${metadataLine}\n${existing.join("\n")}${existing.length ? "\n" : ""}`, "utf-8");
}

export function appendClaudeCodeMessage(sessionFile: string | undefined, message: Message): void {
	if (!sessionFile) return;
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message_end", message })}\n`, "utf-8");
}

function hasNonMetadataContent(sessionFile: string): boolean {
	if (!fs.existsSync(sessionFile)) return false;
	for (const line of fs.readFileSync(sessionFile, "utf-8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			if ((JSON.parse(line) as { type?: string }).type === SESSION_EVENT_TYPE) continue;
		} catch {
			// Non-json content means this is not our metadata-only file.
		}
		return true;
	}
	return false;
}

export function buildClaudeCodeInvocation(input: {
	model: string;
	task: string;
	systemPrompt?: string;
	systemPromptMode?: "append" | "replace";
	sessionFile?: string;
	sessionName?: string;
	tools?: string[];
	mcpDirectTools?: string[];
	allowSubagents?: boolean;
}): ClaudeCodeInvocation {
	const parsed = parseClaudeCodeModel(input.model);
	const existing = readClaudeCodeSessionMetadata(input.sessionFile);
	if (input.sessionFile && !existing && hasNonMetadataContent(input.sessionFile)) {
		throw new Error(`Claude Code backend cannot resume non-Claude session file: ${input.sessionFile}. Use fresh context for claude-code/* subagents.`);
	}
	const sessionId = existing?.sessionId ?? randomUUID();
	const args = ["-p", "--dangerously-skip-permissions", "--model", parsed.cliModel, "--output-format", "stream-json", "--verbose"];
	if (parsed.thinking && parsed.thinking !== "minimal") args.push("--effort", parsed.thinking);
	if (input.sessionName) args.push("--name", input.sessionName);
	if (existing) args.push("--resume", sessionId);
	else args.push("--session-id", sessionId);
	if (input.systemPrompt?.trim()) {
		args.push(input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", input.systemPrompt);
	}
	if (input.allowSubagents) throw new Error("Claude Code backend does not support nested subagent fanout. Use a Pi-backed model for allowSubagents.");
	const mappedTools = mapClaudeCodeTools(input.tools, input.mcpDirectTools);
	args.push(input.task);
	if (mappedTools) args.push("--tools", mappedTools);
	return {
		command: "claude",
		args,
		env: parsed.autoCompactWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: parsed.autoCompactWindow } : {},
		sessionId,
		resuming: Boolean(existing),
		model: parsed,
	};
}

function mapClaudeCodeTools(tools: string[] | undefined, mcpDirectTools: string[] | undefined): string | undefined {
	if (mcpDirectTools?.length) {
		throw new Error(`Claude Code backend does not support MCP direct tool allowlist entries: ${mcpDirectTools.join(", ")}. Use a Pi-backed model for MCP direct tools.`);
	}
	if (!tools || tools.length === 0) return undefined;
	const map: Record<string, string> = {
		bash: "Bash",
		read: "Read",
		edit: "Edit",
		write: "Write",
		grep: "Grep",
		glob: "Glob",
		web_fetch: "WebFetch",
		webfetch: "WebFetch",
		web_search: "WebSearch",
		websearch: "WebSearch",
	};
	const mapped: string[] = [];
	const unsupported: string[] = [];
	for (const tool of tools) {
		const name = tool.trim();
		if (!name) continue;
		const mappedTool = map[name.toLowerCase()];
		if (mappedTool) mapped.push(mappedTool);
		else unsupported.push(name);
	}
	if (unsupported.length > 0 || mapped.length === 0) {
		throw new Error(`Claude Code backend does not support tool allowlist entr${unsupported.length === 1 ? "y" : "ies"}: ${(unsupported.length ? unsupported : tools).join(", ")}. Supported tools: bash, read, edit, write, grep, glob, web_fetch, web_search.`);
	}
	return [...new Set(mapped)].join(",");
}

export function claudeCodeMessageFromResult(event: ClaudeCodeResultEvent, fallbackModel: string): Message {
	const resultText = event.result ?? "";
	const isError = event.is_error === true || event.subtype === "error" || Boolean(event.api_error_status);
	return {
		role: "assistant",
		content: [{ type: "text", text: resultText }],
		model: resolveClaudeCodeResultModel(event) ?? fallbackModel,
		stopReason: isError ? "error" : "stop",
		...(isError ? { errorMessage: resultText || `Claude Code failed${event.api_error_status ? ` (${event.api_error_status})` : ""}.` } : {}),
		usage: {
			input: event.usage?.input_tokens ?? 0,
			output: event.usage?.output_tokens ?? 0,
			cacheRead: event.usage?.cache_read_input_tokens ?? 0,
			cacheWrite: event.usage?.cache_creation_input_tokens ?? 0,
			cost: { total: event.total_cost_usd ?? 0 },
		},
	} as Message;
}

export function usageFromClaudeCodeResult(event: ClaudeCodeResultEvent): Usage {
	return {
		input: event.usage?.input_tokens ?? 0,
		output: event.usage?.output_tokens ?? 0,
		cacheRead: event.usage?.cache_read_input_tokens ?? 0,
		cacheWrite: event.usage?.cache_creation_input_tokens ?? 0,
		cost: event.total_cost_usd ?? 0,
		turns: 1,
	};
}

export function resolveClaudeCodeResultModel(event: ClaudeCodeResultEvent): string | undefined {
	const keys = Object.keys(event.modelUsage ?? {});
	return keys.find((key) => !key.includes("haiku")) ?? keys[0];
}
