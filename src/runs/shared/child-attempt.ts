import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { mkdirSync, writeFileSync, mkdtempSync, openSync, readSync, writeSync, closeSync, rmSync, fstatSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { attachChildProcessLifecycle } from "../../shared/post-exit-stdio-guard.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge } from "../../intercom/intercom-bridge.ts";
import { providerQualifiedModelId } from "../../shared/model-info.ts";
import { getSubagentDepthEnv, type AgentProcessExit, type ResourceLimitExceeded, type Usage } from "../../shared/types.ts";
import { extractTextFromContent, extractToolArgsPreview, formatResourceLimitExceeded, getFinalOutput, findLatestSessionFile } from "../../shared/utils.ts";
import { readFinalizationReport, resolveExecutionOutcome } from "./acceptance.ts";
import { readStructuredOutput } from "./structured-output.ts";
import {
	appendClaudeCodeMessage, buildClaudeCodeInvocation, claudeCodeMessageFromResult, isClaudeCodeModel, writeClaudeCodeSessionMetadata,
	type ClaudeCodeInvocation, type ClaudeCodeResultEvent,
} from "./claude-code.ts";
import { createMutationCompletionTracker, resolveCurrentPath, type MutationToolResult } from "./mutating-tool-guard.ts";
import { applyThinkingSuffix, buildPiArgs } from "./pi-args.ts";
import { FINALIZATION_EVENT, nativeFinalizationLaunch, type NativeFinalizationConfig, type NativeFinalizationEvent } from "./native-finalization.ts";
import { addUsage, nativeUsageCollector, readNativeUsage, snapshotNativeBaseline, validateNativeUsage, type NativeUsageMetadata } from "./native-usage.ts";
import { sumAttemptUsage } from "./model-fallback.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import type { StructuredOutputRuntime } from "./structured-output.ts";
import type { updateStreamingText } from "./streaming-text.ts";
import { createRepeatedSubagentCallGuardState, recordToolEndForSubagentLoopGuard, recordToolStartForSubagentLoopGuard } from "./subagent-tool-loop-guard.ts";
import { JournalFrames, NativeJournal, nativeProjection, scanJournal, type Projection } from "../../shared/journal-reader.ts";
import { compactObservedMessage, ExitCodeObservation } from "./child-observations.ts";

const liveProjection: Projection = (path, root) => {
	if (!path.length) return true;
	if (["messages", "toolResults"].includes(String(path[0]))) return false;
	if (path[0] === "entry") return path.length === 1 || ["id", "type", "parentId", "timestamp", "customType", "usage", "provider", "model"].includes(String(path[1])) ? 4096 : false;
	if (path[0] === "assistantMessageEvent") return path.length === 1 || ["type", "delta", "contentIndex"].includes(String(path[1])) ? 8192 : false;
	if (path[0] === "result" && root?.type !== "result") return false;
	if (path[0] === "message") {
		if (path.length > 1 && !["role", "timestamp", "provider", "model", "responseModel", "usage", "stopReason", "errorMessage", "toolCallId", "toolName", "isError", "content", "details"].includes(String(path[1]))) return false;
		if (path[1] === "content" && root?.type !== "message_end") return false;
		if (path[1] === "content" && path.length === 2) return 4096;
		if (path[1] === "details") return path.length === 2 || ["preview", "modifiedFiles"].includes(String(path[2])) ? 4096 : false;
		if (path[1] === "content" && path.length > 3) {
			if (path[3] === "thinking" || path[3] === "data") return false;
			if (path[3] === "text") return root?.message?.role === "assistant" ? true : 4096;
			if (path[3] === "arguments") return root?.message?.content?.[Number(path[2])]?.name === "structured_output" ? true : nativeProjection(path, root);
		}
	}
	// ponytail: explicitly consumed tool arguments and structured reports must
	// fit their guard/schema consumer's heap; lifecycle aggregates are skipped.
	return true;
};
const liveKeyLimit = (path: readonly (string | number)[]) => path[0] === "args" || path[0] === "structured_output" || path.includes("arguments") ? Infinity : 4096;

export function buildChildInvocation(input: Omit<Parameters<typeof buildPiArgs>[0], "baseArgs"> & { nativeFinalization?: NativeFinalizationConfig }): {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
	claudeCodeInvocation?: ClaudeCodeInvocation;
} {
	const model = applyThinkingSuffix(input.model, input.thinking);
	if (!model || !isClaudeCodeModel(model)) {
		if (input.orchestratorIntercomTarget) {
			const bridged = applyIntercomBridgeToAgent({ systemPrompt: input.systemPrompt ?? "",
				tools: input.tools, extensions: input.extensions }, resolveIntercomBridge(input.orchestratorIntercomTarget));
			input = { ...input, systemPrompt: bridged.systemPrompt, tools: bridged.tools, extensions: bridged.extensions };
		}
		const built = buildPiArgs({ ...input, structuredOutput: input.nativeFinalization ? undefined : input.structuredOutput, baseArgs: ["--mode", "json", "-p"] });
		if (input.nativeFinalization) {
			const runtime = nativeFinalizationLaunch(input.nativeFinalization);
			built.args.push("--extension", runtime.extension);
			Object.assign(built.env, runtime.env);
			const tools = built.args.indexOf("--tools");
			if (tools >= 0 && !built.args[tools + 1]!.split(",").includes("structured_output")) built.args[tools + 1] += ",structured_output";
		}
		return built;
	}
	const claudeCodeInvocation = buildClaudeCodeInvocation({ ...input, model, systemPrompt: input.systemPrompt ?? undefined,
		sessionName: input.intercomSessionName, outputSchema: input.structuredOutput?.schema });
	return { args: claudeCodeInvocation.args, env: claudeCodeInvocation.env, claudeCodeInvocation };
}

export interface ChildEvent {
	type?: string;
	assistantMessageEvent?: Parameters<typeof updateStreamingText>[1]["assistantMessageEvent"];
	message?: Message;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	isError?: boolean;
}

export interface NativeAttemptSegment {
	event: NativeFinalizationEvent;
	messages: Message[];
	usage: Usage;
	durationMs: number;
	execution?: Pick<ChildAttemptResult, "exitCode" | "error" | "interrupted" | "timedOut" | "resourceLimitExceeded" | "terminalFailure">;
}

export interface ChildAttemptResult {
	accounting?: { state: "complete" | "incomplete"; error?: string };
	nativeSessionId?: string;
	terminalLeafId?: string | null;
	terminalEntryId?: string;
	effectiveConfiguration?: { model?: string; thinking?: string; modelRecordedAt?: number };
	attemptBaseline?: string[];
	auditPath?: string;
	auditSaveError?: string;
	auditRecords?: Array<{ kind: string; messageNumber?: number; offset: number; length: number }>;
	nativeReferences?: Array<{ messageNumber?: number; entryId: string }>;
	messageCount?: number;
	finalization?: NativeAttemptSegment[];
	stderr: string;
	agentProcessExit?: AgentProcessExit;
	exitCode: number;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	finalOutput: string;
	interrupted?: boolean;
	timedOut?: boolean;
	terminalFailure?: boolean;
	observedCompletedMutation: boolean;
	resourceLimitExceeded?: ResourceLimitExceeded;
	durationMs: number;
}

export interface ChildAttemptControl {
	pid?: number;
	readonly stopping: boolean;
	stop(outcome: Pick<ChildAttemptResult, "error" | "timedOut" | "interrupted">): void;
}

interface ChildAttemptOptions {
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	agent: string;
	model?: string;
	maxSubagentDepth?: number;
	maxExecutionTimeMs?: number;
	maxTokens?: number;
	claudeCodeInvocation?: ClaudeCodeInvocation;
	sessionFile?: string;
	auditPath?: string;
	structuredOutput?: StructuredOutputRuntime;
	reportRuntime?: StructuredOutputRuntime;
	nativeFinalization?: NativeFinalizationConfig;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	onStart?: (control: ChildAttemptControl, result: ChildAttemptResult) => void;
	onEvent?: (event: ChildEvent, result: ChildAttemptResult, mutation?: MutationToolResult) => void;
	onFailure?: (result: ChildAttemptResult) => void;
	onOutput?: (text: string) => void;
	onRawLine?: (stream: "stdout" | "stderr", line: string) => void;
	onStderr?: (text: string) => void;
}

/** One owned process group and finalized JSON event stream for either native backend. */
export function runChildAttempt(options: ChildAttemptOptions): Promise<ChildAttemptResult> {
	const result: ChildAttemptResult = {
		stderr: "", exitCode: 0, messages: [], model: options.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		finalOutput: "", observedCompletedMutation: false, durationMs: 0,
	};
	if (options.signal?.aborted || options.interruptSignal?.aborted) {
		Object.assign(result, resolveExecutionOutcome({ result, signal: options.signal, interruptSignal: options.interruptSignal }));
		result.finalOutput = result.error ?? "Interrupted. Waiting for explicit next action.";
		return Promise.resolve(result);
	}
	const sessionDirectoryArg = options.args.indexOf("--session-dir");
	const sessionDirectory = sessionDirectoryArg >= 0 ? options.args[sessionDirectoryArg + 1] : undefined;
	const nativeSessionFile = () => options.claudeCodeInvocation ? undefined : options.sessionFile ?? (sessionDirectory ? findLatestSessionFile(sessionDirectory) ?? undefined : undefined);
	let baseline: Set<string>;
	let baselineSnapshot: ReturnType<typeof snapshotNativeBaseline>;
	try { baselineSnapshot = snapshotNativeBaseline(nativeSessionFile()); baseline = baselineSnapshot.ids; } catch (error) {
		return Promise.resolve({ ...result, exitCode: 1, terminalFailure: true, error: `Cannot capture native usage baseline: ${error instanceof Error ? error.message : String(error)}` });
	}
	const streamId = randomUUID();
	let wireDirectory = "", wireFd = -1, textFd = -1, stderrFd = -1;
	try {
		const parent = options.auditPath ? path.dirname(options.auditPath) : tmpdir();
		mkdirSync(parent, { recursive: true });
		wireDirectory = mkdtempSync(path.join(parent, ".pi-subagents-wire-"));
		wireFd = openSync(path.join(wireDirectory, "stdout"), "wx+");
		textFd = openSync(path.join(wireDirectory, "text"), "wx+");
		stderrFd = openSync(path.join(wireDirectory, "stderr"), "wx+");
	} catch (error) {
		if (wireFd >= 0) closeSync(wireFd);
		if (textFd >= 0) closeSync(textFd);
		if (stderrFd >= 0) closeSync(stderrFd);
		if (wireDirectory) rmSync(wireDirectory, { recursive: true, force: true });
		return Promise.resolve({ ...result, exitCode: 1, terminalFailure: true, error: `Cannot prepare child observations: ${String(error)}` });
	}
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const invocation = options.claudeCodeInvocation;
		const command = invocation ?? getPiSpawnCommand(options.args);
		const child = spawn(command.command, command.args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, ...getSubagentDepthEnv(options.maxSubagentDepth), PI_SUBAGENT_NATIVE_BASELINE_COUNT: baselineSnapshot.legacy ? String(baselineSnapshot.entryCount) : "" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const lifecycle = attachChildProcessLifecycle(child);
		const mutations = createMutationCompletionTracker();
		const toolLoop = createRepeatedSubagentCallGuardState();
		const wirePath = path.join(wireDirectory, "stdout");
		let textOffset = 0;
		const observations: Array<{ start: number; end: number; kind: string; number?: number; message?: Message; nativeEntryId?: string }> = [];
		const referenceMessage = (entry: NativeUsageMetadata) => {
			const message = entry.message;
			if (!message) return;
			const observation = observations.find((item) => (!item.nativeEntryId || item.nativeEntryId === entry.id)
				&& item.message?.role === message.role && item.message.timestamp === message.timestamp
				&& (!message.toolCallId || item.message.role === "toolResult" && item.message.toolCallId === message.toolCallId));
			if (observation) observation.nativeEntryId = entry.id;
			return observation;
		};
		let rawOutput = "", lastOutput = "", boundariesCursor = 0;
		let receiverFailed = false;
		const acceptedEntries = new Map<string, NativeUsageMetadata>();
		let nativeMessageCount = 0;
		const pendingBoundary = Symbol("pending boundary");
		let textWritten = false, exitObservation = new ExitCodeObservation(), firstTextPath: string | undefined;
		let outputTextPath: string | undefined, pendingSurrogate = "";
		let reproject = false, replayOutput = false;
		result.attemptBaseline = [...baseline];
		let assistantError: string | undefined;
		let cleanAssistantStop = false;
		let settled = false;
		let resourceTimer: NodeJS.Timeout | undefined;
		let attemptStartedAt = startedAt;
		let messageOffset = 0;
		// maxTokens bounds this assistant; billing also includes nested tools and summaries.
		let assistantTokens = 0;
		let attemptAssistantTokens = 0;
		const attemptUsage = { ...result.usage };
		const resetResourceTimer = () => {
			clearTimeout(resourceTimer);
			if (options.maxExecutionTimeMs !== undefined) {
				const limit = options.maxExecutionTimeMs;
				resourceTimer = setTimeout(() => {
					syncFinalization();
					if (Date.now() - attemptStartedAt >= limit) resourceLimit("maxExecutionTimeMs", limit);
					else resetResourceTimer();
				}, Math.max(0, limit - (Date.now() - attemptStartedAt)));
				resourceTimer.unref();
			}
		};

		const stop = (outcome: Pick<ChildAttemptResult, "error" | "timedOut" | "interrupted">) => {
			if (settled) return;
			Object.assign(result, outcome);
			result.durationMs = Date.now() - startedAt;
			if (outcome.error) options.onOutput?.(`${outcome.error}\n`);
			options.onFailure?.(result);
			lifecycle.terminate();
		};
		const resourceLimit = (kind: ResourceLimitExceeded["kind"], limit: number, observed?: number) => {
			if (settled || result.resourceLimitExceeded || result.timedOut || lifecycle.stopping) return;
			const message = formatResourceLimitExceeded({ agent: options.agent, kind, limit, observed });
			result.resourceLimitExceeded = { kind, limit, ...(observed !== undefined ? { observed } : {}), message };
			stop({ error: message });
		};
		const syncFinalization = () => {
			if (!options.nativeFinalization) return;
			const file = path.join(path.dirname(options.nativeFinalization.reportRuntime.schemaPath), "boundaries.jsonl");
			const messages = result.messages.filter((message) => ["assistant", "user", "toolResult"].includes(message.role));
			try { scanJournal(file, () => true, ({ value, end }) => {
				const marker = value as NativeFinalizationEvent;
				if (marker.nonce !== options.nativeFinalization!.nonce) throw new Error("Unexpected finalization nonce");
				if (marker.messageCount > messages.length) throw pendingBoundary;
				const segmentMessages = messages.slice(messageOffset, marker.messageCount);
				const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				let segmentAssistantTokens = 0;
				for (const message of segmentMessages) {
					if (message.role === "assistant") {
						usage.turns++;
						segmentAssistantTokens += (message.usage?.input ?? 0) + (message.usage?.output ?? 0);
					}
					if ((message.role === "assistant" || message.role === "toolResult") && message.usage) addUsage(usage, message.usage);
				}
				(result.finalization ??= []).push({ event: marker, messages: segmentMessages, usage, durationMs: marker.at - attemptStartedAt });
				if (options.maxTokens !== undefined && segmentAssistantTokens >= options.maxTokens) resourceLimit("maxTokens", options.maxTokens, segmentAssistantTokens);
				if (options.maxExecutionTimeMs !== undefined && marker.at - attemptStartedAt >= options.maxExecutionTimeMs) resourceLimit("maxExecutionTimeMs", options.maxExecutionTimeMs);
				if (marker.nextPrompt) {
					messageOffset = marker.messageCount;
					attemptAssistantTokens += segmentAssistantTokens;
					for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) attemptUsage[key] += usage[key];
					attemptStartedAt = marker.at;
					resetResourceTimer();
				}
				options.onEvent?.(marker, result);
				boundariesCursor = end;
			}, { policy: "live", start: boundariesCursor }); } catch (error) { if (error !== pendingBoundary && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		};
		const processEvent = (input: ChildEvent) => {
			let event = input;
			if (!event || typeof event !== "object") return;
			if (event.type !== "message_update") syncFinalization();
			if (event.type === "subagent.native_baseline") {
				const value = event as ChildEvent & { sessionId: string; entryIds: string[] };
				if (!baselineSnapshot.legacy || value.sessionId !== baselineSnapshot.sessionId || !Array.isArray(value.entryIds)
					|| new Set(value.entryIds).size !== baselineSnapshot.entryCount || value.entryIds.some((id) => typeof id !== "string" || !id)) throw new Error("Cannot reconcile native legacy baseline");
				baseline.clear(); baseline.add(value.sessionId); for (const id of value.entryIds) baseline.add(id);
				result.attemptBaseline = [...baseline];
			}
			if (event.type === "subagent.native") {
				const native = event as ChildEvent & { sessionId: string; leafId: string | null; persisted?: boolean; configuration: ChildAttemptResult["effectiveConfiguration"]; entries: Array<NativeUsageMetadata & { message?: { role: string; timestamp: number; toolCallId?: string } }> };
				result.nativeSessionId = native.sessionId;
				result.terminalLeafId = native.leafId;
				result.terminalEntryId = native.entries.at(-1)?.id ?? result.terminalEntryId;
				result.effectiveConfiguration = native.configuration;
				if (!native.persisted) for (const entry of native.entries) acceptedEntries.set(entry.id, entry);
				const nativeReferences = [];
				if (native.persisted) for (const entry of native.entries) if (entry.message) {
					const observation = referenceMessage(entry);
					if (observation) {
						nativeReferences.push({ messageNumber: observation.number, entryId: entry.id });
					}
				}
				Object.assign(event, { nativeReferences, referenceState: "observed" });
			}
			lifecycle.observeEvent(invocation && event.type === "result" ? "agent_settled" : event.type);
			if (invocation && event.type === "result") {
				const nativeResult = event as ClaudeCodeResultEvent;
				// Claude reports totals, not a native per-category cost receipt. Keep
				// that observation rather than inventing zero-valued category costs.
				result.accounting = { state: "incomplete", error: "Claude Code did not provide the complete native usage/cost receipt. Reported totals and its audit were retained." };
				if (options.structuredOutput && nativeResult.structured_output !== undefined) {
					mkdirSync(path.dirname(options.structuredOutput.outputPath), { recursive: true });
					writeFileSync(options.structuredOutput.outputPath, `${JSON.stringify(nativeResult.structured_output)}\n`, "utf8");
				}
				const message = claudeCodeMessageFromResult(nativeResult, invocation.model.inputModel);
				if (options.sessionFile) {
					writeClaudeCodeSessionMetadata(options.sessionFile, {
						sessionId: nativeResult.session_id || invocation.sessionId,
						model: invocation.model.inputModel, cliModel: invocation.model.cliModel,
						family: invocation.model.family, context: invocation.model.context, updatedAt: Date.now(),
					});
					const { result: _result, structured_output: _structured, ...observation } = nativeResult;
					appendClaudeCodeMessage(options.sessionFile, message, observation);
				}
				event = { type: "message_end", message };
			}
			let mutation: MutationToolResult | undefined;
			let loopFailure: string | undefined;
			if (event.type === "tool_execution_start") {
				loopFailure = recordToolStartForSubagentLoopGuard({ state: toolLoop, ...event, toolName: event.toolName, args: event.args });
				mutations.recordToolStart({ id: event.toolCallId, toolName: event.toolName, args: event.args,
					path: resolveCurrentPath(event.toolName, event.args), startedAt: Date.now() });
				const args = extractToolArgsPreview(event.args ?? {});
				if (event.toolName) options.onOutput?.(`${event.toolName}${args ? `: ${args}` : ""}\n`);
			} else if (event.type === "tool_execution_end") {
				loopFailure = recordToolEndForSubagentLoopGuard({ state: toolLoop, ...event, toolName: event.toolName, isError: event.isError });
			} else if (event.type === "message_end" && event.message) {
				const message = event.message;
				if (message.role === "assistant" && !message.usage) result.accounting = { state: "incomplete", error: "Required assistant usage is unavailable; execution was not repeated." };
				const final = getFinalOutput([message]);
				if (final) lastOutput = final;
				result.messages.push(compactObservedMessage(message));
				if (["assistant", "user", "toolResult"].includes(message.role)) nativeMessageCount++;
				result.messageCount = nativeMessageCount;
				const text = extractTextFromContent(message.content);
				if (textWritten) options.onOutput?.("\n");
				else if (invocation && text) options.onOutput?.(`${text}\n`);
				if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
					try { addUsage(result.usage, message.usage, { id: `stream:${streamId}:${result.messages.length}`,
						provider: message.role === "assistant" ? message.provider : undefined,
						model: message.role === "assistant" ? message.responseModel ?? message.model : undefined });
						validateNativeUsage(message.usage);
					} catch (error) { result.accounting = { state: "incomplete", error: String(error) }; }
				}
				if (message.role === "toolResult") {
					mutation = mutations.recordToolResult(message);
					if (mutation?.completedMutation) result.observedCompletedMutation = true;
				} else if (message.role === "assistant") {
					result.model ??= providerQualifiedModelId(message.provider, message.model);
					result.usage.turns++;
					assistantTokens += (message.usage?.input ?? 0) + (message.usage?.output ?? 0);
					if (message.errorMessage) assistantError = message.errorMessage;
					cleanAssistantStop = message.stopReason === "stop" && !message.errorMessage
						&& !message.content.some((part) => part.type === "toolCall");
					if (cleanAssistantStop && text.trim()) assistantError = undefined;
				}
			}
			result.durationMs = Date.now() - startedAt;
			options.onEvent?.(event, result, mutation);
			if (loopFailure && !lifecycle.stopping) {
				result.terminalFailure = true;
				stop({ error: loopFailure });
			}
			if (event.type === "message_end") syncFinalization();
			const tokens = assistantTokens - attemptAssistantTokens;
			if (options.maxTokens !== undefined && tokens >= options.maxTokens) resourceLimit("maxTokens", options.maxTokens, tokens);
		};

		const copyBytes = (fd: number, start: number, end: number, consume: (bytes: Buffer) => void) => {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			for (let position = start; position < end;) {
				const count = readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
				if (!count) throw new Error("Missing child audit bytes");
				consume(buffer.subarray(0, count)); position += count;
			}
		};
		const appendText = (text: string) => {
			const bytes = Buffer.from(text);
			for (let offset = 0; offset < bytes.length;) {
				const count = writeSync(textFd, bytes, offset, bytes.length - offset, textOffset + offset);
				if (!count) throw new Error("Cannot write child output spool");
				offset += count;
			}
			textOffset += bytes.length;
		};
		const resetRecord = () => {
			textWritten = false; exitObservation = new ExitCodeObservation(); firstTextPath = undefined;
			pendingSurrogate = ""; outputTextPath = undefined; reproject = false; replayOutput = false;
			textOffset = 0; ftruncateSync(textFd, 0);
		};
		const consumeMessageText = (path: readonly (string | number)[], text: string, root?: Record<string, any>) => {
			if (root?.type !== "message_end" || path[0] !== "message" || path[1] !== "content" || path.at(-1) !== "text" && path.length !== 2) return;
			const key = path.join(".");
			if (outputTextPath !== key) {
				if (pendingSurrogate) { textWritten = true; appendText(pendingSurrogate); }
				pendingSurrogate = "";
				if (textWritten && text) appendText("\n");
				outputTextPath = key;
			}
			// Unpacked JSON escape tokens can split a surrogate pair. Join that one
			// code unit before handing text to an output writer.
			const joined = pendingSurrogate + text;
			pendingSurrogate = /[\uD800-\uDBFF]/.test(joined.at(-1) ?? "") ? joined.at(-1)! : "";
			const output = pendingSurrogate ? joined.slice(0, -1) : joined;
			if (output) { textWritten = true; appendText(output); }
			if (path.length !== 4) return;
			firstTextPath ??= key;
			if (firstTextPath === key) exitObservation.write(text);
		};
		const stdout = new JournalFrames((path, root) => {
			if (invocation) return !path.length || ["type", "subtype", "is_error", "api_error_status", "result", "stop_reason", "session_id", "total_cost_usd", "usage", "modelUsage", "structured_output"].includes(String(path[0]));
			if (path[0] === "message" && path[1] === "content" && !root?.type) replayOutput = true;
			if (path[0] === "message" && path[1] === "content" && (!root?.type || path.at(-1) === "text" && !root.message?.role
				|| path.includes("arguments") && !root.message?.content?.[Number(path[2])]?.name)) reproject = true;
			return liveProjection(path, root);
		}, ({ value: projected, start, end }) => {
			if (!projected || typeof projected !== "object" || Array.isArray(projected)) { resetRecord(); return; }
			let value = projected;
			if (reproject && value.type === "message_end") {
				// JSON member order is not semantic. Revisit only this selected value
				// when attribution/call names appeared after their payloads.
				for (let pass = 0; pass < 2; pass++) {
					const known = value;
					scanJournal(wirePath, (path, root) => liveProjection(path, { ...root, type: known.type,
						message: { ...root?.message, role: known.message?.role, content: known.message?.content ?? root?.message?.content } }),
					(record) => { value = record.value; }, { start, end, policy: "strict", keys: liveKeyLimit,
						...(pass === 0 && replayOutput ? { stringChunk: (path, text, root) => consumeMessageText(path, text, { ...root, type: known.type }) } : {}) });
				}
			}
			reproject = false; replayOutput = false;
			if (pendingSurrogate) { textWritten = true; appendText(pendingSurrogate); }
			pendingSurrogate = ""; outputTextPath = undefined;
			const decoder = new StringDecoder("utf8");
			copyBytes(textFd, 0, textOffset, (bytes) => options.onOutput?.(decoder.write(bytes)));
			const tail = decoder.end(); if (tail) options.onOutput?.(tail);
			if (exitObservation.value !== undefined && value.type === "message_end" && value.message?.role === "toolResult") value.message.observedExitCode = exitObservation.value;
			processEvent(value as ChildEvent);
			if (["message_end", "tool_execution_end"].includes(value.type) || invocation && (value.type !== "result" || !options.sessionFile)) observations.push({ start, end, kind: value.type,
				...(value.type === "message_end" ? { number: nativeMessageCount, message: compactObservedMessage(value.message) } : {}) });
			resetRecord();
		}, "inspect", 0, (start, end) => {
			observations.push({ start, end, kind: "diagnostic" });
			const decoder = new StringDecoder("utf8");
			copyBytes(wireFd, start, end, (bytes) => {
				const text = decoder.write(bytes);
				rawOutput = (rawOutput + text).slice(-16384);
				options.onOutput?.(text); options.onRawLine?.("stdout", text);
			});
			const tail = decoder.end(); if (tail) options.onOutput?.(tail);
			resetRecord();
		}, consumeMessageText, liveKeyLimit);
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (bytes: Buffer) => {
			try { writeFileSync(wireFd, bytes); if (!receiverFailed) stdout.write(bytes); } catch (error) {
				receiverFailed = true;
				result.terminalFailure = true; stop({ error: `Cannot receive child events: ${String(error)}` });
			}
		});
		child.stderr.on("data", (text: string) => {
			try {
				writeFileSync(stderrFd, text);
				result.stderr = (result.stderr + text).slice(-16384);
				options.onStderr?.(text);
			} catch (error) {
				result.terminalFailure = true; stop({ error: `Cannot save child diagnostics: ${String(error)}` });
			}
		});
		const abortListener = options.signal && addAbortListener(options.signal, () => {
			const reason = options.signal?.reason;
			stop({ error: reason instanceof Error && reason.name === "TimeoutError" ? reason.message : "Subagent cancelled.",
				timedOut: reason instanceof Error && reason.name === "TimeoutError" || undefined, interrupted: false });
		});
		const interruptListener = options.interruptSignal && addAbortListener(options.interruptSignal, () => {
			if (options.signal?.aborted || result.resourceLimitExceeded || result.timedOut) return;
			stop({ interrupted: true, error: undefined });
		});
		const finish = (code: number | null, signal?: NodeJS.Signals | null, spawnError?: Error) => {
			if (settled) return;
			// A final non-newline JSON record has the same authority as a complete line.
			try { if (!receiverFailed) stdout.finish(); } catch (error) { receiverFailed = true; result.error ??= String(error); result.terminalFailure = true; }
			try { syncFinalization(); } catch (error) { result.error ??= `Cannot read finalization boundary: ${String(error)}`; result.terminalFailure = true; }
			settled = true;
			clearTimeout(resourceTimer);
			abortListener?.[Symbol.dispose]();
			interruptListener?.[Symbol.dispose]();
			result.agentProcessExit = lifecycle.agentProcessExit;
			result.durationMs = Date.now() - startedAt;
			const reportRuntime = options.nativeFinalization?.reportRuntime ?? options.reportRuntime;
			const report = reportRuntime && readFinalizationReport(result.messages, reportRuntime).output;
			const structured = options.structuredOutput && readStructuredOutput(options.structuredOutput);
			const completedOutput = cleanAssistantStop || report || structured && !structured.error;
			if (report) assistantError = undefined;
			result.error ??= assistantError ?? spawnError?.message;
			const drainedSuccess = lifecycle.settledCleanup && (cleanAssistantStop || report) && !result.error;
			if (code !== 0 && !result.error && !drainedSuccess && !result.interrupted) result.error = result.stderr.trim() || undefined;
			result.exitCode = result.timedOut ? 124 : result.resourceLimitExceeded || result.terminalFailure ? 1
				: result.interrupted || drainedSuccess ? 0 : lifecycle.stopping || signal ? code ?? 1 : code ?? 0;
			if (result.interrupted) result.error = undefined;
			if (result.exitCode === 0 && !result.interrupted && !result.error && !completedOutput) {
				result.error = options.nativeFinalization ? "Native self-review boundary did not return a result." : "Child exit was observed, but no completed assistant result was returned.";
				result.exitCode = 1; result.terminalFailure = true;
			}
			result.finalOutput = result.resourceLimitExceeded?.message ?? (lastOutput || rawOutput.trim());
			if (options.nativeFinalization) {
				const previous = result.finalization?.at(-1);
				if (previous?.event.nextPrompt) {
					const usage = { ...result.usage, contributions: result.usage.contributions?.slice(attemptUsage.contributions?.length ?? 0) };
					for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) usage[key] -= attemptUsage[key];
					result.finalization!.push({ event: { type: FINALIZATION_EVENT, nonce: options.nativeFinalization.nonce,
						turn: previous.event.turn + 1, messageCount: result.messages.length, at: Date.now(), submission: { output: "" }, resolvedOutput: previous.event.resolvedOutput },
						messages: result.messages.slice(messageOffset), usage, durationMs: Date.now() - attemptStartedAt });
				}
				const final = result.finalization?.at(-1);
				if (final) {
					if (final.event.turn > 0) final.event.submission = { ...readFinalizationReport(result.messages, options.nativeFinalization.reportRuntime, { messageOffset }), error: final.event.submission.error };
					final.execution = { exitCode: result.exitCode, error: result.error, interrupted: result.interrupted,
						timedOut: result.timedOut, resourceLimitExceeded: result.resourceLimitExceeded, terminalFailure: result.terminalFailure };
				} else if (result.exitCode === 0 && !result.error && !result.interrupted) {
					result.error = "Native self-review boundary did not return a result.";
					result.exitCode = 1;
					result.terminalFailure = true;
				}
			}
			const publishedIds = new Set<string>();
			try {
				const native = readNativeUsage(nativeSessionFile(), baseline, result.finalization?.map((segment) => segment.event.lastEntryId), {
					onEntry: (entry) => { if (entry.type === "message") { publishedIds.add(entry.id); referenceMessage(entry); } },
					onBoundary: ({ sessionId, lastEntryId }) => { result.nativeSessionId = sessionId; result.terminalEntryId = lastEntryId; },
				});
				const accepted = !native && result.nativeSessionId && acceptedEntries.size
					? nativeUsageCollector(result.nativeSessionId, baseline, result.finalization?.map((segment) => segment.event.lastEntryId)) : undefined;
				if (accepted) for (const entry of acceptedEntries.values()) accepted.append(entry);
				const totals = native ?? accepted?.totals;
				if (totals) {
					if (native && observations.some((item) => item.message && (item.message.role === "assistant" || item.message.role === "toolResult" && item.message.usage)
						&& (!item.nativeEntryId || !publishedIds.has(item.nativeEntryId)))) throw new Error("Finalized message usage has no verified native commit; its reported usage and audit remain available.");
					result.accounting = { state: "complete" };
					result.usage = sumAttemptUsage(totals.map((usage) => ({ model: result.model ?? "default", success: true, usage })));
					result.finalization?.forEach((segment, index) => { segment.usage = totals[index]!; });
				}
			} catch (error) {
				result.accounting = { state: "incomplete", error: `Cannot read finalized native usage: ${error instanceof Error ? error.message : String(error)}` };
			}
			for (const item of observations) if (item.nativeEntryId) {
				if (publishedIds.has(item.nativeEntryId)) (result.nativeReferences ??= []).push({ messageNumber: item.number, entryId: item.nativeEntryId });
				else item.nativeEntryId = undefined;
			}
			result.accounting ??= { state: "complete" };
			const file = nativeSessionFile();
			if (!result.effectiveConfiguration && file) try {
				const journal = new NativeJournal(file);
				const terminal = journal.records.findLast((record) => record.value.type !== "session");
				result.terminalEntryId ??= terminal?.value.id;
				result.terminalLeafId ??= result.terminalEntryId;
				result.effectiveConfiguration = journal.configuration(undefined, result.terminalLeafId);
			} catch (error) { result.accounting = { state: "incomplete", error: result.accounting.error ?? `Cannot capture terminal native selection: ${String(error)}` }; }
			const retained = receiverFailed ? [{ start: 0, end: fstatSync(wireFd).size, kind: "receiver_failure", number: undefined }] : observations.filter((item) => !item.nativeEntryId);
			const auditPath = options.auditPath ?? path.join(wireDirectory, "observations.log");
			const stderrLength = fstatSync(stderrFd).size;
			let retainedWire = false;
			try { if (retained.length || stderrLength) {
				const audit = openSync(auditPath, "a", 0o600);
				try {
					let offset = fstatSync(audit).size;
					for (const item of retained) {
						copyBytes(wireFd, item.start, item.end, (bytes) => writeFileSync(audit, bytes));
						(result.auditRecords ??= []).push({ kind: item.kind, messageNumber: item.number, offset, length: item.end - item.start });
						offset += item.end - item.start;
					}
					if (stderrLength) {
						copyBytes(stderrFd, 0, stderrLength, (bytes) => writeFileSync(audit, bytes));
						(result.auditRecords ??= []).push({ kind: "stderr", offset, length: stderrLength });
					}
					result.auditPath = auditPath;
				} finally { closeSync(audit); }
			}
			} catch (error) { retainedWire = true; result.auditSaveError = String(error); result.auditPath = wireDirectory; }
			finally {
				closeSync(wireFd); closeSync(textFd); closeSync(stderrFd);
				if (!retainedWire) {
					if (result.auditPath?.startsWith(`${wireDirectory}${path.sep}`)) {
						rmSync(wirePath); rmSync(path.join(wireDirectory, "text")); rmSync(path.join(wireDirectory, "stderr"));
					} else rmSync(wireDirectory, { recursive: true, force: true });
				}
			}
			resolve(result);
		};
		child.on("close", (code, signal) => finish(code, signal));
		child.on("error", (error) => finish(1, undefined, error));
		resetResourceTimer();
		options.onStart?.({ pid: child.pid, get stopping() { return lifecycle.stopping; }, stop }, result);
	});
}
