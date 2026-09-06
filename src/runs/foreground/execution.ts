/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "../../shared/artifacts.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type ModelAttempt,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
	formatResourceLimitExceeded,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { hasCompletedMutationToolCall, resolveCompletionPolicy, type CompletionPolicy } from "../shared/completion-guard.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { attachChildProcessLifecycle } from "../../shared/post-exit-stdio-guard.ts";
import { refreshQuestionLaunch, saveQuestionContract } from "../shared/supervisor-questions.ts";
import { saveForegroundLaunch } from "../shared/run-records.ts";
import { providerQualifiedModelId } from "../../shared/model-info.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import {
	appendClaudeCodeMessage,
	buildClaudeCodeInvocation,
	claudeCodeMessageFromResult,
	isClaudeCodeModel,
	writeClaudeCodeSessionMetadata,
	type ClaudeCodeInvocation,
	type ClaudeCodeResultEvent,
} from "../shared/claude-code.ts";
import { readStructuredOutput } from "../shared/structured-output.ts";
import { captureSingleOutputSnapshot, cleanupSingleOutputFile, formatConsumedOutputReference, formatSavedOutputReference, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	runModelAttempts,
	sumAttemptUsage,
} from "../shared/model-fallback.ts";
import {
	createMutatingFailureState,
	createMutationCompletionTracker,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/mutating-tool-guard.ts";
import {
	createRepeatedSubagentCallGuardState,
	recordToolEndForSubagentLoopGuard,
	recordToolStartForSubagentLoopGuard,
} from "../shared/subagent-tool-loop-guard.ts";
import {
	evaluateRunAcceptance,
	resolveExecutionOutcome,
	resolveFinalizationOutput,
	formatAcceptancePrompt,
	resolveEffectiveAcceptance,
	shouldRunAcceptanceFinalization,
	stripAcceptanceReport,
} from "../shared/acceptance.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

const FOREGROUND_TIMEOUT_EXIT_CODE = 124;

function formatForegroundTimeoutMessage(timeoutMs: number | undefined): string {
	return timeoutMs ? `Timed out after ${timeoutMs}ms.` : "Timed out.";
}

function formatProcessExitFailure(input: { agent: string; exitCode: number; durationMs: number }): string {
	const duration = `${input.durationMs}ms`;
	if (input.exitCode === 143) {
		const nearDefaultHttpIdleTimeout = input.durationMs >= 280_000 && input.durationMs <= 330_000;
		const likelyCause = nearDefaultHttpIdleTimeout
			? " This is close to Pi's default 300000ms HTTP idle timeout; if the child was waiting on a slow provider response, raise or disable `httpIdleTimeoutMs` in Pi settings."
			: " The child process received SIGTERM or exited as if terminated by SIGTERM.";
		return `${input.agent} exited with code 143 after ${duration}.${likelyCause}`;
	}
	return `${input.agent} exited with code ${input.exitCode} after ${duration} without producing a final assistant response.`;
}

function collectPartialOutput(result: Pick<SingleResult, "messages" | "finalOutput">, progress?: Pick<AgentProgress, "recentOutput">): string | undefined {
	const fromMessages = getFinalOutput(result.messages ?? []);
	const partial = fromMessages || progress?.recentOutput?.join("\n") || result.finalOutput || "";
	const trimmed = partial.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n…` : trimmed;
}

function formatTimeoutOutput(message: string, result: Pick<SingleResult, "messages" | "finalOutput">, progress?: Pick<AgentProgress, "recentOutput">): string {
	const partial = collectPartialOutput(result, progress);
	if (!partial || partial === message) return message;
	return `${message}\n\nPartial output before timeout:\n${partial}`;
}

function usageTotal(usage: Usage | undefined): number {
	return (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
}

function appendPreviousAttemptContext(result: SingleResult, attempts: ModelAttempt[]): void {
	if (result.exitCode === 0 || !result.error || attempts.length < 2) return;
	const latest = attempts.at(-1);
	if (!latest || usageTotal(latest.usage) > 0) return;
	const prior = attempts.slice(0, -1).reverse().find((attempt) => attempt.error);
	if (!prior?.error) return;
	const context = `Previous attempt before the empty retry failed with: ${prior.error}`;
	if (result.error.includes(context)) return;
	result.error = `${result.error}\n${context}`;
	result.finalOutput = result.finalOutput ? `${result.finalOutput}\n${context}` : result.error;
	if (result.progress?.error) result.progress.error = result.error;
}

function createTimedOutResult(agent: string, task: string, options: RunSyncOptions): SingleResult {
	const message = formatForegroundTimeoutMessage(options.timeoutMs);
	return {
		agent,
		task,
		exitCode: FOREGROUND_TIMEOUT_EXIT_CODE,
		messages: [],
		usage: emptyUsage(),
		error: message,
		finalOutput: message,
		timedOut: true,
		progress: {
			index: options.index ?? 0,
			agent,
			status: "failed",
			task,
			recentTools: [],
			recentOutput: [message],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			lastActivityAt: Date.now(),
		},
		progressSummary: {
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
		},
	};
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				part.text = stripAcceptanceReport(part.text);
			}
		}
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.outputMode === "file-only" && result.savedOutputPath ? undefined : result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		controlEvents: result.controlEvents ? result.controlEvents.map((event) => ({ ...event })) : undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
	};
}

type AttemptOptions = RunSyncOptions & { onIntercomDetach?: (result: SingleResult) => void };
type AttemptResult = SingleResult & { terminalFailure?: boolean };

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: AttemptOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		skillsWarning?: string;
		artifactPaths?: ArtifactPaths;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
		previousOutput?: string;
		originalTask?: string;
		completionPolicy: CompletionPolicy;
	},
): Promise<AttemptResult> {
	if (options.signal?.aborted || options.interruptSignal?.aborted) {
		const outcome = resolveExecutionOutcome({ result: { exitCode: 1 }, signal: options.signal, interruptSignal: options.interruptSignal });
		return { agent: agent.name, task, ...outcome, exitCode: outcome.exitCode ?? 1, messages: [], usage: emptyUsage(),
			finalOutput: outcome.error ?? "Interrupted. Waiting for explicit next action." };
	}
	const modelArg = applyThinkingSuffix(model, agent.thinking);
	let args: string[];
	let sharedEnv: Record<string, string | undefined>;
	let tempDir: string | undefined;
	let claudeCodeInvocation: ClaudeCodeInvocation | undefined;
	try {
		if (modelArg && isClaudeCodeModel(modelArg)) {
			claudeCodeInvocation = buildClaudeCodeInvocation({
				model: modelArg,
				task,
				systemPrompt: shared.systemPrompt,
				systemPromptMode: agent.systemPromptMode,
				sessionFile: options.sessionFile,
				sessionName: options.intercomSessionName,
				tools: agent.tools,
				mcpDirectTools: agent.mcpDirectTools,
				allowSubagents: agent.allowSubagents,
				outputSchema: options.structuredOutput?.schema,
			});
			args = claudeCodeInvocation.args;
			sharedEnv = claudeCodeInvocation.env;
		} else {
			const built = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task,
				sessionEnabled: shared.sessionEnabled,
				sessionDir: options.sessionDir,
				sessionFile: options.sessionFile,
				model,
				thinking: agent.thinking,
				systemPromptMode: agent.systemPromptMode,
				inheritProjectContext: agent.inheritProjectContext,
				inheritSkills: agent.inheritSkills,
				tools: agent.tools,
				allowSubagents: agent.allowSubagents,
				extensions: agent.extensions,
				systemPrompt: shared.systemPrompt,
				mcpDirectTools: agent.mcpDirectTools,
				cwd: options.cwd ?? runtimeCwd,
				intercomSessionName: options.intercomSessionName,
				orchestratorIntercomTarget: options.orchestratorIntercomTarget,
				runId: options.runId,
				childAgentName: agent.name,
				childIndex: options.index ?? 0,
				parentEventSink: options.nestedRoute?.eventSink,
				parentControlInbox: options.nestedRoute?.controlInbox,
				parentRootRunId: options.nestedRoute?.rootRunId,
				parentCapabilityToken: options.nestedRoute?.capabilityToken,
				structuredOutput: options.structuredOutput,
				projectTrust: options.projectTrust,
			});
			args = built.args;
			sharedEnv = built.env;
			tempDir = built.tempDir;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			agent: agent.name,
			task: shared.originalTask ?? task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			model: modelArg,
			error: message,
			terminalFailure: true,
			finalOutput: message,
			artifactPaths: shared.artifactPaths,
			skills: shared.resolvedSkillNames,
			skillsWarning: shared.skillsWarning,
		};
	}

	const result: AttemptResult = {
		agent: agent.name,
		task: shared.originalTask ?? task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		artifactPaths: shared.artifactPaths,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
	};
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	let interruptedByControl = false;
	const allControlEvents: ControlEvent[] = [];
	let pendingControlEvents: ControlEvent[] = [];
	const emittedControlEventKeys = new Set<string>();
	const emitControlEvent = (event: ControlEvent) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		options.onControlEvent?.(event);
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
	let observedCompletedMutation = false;

	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = claudeCodeInvocation
			? { command: claudeCodeInvocation.command, args: claudeCodeInvocation.args }
			: getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: options.cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		if (proc.pid && options.runId) saveQuestionContract(options.runId, options.index ?? 0, { pid: proc.pid, sessionFile: options.sessionFile, updatedAt: Date.now() });
		let buf = "";
		let processClosed = false;
		let settled = false;
		let detached = false;
		const blockingIntercomCalls = new Set<string>();
		const lifecycle = attachChildProcessLifecycle(proc);
		let assistantError: string | undefined;
		let timedOut = false;
		let resourceLimited = false;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let resourceLimitTimer: NodeJS.Timeout | undefined;
		let removeAbortListener: (() => void) | undefined;
		let removeInterruptListener: (() => void) | undefined;
		let activityTimer: NodeJS.Timeout | undefined;
		let unsubscribeIntercomDetach: (() => void) | undefined;

		const detachForIntercom = () => {
			detached = true;
			unsubscribeIntercomDetach?.();
			options.onIntercomDetach?.({
				...snapshotResult(result, { ...snapshotProgress(progress), status: "detached" }),
				detached: true,
				detachedReason: "intercom coordination",
				sessionFile: options.sessionFile,
				finalOutput: "Detached for intercom coordination.",
				progressSummary: { toolCount: progress.toolCount, tokens: progress.tokens, durationMs: Date.now() - startTime },
			});
		};

		let cleanTerminalAssistantStopReceived = false;

		unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (!options.allowIntercomDetach || detached || processClosed || lifecycle.stopping || blockingIntercomCalls.size === 0) return;
			if (!payload || typeof payload !== "object") return;
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string" || requestId.length === 0) return;
			options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
			detachForIntercom();
		});

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			if (resourceLimitTimer) {
				clearTimeout(resourceLimitTimer);
				resourceLimitTimer = undefined;
			}
			if (activityTimer) {
				clearInterval(activityTimer);
				activityTimer = undefined;
			}
			unsubscribeIntercomDetach?.();
			removeAbortListener?.();
			removeInterruptListener?.();
			resolve(code);
		};

		const drainPendingControlEvents = (): ControlEvent[] | undefined => {
			if (pendingControlEvents.length === 0) return undefined;
			const events = pendingControlEvents;
			pendingControlEvents = [];
			return events;
		};

		const mutationTracker = createMutationCompletionTracker();
		const subagentLoopGuard = createRepeatedSubagentCallGuardState();
		const mutatingFailures = createMutatingFailureState();
		const mutatingFailureWindowMs = 5 * 60_000;
		const currentToolDurationMs = (now: number) => progress.currentToolStartedAt ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
		const emitNeedsAttention = (now: number, input: { message?: string; reason?: ControlEvent["reason"]; recentFailureSummary?: string; currentTool?: string; currentPath?: string; currentToolDurationMs?: number } = {}): boolean => {
			if (!controlConfig.enabled) return false;
			const previous = progress.activityState;
			progress.activityState = "needs_attention";
			const event = buildControlEvent({
				type: "needs_attention",
				from: previous,
				to: "needs_attention",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				lastActivityAt: progress.lastActivityAt,
				message: input.message,
				reason: input.reason ?? "idle",
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: input.currentTool ?? progress.currentTool,
				currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
				currentPath: input.currentPath ?? progress.currentPath,
				recentFailureSummary: input.recentFailureSummary,
			});
			emitControlEvent(event);
			return previous !== "needs_attention";
		};
		const updateActivityState = (now: number): boolean => {
			if (!controlConfig.enabled) return false;
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: startTime,
				lastActivityAt: progress.lastActivityAt,
				now,
			});
			if (idleState === "needs_attention" && progress.activityState !== "needs_attention") return emitNeedsAttention(now);
			if (idleState !== "needs_attention" && progress.activityState === "needs_attention") {
				progress.activityState = undefined;
				emittedControlEventKeys.clear();
				return true;
			}
			return false;
		};


		const failForToolLoop = (message: string) => {
			if (processClosed || settled || timedOut || resourceLimited) return;
			resourceLimited = true;
			result.terminalFailure = true;
			result.error = message;
			result.finalOutput = message;
			progress.status = "failed";
			progress.durationMs = Date.now() - startTime;
			appendRecentOutput(progress, [message]);
			progress.activityState = undefined;
			fireUpdate();
			lifecycle.terminate();
		};

		const triggerResourceLimit = (kind: "maxExecutionTimeMs" | "maxTokens", limit: number, observed?: number) => {
			if (processClosed || settled || timedOut || resourceLimited) return;
			resourceLimited = true;
			const message = formatResourceLimitExceeded({ agent: agent.name, kind, limit, observed });
			result.resourceLimitExceeded = { kind, limit, ...(observed !== undefined ? { observed } : {}), message };
			result.error = message;
			result.finalOutput = message;
			progress.status = "failed";
			progress.durationMs = Date.now() - startTime;
			appendRecentOutput(progress, [message]);
			progress.activityState = undefined;
			fireUpdate();
			lifecycle.terminate();
		};

		const emitUpdateSnapshot = (text: string) => {
			if (!options.onUpdate || processClosed) return;
			const progressSnapshot = snapshotProgress(progress);
			const resultSnapshot = snapshotResult(result, progressSnapshot);
			const controlEvents = drainPendingControlEvents();
			options.onUpdate({
				content: [{ type: "text", text }],
				details: {
					mode: "single",
					results: [resultSnapshot],
					progress: [progressSnapshot],
					controlEvents,
				},
			});
		};

		const fireUpdate = () => {
			if (!options.onUpdate || processClosed) return;
			progress.durationMs = Date.now() - startTime;
			emitUpdateSnapshot(getFinalOutput(result.messages ?? []) || "(running...)");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let evt: { type?: string; message?: Message; toolCallId?: string; toolName?: string; args?: unknown; isError?: boolean };
			try {
				evt = JSON.parse(line) as typeof evt;
			} catch {
				// Non-JSON stdout lines are expected; only structured events are parsed.
				return;
			}
			if (!evt || typeof evt !== "object") return;
			lifecycle.observeEvent(claudeCodeInvocation && evt.type === "result" ? "agent_settled" : evt.type);
			if (evt.type === "agent_settled") blockingIntercomCalls.clear();
			if (claudeCodeInvocation && evt.type === "result") {
				const resultEvent = evt as ClaudeCodeResultEvent;
				if (options.structuredOutput && resultEvent.structured_output !== undefined) {
					mkdirSync(path.dirname(options.structuredOutput.outputPath), { recursive: true });
					writeFileSync(options.structuredOutput.outputPath, `${JSON.stringify(resultEvent.structured_output)}\n`, "utf-8");
				}
				const message = claudeCodeMessageFromResult(resultEvent, modelArg ?? claudeCodeInvocation.model.inputModel);
				if (options.sessionFile) {
					writeClaudeCodeSessionMetadata(options.sessionFile, {
						sessionId: resultEvent.session_id || claudeCodeInvocation.sessionId,
						model: claudeCodeInvocation.model.inputModel,
						cliModel: claudeCodeInvocation.model.cliModel,
						family: claudeCodeInvocation.model.family,
						context: claudeCodeInvocation.model.context,
						updatedAt: Date.now(),
					});
					appendClaudeCodeMessage(options.sessionFile, message);
				}
				evt = { type: "message_end", message };
			}

			const now = Date.now();
			progress.durationMs = now - startTime;
			progress.lastActivityAt = now;
			updateActivityState(now);

			if (evt.type === "tool_execution_start") {
				const loopFailure = recordToolStartForSubagentLoopGuard({
					state: subagentLoopGuard,
					toolCallId: evt.toolCallId,
					toolName: evt.toolName,
					args: evt.args,
				});
				if (loopFailure) {
					failForToolLoop(loopFailure);
					return;
				}
				const toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)
					? evt.args as Record<string, unknown>
					: {};
				if ((evt.toolName === "intercom" && toolArgs.action === "ask")
					|| (evt.toolName === "contact_supervisor" && (toolArgs.reason === "need_decision" || toolArgs.reason === "interview_request"))) {
					blockingIntercomCalls.add(evt.toolCallId ?? evt.toolName);
				}
				progress.toolCount++;
				progress.currentTool = evt.toolName;
				progress.currentToolArgs = extractToolArgsPreview(toolArgs);
				progress.currentToolStartedAt = now;
				progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
				mutationTracker.recordToolStart({ toolName: evt.toolName, args: toolArgs, path: progress.currentPath, startedAt: now });
				fireUpdate();
			}

			if (evt.type === "tool_execution_end") {
				blockingIntercomCalls.delete(evt.toolCallId ?? evt.toolName ?? "");
				if (progress.currentTool) {
					progress.recentTools.push({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.currentPath = undefined;
				fireUpdate();
				const loopFailure = recordToolEndForSubagentLoopGuard({
					state: subagentLoopGuard,
					toolCallId: evt.toolCallId,
					toolName: evt.toolName,
					isError: evt.isError,
				});
				if (loopFailure) {
					failForToolLoop(loopFailure);
					return;
				}
			}

			if (evt.type === "message_end" && evt.message) {
				(result.messages ??= []).push(evt.message);
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					progress.turnCount = result.usage.turns;
					const u = evt.message.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						progress.tokens = result.usage.input + result.usage.output;
						if (options.maxTokens !== undefined && progress.tokens >= options.maxTokens) {
							triggerResourceLimit("maxTokens", options.maxTokens, progress.tokens);
						}
					}
					if (!result.model) result.model = providerQualifiedModelId(evt.message.provider, evt.message.model);
					if (evt.message.errorMessage) assistantError = evt.message.errorMessage;
					const assistantText = extractTextFromContent(evt.message.content);
					appendRecentOutput(progress, assistantText.split("\n").slice(-10));
					const stopReason = (evt.message as { stopReason?: string }).stopReason;
					const hasToolCall = Array.isArray(evt.message.content)
						&& evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
					cleanTerminalAssistantStopReceived = stopReason === "stop" && !hasToolCall && !evt.message.errorMessage;
					if (cleanTerminalAssistantStopReceived && assistantText.trim()) assistantError = undefined;
				} else if (evt.message.role === "toolResult") {
					const resultText = extractTextFromContent(evt.message.content);
					appendRecentOutput(progress, resultText.split("\n").slice(-10));
					const toolSnapshot = mutationTracker.recordToolResult(evt.message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown });
					if (toolSnapshot?.completedMutation) observedCompletedMutation = true;
					if (toolSnapshot?.mutates && toolSnapshot.errored) {
						recordMutatingFailure(mutatingFailures, {
							tool: toolSnapshot.tool,
							path: toolSnapshot.path,
							error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
							ts: now,
						}, mutatingFailureWindowMs);
						if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) {
							emitNeedsAttention(now, {
								message: `${agent.name} needs attention after repeated mutating tool failures`,
								reason: "tool_failures",
								currentTool: toolSnapshot.tool,
								currentPath: toolSnapshot.path,
								currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
								recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
							});
						}
					} else if (toolSnapshot?.mutates) {
						resetMutatingFailureState(mutatingFailures);
					}
				}
				updateActivityState(now);
				fireUpdate();
			}
		};

		if (controlConfig.enabled) {
			activityTimer = setInterval(() => {
				if (processClosed || settled) return;
				const now = Date.now();
				if (updateActivityState(now)) {
					progress.durationMs = now - startTime;
					fireUpdate();
				}
			}, 1000);
			activityTimer.unref?.();
		}

		let stderrBuf = "";

		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("close", (code, signal) => {
			cleanupTempDir(tempDir);
			processClosed = true;
			if (buf.trim()) processLine(buf);
			if (!result.error && assistantError) result.error = assistantError;
			const forcedDrainAfterFinalSuccess = lifecycle.settledCleanup && cleanTerminalAssistantStopReceived && !result.error;
			if (code !== 0 && stderrBuf.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
				result.error = stderrBuf.trim();
			}
			const finalCode = forcedDrainAfterFinalSuccess ? 0 : lifecycle.stopping || signal ? (code ?? 1) : (code ?? 0);
			finish(finalCode);
		});
		proc.on("error", (error) => {
			cleanupTempDir(tempDir);
			if (!result.error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
			finish(1);
		});

		if (options.signal) {
			const kill = () => {
				if (processClosed) return;
				interruptedByControl = false;
				result.interrupted = false;
				result.error = "Subagent cancelled.";
				lifecycle.terminate();
			};
			if (options.signal.aborted) kill();
			else {
				options.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
			}
		}

		let timeoutDeadline = options.timeoutAt;
		const triggerTimeout = () => {
			if (processClosed || settled || timedOut || resourceLimited) return;
			timedOut = true;
			const message = formatForegroundTimeoutMessage(options.timeoutMs);
			result.timedOut = true;
			result.error = message;
			result.finalOutput = message;
			progress.status = "failed";
			progress.durationMs = Date.now() - startTime;
			appendRecentOutput(progress, [message]);
			progress.activityState = undefined;
			fireUpdate();
			lifecycle.terminate();
		};
		const scheduleTimeout = () => {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			if (timeoutDeadline === undefined) return;
			const delay = timeoutDeadline - Date.now();
			if (delay <= 0) triggerTimeout();
			else {
				timeoutTimer = setTimeout(triggerTimeout, delay);
				timeoutTimer.unref?.();
			}
		};
		options.registerTimeoutExtension?.((additionalMs: number) => {
			if (!Number.isFinite(additionalMs) || additionalMs <= 0) return { ok: false, message: "additionalMs must be a positive number." };
			if (timeoutDeadline === undefined) return { ok: false, message: "This foreground run does not have a timeout to extend." };
			if (settled || processClosed || detached) return { ok: false, message: "This foreground run is no longer active." };
			if (timedOut) return { ok: false, message: "This foreground run has already timed out; use action='resume' with a follow-up message." };
			timeoutDeadline = Math.max(timeoutDeadline, Date.now()) + additionalMs;
			scheduleTimeout();
			return { ok: true, timeoutAt: timeoutDeadline, message: `Extended timeout until ${new Date(timeoutDeadline).toISOString()}.` };
		});
		if (timeoutDeadline !== undefined) scheduleTimeout();

		if (options.maxExecutionTimeMs !== undefined) {
			const maxExecutionTimeMs = options.maxExecutionTimeMs;
			resourceLimitTimer = setTimeout(() => {
				triggerResourceLimit("maxExecutionTimeMs", maxExecutionTimeMs);
			}, maxExecutionTimeMs);
			resourceLimitTimer.unref?.();
		}

		if (options.interruptSignal) {
			const interrupt = () => {
				if (options.signal?.aborted || processClosed || settled || timedOut || resourceLimited) return;
				interruptedByControl = true;
				progress.status = "running";
				progress.durationMs = Date.now() - startTime;
				result.interrupted = true;
				result.finalOutput = "Interrupted. Waiting for explicit next action.";
				progress.activityState = undefined;
				fireUpdate();
				lifecycle.terminate();
			};
			if (options.interruptSignal.aborted) interrupt();
			else {
				options.interruptSignal.addEventListener("abort", interrupt, { once: true });
				removeInterruptListener = () => options.interruptSignal?.removeEventListener("abort", interrupt);
			}
		}
	});
	result.exitCode = exitCode;
	if (result.resourceLimitExceeded) {
		result.exitCode = 1;
		result.error = result.error ?? result.resourceLimitExceeded.message;
		result.finalOutput = result.finalOutput || result.error;
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.activityState = undefined;
			result.progress.durationMs = Date.now() - startTime;
		}
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: result.progress?.durationMs ?? Date.now() - startTime,
		};
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		return result;
	}
	if (result.timedOut) {
		result.exitCode = FOREGROUND_TIMEOUT_EXIT_CODE;
		result.error = result.error ?? formatForegroundTimeoutMessage(options.timeoutMs);
		result.finalOutput = formatTimeoutOutput(result.error, result, result.progress ?? progress);
		artifactOutputByResult.set(result, result.finalOutput);
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.activityState = undefined;
			result.progress.durationMs = Date.now() - startTime;
		}
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: result.progress?.durationMs ?? Date.now() - startTime,
		};
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		return result;
	}
	if (interruptedByControl) {
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}

	return finalizeCompletedAttempt();

	function finalizeCompletedAttempt(): AttemptResult {
	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages ?? []);
		if (errInfo.hasError) {
			result.terminalFailure = true;
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		const structured = readStructuredOutput({
			schema: options.structuredOutput.schema,
			schemaPath: options.structuredOutput.schemaPath,
			outputPath: options.structuredOutput.outputPath,
		});
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (structured.error) {
			result.terminalFailure = true;
			result.exitCode = 1;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
		}
	}

	if (result.exitCode !== 0 && !result.error && !result.finalOutput) {
		result.error = formatProcessExitFailure({ agent: agent.name, exitCode: result.exitCode, durationMs: Date.now() - startTime });
		result.finalOutput = result.error;
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.activityState = undefined;
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	const acceptanceOutput = getFinalOutput(result.messages ?? []);
	let fullOutput = shared.previousOutput === undefined
		? stripAcceptanceReport(acceptanceOutput)
		: resolveFinalizationOutput(acceptanceOutput, shared.previousOutput);
	const completionGuardTriggered = result.exitCode === 0 && !result.error
		&& shared.completionPolicy === "mutation-guard"
		&& !observedCompletedMutation && !hasCompletedMutationToolCall(result.messages ?? []);
	if (completionGuardTriggered) {
		result.terminalFailure = true;
		result.exitCode = 1;
		result.error = "Subagent completed without making edits required by completionGuard: true.\nUse an acceptance contract when a valid no-op is allowed.";
		progress.status = "failed";
		progress.error = result.error;
		emitControlEvent(buildControlEvent({
			from: progress.activityState,
			to: "needs_attention",
			runId: options.runId ?? agent.name,
			agent: agent.name,
			index: options.index,
			ts: Date.now(),
			message: `${agent.name} completed without making edits required by completionGuard: true`,
			reason: "completion_guard",
		}));
	}
	if (options.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
		fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.saveError) {
			result.terminalFailure = true;
			result.exitCode = 1;
			result.error = `Failed to save output file '${options.outputPath}': ${resolvedOutput.saveError}`;
			progress.status = "failed";
			progress.error = result.error;
		}
		if (resolvedOutput.savedPath) {
			result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
		}
	}
	artifactOutputByResult.set(result, fullOutput);
	acceptanceOutputByResult.set(result, acceptanceOutput);
	result.outputMode = options.outputMode ?? "inline";
	result.finalOutput = options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
		? result.outputReference.message
		: fullOutput;
	result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
	return result;
	}
}

function publishFinalResult(result: SingleResult, options: RunSyncOptions): void {
	const fullOutput = artifactOutputByResult.get(result) ?? result.finalOutput ?? "";
	if (result.savedOutputPath && result.exitCode === 0 && !result.interrupted) {
		const cleanup = options.persistOutputFile || options.outputMode === "file-only"
			? undefined
			: cleanupSingleOutputFile(result.savedOutputPath, fullOutput, undefined);
		result.outputCleanup = cleanup;
		result.outputReference = cleanup
			? formatConsumedOutputReference(result.savedOutputPath, fullOutput, cleanup)
			: formatSavedOutputReference(result.savedOutputPath, fullOutput);
		if (cleanup && cleanup.action !== "skipped") result.savedOutputPath = undefined;
		if (options.outputMode === "file-only") result.finalOutput = result.outputReference.message;
	}
	if (result.progress) {
		result.progress.status = result.interrupted ? "paused" : result.exitCode === 0 ? "completed" : "failed";
		result.progress.error = result.error;
		result.progress.tokens = result.usage.input + result.usage.output;
		result.progress.turnCount = result.usage.turns;
		result.progress.toolCount = result.progressSummary?.toolCount ?? result.progress.toolCount;
		result.progress.durationMs = result.progressSummary?.durationMs ?? result.progress.durationMs;
	}
	if (result.artifactPaths) {
		writeArtifact(result.artifactPaths.outputPath, fullOutput);
		writeMetadata(result.artifactPaths.metadataPath, {
			runId: options.runId,
			agent: result.agent,
			task: result.task,
			exitCode: result.exitCode,
			interrupted: result.interrupted,
			timedOut: result.timedOut,
			resourceLimitExceeded: result.resourceLimitExceeded,
			usage: result.usage,
			model: result.model,
			attemptedModels: result.attemptedModels,
			modelAttempts: result.modelAttempts,
			durationMs: result.progressSummary?.durationMs,
			toolCount: result.progressSummary?.toolCount,
			error: result.error,
			skills: result.skills,
			skillsWarning: result.skillsWarning,
			acceptance: result.acceptance,
			initialOutput: result.initialOutput,
			timestamp: Date.now(),
		});
	}
	const truncation = truncateOutput(result.finalOutput ?? "", { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput }, result.artifactPaths?.outputPath);
	result.truncation = truncation.truncated ? truncation : undefined;
	const progress = result.progress ? snapshotProgress(result.progress) : undefined;
	options.onUpdate?.({
		content: [{ type: "text", text: result.finalOutput || result.error || "(no output)" }],
		details: {
			mode: "single",
			results: [progress ? snapshotResult(result, progress) : { ...result }],
			progress: progress ? [progress] : undefined,
			controlEvents: result.controlEvents,
		},
	});
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	let detached = false;
	const question = Promise.withResolvers<SingleResult>();
	const completion = runToCompletion(runtimeCwd, agents, agentName, task, {
		...options,
		onUpdate: (update) => { if (!detached) options.onUpdate?.(update); },
		onIntercomDetach: (result) => {
			if (detached) return;
			detached = true;
			question.resolve(result);
		},
	}).catch((error): SingleResult => {
		if (!detached) throw error;
		return { agent: agentName, task, exitCode: 1, usage: emptyUsage(), sessionFile: options.sessionFile, error: `Detached run failed: ${error instanceof Error ? error.message : String(error)}` };
	}).finally(() => options.onRunSettled?.()).then(async (result) => {
		if (detached) {
			try { await options.onDetachedComplete?.(result); } catch (error) {
				console.error("Failed to deliver detached foreground completion:", error);
			}
		}
		return result;
	});
	return Promise.race([completion, question.promise]);
}

async function runToCompletion(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: AttemptOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		};
	}
	const timeoutAt = options.timeoutAt ?? (options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined);
	if (timeoutAt !== undefined && Date.now() >= timeoutAt) return createTimedOutResult(agentName, task, options);
	const effectiveOptions: AttemptOptions = {
		...options,
		timeoutAt,
		maxExecutionTimeMs: options.maxExecutionTimeMs ?? agent.maxExecutionTimeMs,
		maxTokens: options.maxTokens ?? agent.maxTokens,
	};

	if (options.registerTimeoutExtension) {
		effectiveOptions.registerTimeoutExtension = (extend) => options.registerTimeoutExtension?.((additionalMs) => {
			const result = extend(additionalMs);
			if (result.ok) effectiveOptions.timeoutAt = result.timeoutAt;
			return result;
		});
	}

	const shareEnabled = effectiveOptions.share === true;
	const effectiveAcceptance = resolveEffectiveAcceptance({ explicit: options.acceptance });
	if (effectiveOptions.runId) saveQuestionContract(effectiveOptions.runId, effectiveOptions.index ?? 0, { effectiveAcceptance, output: effectiveOptions.outputPath ?? false, outputMode: effectiveOptions.outputMode, outputSchema: effectiveOptions.structuredOutput?.schema });
	if (shouldRunAcceptanceFinalization(effectiveAcceptance) && !options.sessionFile) {
		const sessionDir = options.sessionDir ?? mkdtempSync(path.join(os.tmpdir(), "pi-subagent-finalization-"));
		options.sessionFile = path.join(sessionDir, "session.jsonl");
		effectiveOptions.sessionDir = sessionDir;
		effectiveOptions.sessionFile = options.sessionFile;
	}
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance);
	const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd, { projectTrusted: options.projectTrusted ?? true });
	if (skillNames.some((skill) => skill.trim() === "pi-subagents") && missingSkills.includes("pi-subagents")) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		};
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
	);
	saveForegroundLaunch(agent, systemPrompt, resolvedSkills.map((skill) => skill.name), candidates, effectiveOptions, runtimeCwd);
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	if (effectiveOptions.artifactsDir) {
		artifactPathsResult = getArtifactPaths(effectiveOptions.artifactsDir, effectiveOptions.runId, agentName, effectiveOptions.index);
		ensureArtifactsDir(effectiveOptions.artifactsDir);
		writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${taskWithAcceptance}`);
	}

	const { result, modelAttempts, attemptedModels, notes: attemptNotes, usage: aggregateUsage } = await runModelAttempts({
		candidates,
		signal: AbortSignal.any([options.signal, options.interruptSignal].filter((signal) => signal !== undefined)),
		runAttempt: async (candidate, notes) => {
			const attempt = await runSingleAttempt(runtimeCwd, agent, taskWithAcceptance, candidate, effectiveOptions, {
				sessionEnabled,
				systemPrompt,
				resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
				skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
				artifactPaths: artifactPathsResult,
				attemptNotes: notes,
				outputSnapshot: captureSingleOutputSnapshot(effectiveOptions.outputPath),
				originalTask: task,
				completionPolicy: resolveCompletionPolicy({
					completionGuardEnabled: agent.completionGuard === true,
					usesAcceptanceContract: effectiveAcceptance.explicit,
				}),
			});
			totalToolCount += attempt.progressSummary?.toolCount ?? 0;
			totalDurationMs += attempt.progressSummary?.durationMs ?? 0;
			return attempt;
		},
	});

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	appendPreviousAttemptContext(result, modelAttempts);
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	result.artifactPaths = artifactPathsResult;

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	const initialOutput = artifactOutputByResult.get(result) ?? result.finalOutput ?? "";
	result.acceptance = await evaluateRunAcceptance({
		acceptance: effectiveAcceptance,
		initial: result,
		initialOutput: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
		sessionFile: result.sessionFile ?? effectiveOptions.sessionFile,
		cwd: options.cwd ?? runtimeCwd,
		signal: AbortSignal.any([options.signal, options.interruptSignal].filter((signal) => signal !== undefined)),
		runTurn: async (prompt, _turn, sessionFile) => {
			const finalizationOptions: AttemptOptions = { ...effectiveOptions, sessionFile, outputMode: "inline" };
			delete finalizationOptions.sessionDir;
			delete finalizationOptions.structuredOutput;
			const reviewed = await runSingleAttempt(runtimeCwd, agent, prompt, result.model, finalizationOptions, {
				sessionEnabled: true,
				systemPrompt,
				resolvedSkillNames: result.skills,
				skillsWarning: result.skillsWarning,
				attemptNotes: [],
				originalTask: prompt,
				completionPolicy: "acceptance-contract",
				previousOutput: artifactOutputByResult.get(result) ?? result.finalOutput,
			});
			modelAttempts.push({ model: reviewed.model ?? result.model ?? "default", success: reviewed.exitCode === 0 && !reviewed.error && !reviewed.interrupted,
				exitCode: reviewed.exitCode, error: reviewed.error, usage: { ...reviewed.usage } });
			result.usage = sumAttemptUsage(modelAttempts);
			result.progressSummary = {
				toolCount: (result.progressSummary?.toolCount ?? 0) + (reviewed.progressSummary?.toolCount ?? 0),
				tokens: result.usage.input + result.usage.output,
				durationMs: (result.progressSummary?.durationMs ?? 0) + (reviewed.progressSummary?.durationMs ?? 0),
			};
			if (reviewed.controlEvents?.length) result.controlEvents = [...(result.controlEvents ?? []), ...reviewed.controlEvents];
			result.messages = [...(result.messages ?? []), ...(reviewed.messages ?? [])];
			const output = acceptanceOutputByResult.get(reviewed) ?? getFinalOutput(reviewed.messages ?? []) ?? reviewed.finalOutput ?? "";
			if (reviewed.exitCode !== 0 || reviewed.error || reviewed.detached || reviewed.interrupted) {
				result.interrupted = reviewed.interrupted;
				result.timedOut = reviewed.timedOut;
				result.resourceLimitExceeded = reviewed.resourceLimitExceeded;
				result.exitCode = reviewed.exitCode;
				result.error = reviewed.error;
				return { output, error: reviewed.error ?? "Acceptance finalization turn did not complete successfully." };
			}
			result.finalOutput = reviewed.finalOutput;
			result.savedOutputPath = reviewed.savedOutputPath;
			result.outputReference = reviewed.outputReference;
			result.outputSaveError = reviewed.outputSaveError;
			artifactOutputByResult.set(result, artifactOutputByResult.get(reviewed) ?? reviewed.finalOutput ?? "");
			return { output };
		},
	});
	if (result.acceptance.finalization) result.initialOutput = initialOutput;
	Object.assign(result, resolveExecutionOutcome({ result, acceptance: result.acceptance, signal: options.signal, interruptSignal: options.interruptSignal }));
	stripAcceptanceReportsFromMessages(result.messages ?? []);
	delete result.terminalFailure;
	refreshQuestionLaunch(effectiveOptions.runId, effectiveOptions.index ?? 0, result.sessionFile);
	publishFinalResult(result, effectiveOptions);
	return result;
}
