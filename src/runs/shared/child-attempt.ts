import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { attachChildProcessLifecycle } from "../../shared/post-exit-stdio-guard.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge } from "../../intercom/intercom-bridge.ts";
import { providerQualifiedModelId } from "../../shared/model-info.ts";
import { getSubagentDepthEnv, type AgentProcessExit, type ResourceLimitExceeded, type Usage } from "../../shared/types.ts";
import { extractTextFromContent, extractToolArgsPreview, formatResourceLimitExceeded, getFinalOutput, findLatestSessionFile } from "../../shared/utils.ts";
import { readFinalizationReport, resolveExecutionOutcome } from "./acceptance.ts";
import {
	appendClaudeCodeMessage, buildClaudeCodeInvocation, claudeCodeMessageFromResult, isClaudeCodeModel, writeClaudeCodeSessionMetadata,
	type ClaudeCodeInvocation, type ClaudeCodeResultEvent,
} from "./claude-code.ts";
import { createMutationCompletionTracker, resolveCurrentPath, type MutationToolResult } from "./mutating-tool-guard.ts";
import { applyThinkingSuffix, buildPiArgs } from "./pi-args.ts";
import { FINALIZATION_EVENT, nativeFinalizationLaunch, type NativeFinalizationConfig, type NativeFinalizationEvent } from "./native-finalization.ts";
import { addUsage, readNativeUsage, snapshotNativeUsage } from "./native-usage.ts";
import { sumAttemptUsage } from "./model-fallback.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import type { StructuredOutputRuntime } from "./structured-output.ts";
import type { updateStreamingText } from "./streaming-text.ts";
import { createRepeatedSubagentCallGuardState, recordToolEndForSubagentLoopGuard, recordToolStartForSubagentLoopGuard } from "./subagent-tool-loop-guard.ts";

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
	try { baseline = snapshotNativeUsage(nativeSessionFile()); } catch (error) {
		return Promise.resolve({ ...result, exitCode: 1, terminalFailure: true, error: `Cannot capture native usage baseline: ${error instanceof Error ? error.message : String(error)}` });
	}
	const streamId = randomUUID();
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const invocation = options.claudeCodeInvocation;
		const command = invocation ?? getPiSpawnCommand(options.args);
		const child = spawn(command.command, command.args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, ...getSubagentDepthEnv(options.maxSubagentDepth) },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const lifecycle = attachChildProcessLifecycle(child);
		const mutations = createMutationCompletionTracker();
		const toolLoop = createRepeatedSubagentCallGuardState();
		let stdoutBuffer = "";
		let stderrBuffer = "";
		const rawOutput: string[] = [];
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
			let text: string;
			try { text = readFileSync(path.join(path.dirname(options.nativeFinalization.reportRuntime.schemaPath), "boundaries.jsonl"), "utf8"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
			const messages = result.messages.filter((message) => ["assistant", "user", "toolResult"].includes(message.role));
			for (const line of text.split("\n").slice(0, -1).slice(result.finalization?.length ?? 0)) {
				const marker = JSON.parse(line) as NativeFinalizationEvent;
				if (marker.nonce !== options.nativeFinalization.nonce || marker.messageCount > messages.length) break;
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
			}
		};
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: ChildEvent;
			try { event = JSON.parse(line) as ChildEvent; } catch {
				rawOutput.push(line);
				options.onOutput?.(`${line}\n`);
				options.onRawLine?.("stdout", line);
				return;
			}
			if (!event || typeof event !== "object") return;
			if (event.type !== "message_update") syncFinalization();
			lifecycle.observeEvent(invocation && event.type === "result" ? "agent_settled" : event.type);
			if (invocation && event.type === "result") {
				const nativeResult = event as ClaudeCodeResultEvent;
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
					appendClaudeCodeMessage(options.sessionFile, message);
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
				result.messages.push(message);
				const text = extractTextFromContent(message.content);
				if (text) options.onOutput?.(`${text}\n`);
				if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
					addUsage(result.usage, message.usage, { id: `stream:${streamId}:${result.messages.length}`,
						provider: message.role === "assistant" ? message.provider : undefined,
						model: message.role === "assistant" ? message.responseModel ?? message.model : undefined });
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

		// Decode UTF-8 across pipe chunks before splitting JSON lines.
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (text: string) => {
			stdoutBuffer += text;
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (text: string) => {
			result.stderr += text;
			options.onStderr?.(text);
			stderrBuffer += text;
			const lines = stderrBuffer.split("\n");
			stderrBuffer = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) options.onRawLine?.("stderr", line);
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
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			if (stderrBuffer.trim()) options.onRawLine?.("stderr", stderrBuffer);
			syncFinalization();
			settled = true;
			clearTimeout(resourceTimer);
			abortListener?.[Symbol.dispose]();
			interruptListener?.[Symbol.dispose]();
			result.agentProcessExit = lifecycle.agentProcessExit;
			result.durationMs = Date.now() - startedAt;
			const reportRuntime = options.nativeFinalization?.reportRuntime ?? options.reportRuntime;
			const report = reportRuntime && readFinalizationReport(result.messages, reportRuntime).output;
			if (report) assistantError = undefined;
			result.error ??= assistantError ?? spawnError?.message;
			const drainedSuccess = lifecycle.settledCleanup && (cleanAssistantStop || report) && !result.error;
			if (code !== 0 && !result.error && !drainedSuccess && !result.interrupted) result.error = result.stderr.trim() || undefined;
			result.exitCode = result.timedOut ? 124 : result.resourceLimitExceeded || result.terminalFailure ? 1
				: result.interrupted || drainedSuccess ? 0 : lifecycle.stopping || signal ? code ?? 1 : code ?? 0;
			if (result.interrupted) result.error = undefined;
			result.finalOutput = result.resourceLimitExceeded?.message ?? (getFinalOutput(result.messages) || rawOutput.join("\n").trim());
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
				} else if (!result.error && !result.interrupted) {
					result.error = "Native self-review boundary did not return a result.";
					result.exitCode = 1;
					result.terminalFailure = true;
				}
			}
			try {
				const native = readNativeUsage(nativeSessionFile(), baseline, result.finalization?.map((segment) => segment.event.lastEntryId));
				if (native) {
					result.usage = sumAttemptUsage(native.map((usage) => ({ model: result.model ?? "default", success: true, usage })));
					result.finalization?.forEach((segment, index) => { segment.usage = native[index]!; });
				}
			} catch (error) {
				result.error = `Cannot read finalized native usage: ${error instanceof Error ? error.message : String(error)}`;
				result.exitCode = 1;
				result.terminalFailure = true;
				const last = result.finalization?.at(-1);
				if (last) last.execution = { ...last.execution, exitCode: 1, error: result.error, terminalFailure: true };
			}
			resolve(result);
		};
		child.on("close", (code, signal) => finish(code, signal));
		child.on("error", (error) => finish(1, undefined, error));
		resetResourceTimer();
		options.onStart?.({ pid: child.pid, get stopping() { return lifecycle.stopping; }, stop }, result);
	});
}
