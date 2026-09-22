/**
 * Core execution logic for running subagents
 */

import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
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
	compactForegroundResult,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { hasCompletedMutationToolCall, resolveCompletionPolicy, type CompletionPolicy } from "../shared/completion-guard.ts";
import { buildChildInvocation, runChildAttempt, type ChildAttemptControl } from "../shared/child-attempt.ts";
import { pendingSupervisorQuestion, refreshQuestionLaunch, saveQuestionContract } from "../shared/supervisor-questions.ts";
import { updateStreamingText } from "../shared/streaming-text.ts";
import { saveForegroundLaunch } from "../shared/run-records.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { applyThinkingSuffix, cleanupTempDir } from "../shared/pi-args.ts";
import {
	isClaudeCodeModel,
	type ClaudeCodeInvocation,
} from "../shared/claude-code.ts";
import { readStructuredOutput, type StructuredOutputRuntime } from "../shared/structured-output.ts";
import { captureSingleOutputSnapshot, cleanupSingleOutputFile, formatConsumedOutputReference, formatSavedOutputReference, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	runModelAttempts,
	sumAttemptUsage,
} from "../shared/model-fallback.ts";
import {
	createMutatingFailureState,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/mutating-tool-guard.ts";
import {
	evaluateRunAcceptance,
	createFinalizationReportRuntime,
	readFinalizationReport,
	formatUnconfirmedFinalizationOutput,
	resolveExecutionOutcome,
	resolveFinalizationOutput,
	formatAcceptancePrompt,
	resolveEffectiveAcceptance,
	shouldRunAcceptanceFinalization,
	stripAcceptanceReport,
} from "../shared/acceptance.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();
const finalizationReportByResult = new WeakMap<SingleResult, ReturnType<typeof readFinalizationReport>>();
const writtenOutputSnapshotByResult = new WeakMap<SingleResult, SingleOutputSnapshot>();

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
		usage: { ...result.usage, contributions: result.usage.contributions?.slice() },
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
		reportRuntime?: StructuredOutputRuntime;
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
		const built = buildChildInvocation({
			task, sessionEnabled: shared.sessionEnabled, sessionDir: options.sessionDir, sessionFile: options.sessionFile,
			model, thinking: agent.thinking, systemPromptMode: agent.systemPromptMode,
			inheritProjectContext: agent.inheritProjectContext, inheritSkills: agent.inheritSkills,
			tools: agent.tools, allowSubagents: agent.allowSubagents, extensions: agent.extensions,
			systemPrompt: shared.systemPrompt, mcpDirectTools: agent.mcpDirectTools,
			cwd: options.cwd ?? runtimeCwd, intercomSessionName: options.intercomSessionName,
			orchestratorIntercomTarget: options.orchestratorIntercomTarget, rootSessionId: options.rootSessionId,
			runId: options.runId, childAgentName: agent.name, childIndex: options.index ?? 0,
			parentEventSink: options.nestedRoute?.eventSink, parentControlInbox: options.nestedRoute?.controlInbox,
			parentRootRunId: options.nestedRoute?.rootRunId, parentCapabilityToken: options.nestedRoute?.capabilityToken,
			structuredOutput: shared.reportRuntime ?? options.structuredOutput, projectTrust: options.projectTrust,
		});
		args = built.args;
		sharedEnv = built.env;
		tempDir = built.tempDir;
		claudeCodeInvocation = built.claudeCodeInvocation;
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
		model: modelArg,
		thinking: resolveEffectiveThinking(modelArg, agent.thinking),
		modelStartedAt: startTime,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	let observedCompletedMutation = false;
	let processClosed = false;
	let detached = false;
	let control: ChildAttemptControl | undefined;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	const blockingIntercomCalls = new Set<string>();
	const mutatingFailures = createMutatingFailureState();
	const mutatingFailureWindowMs = 5 * 60_000;
	const fireUpdate = () => {
		if (!options.onUpdate || processClosed) return;
		progress.durationMs = Date.now() - startTime;
		const progressSnapshot = snapshotProgress(progress);
		const controlEvents = pendingControlEvents.length ? pendingControlEvents : undefined;
		pendingControlEvents = [];
		options.onUpdate({
			content: [{ type: "text", text: getFinalOutput(result.messages ?? []) || "(running...)" }],
			details: { mode: "single", results: [snapshotResult(result, progressSnapshot)], progress: [progressSnapshot], controlEvents },
		});
	};
	const emitNeedsAttention = (now: number, input: { message?: string; reason?: ControlEvent["reason"]; recentFailureSummary?: string; currentTool?: string; currentPath?: string; currentToolDurationMs?: number } = {}): boolean => {
		if (!controlConfig.enabled) return false;
		const previous = progress.activityState;
		progress.activityState = "needs_attention";
		emitControlEvent(buildControlEvent({
			type: "needs_attention", from: previous, to: "needs_attention", runId: options.runId, agent: agent.name, index: options.index,
			ts: now, lastActivityAt: progress.lastActivityAt, message: input.message, reason: input.reason ?? "idle",
			turns: result.usage.turns, tokens: progress.tokens, toolCount: progress.toolCount,
			currentTool: input.currentTool ?? progress.currentTool,
			currentToolDurationMs: input.currentToolDurationMs ?? (progress.currentToolStartedAt !== undefined ? Math.max(0, now - progress.currentToolStartedAt) : undefined),
			currentPath: input.currentPath ?? progress.currentPath, recentFailureSummary: input.recentFailureSummary,
			supervisorQuestion: input.reason === undefined || input.reason === "idle"
				? pendingSupervisorQuestion({ runId: options.runId, agent: agent.name, index: options.index ?? 0, sessionFile: options.sessionFile, pid: control?.pid }) : undefined,
		}));
		return previous !== "needs_attention";
	};
	const updateActivityState = (now: number): boolean => {
		if (!controlConfig.enabled) return false;
		const idleState = deriveActivityState({ config: controlConfig, startedAt: startTime, lastActivityAt: progress.lastActivityAt, now });
		if (idleState === "needs_attention" && progress.activityState !== "needs_attention") return emitNeedsAttention(now);
		if (idleState !== "needs_attention" && progress.activityState === "needs_attention") {
			progress.activityState = undefined;
			emittedControlEventKeys.clear();
			return true;
		}
		return false;
	};
	const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
		if (!options.allowIntercomDetach || detached || processClosed || !control || control.stopping) return;
		if (!payload || typeof payload !== "object" || (payload as { reason?: unknown }).reason === "attention" || blockingIntercomCalls.size === 0) return;
		const requestId = (payload as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string" || !requestId) return;
		options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
		detached = true;
		options.onIntercomDetach?.({
			...snapshotResult(result, { ...snapshotProgress(progress), status: "detached" }),
			detached: true, detachedReason: "intercom coordination", sessionFile: options.sessionFile,
			finalOutput: "Detached for intercom coordination.",
			progressSummary: { toolCount: progress.toolCount, tokens: progress.tokens, durationMs: Date.now() - startTime },
		});
	});
	let timeoutDeadline = options.timeoutAt;
	const scheduleTimeout = () => {
		clearTimeout(timeoutTimer);
		if (timeoutDeadline === undefined) return;
		const expire = () => control?.stop({ error: formatForegroundTimeoutMessage(options.timeoutMs), timedOut: true });
		if (timeoutDeadline <= Date.now()) expire();
		else { timeoutTimer = setTimeout(expire, timeoutDeadline - Date.now()); timeoutTimer.unref(); }
	};
	options.registerTimeoutExtension?.((additionalMs) => {
		if (!Number.isFinite(additionalMs) || additionalMs <= 0) return { ok: false, message: "additionalMs must be a positive number." };
		if (timeoutDeadline === undefined) return { ok: false, message: "This foreground run does not have a timeout to extend." };
		if (processClosed || detached) return { ok: false, message: "This foreground run is no longer active." };
		if (result.timedOut) return { ok: false, message: "This foreground run has already timed out; use action='resume' with a follow-up message." };
		timeoutDeadline = Math.max(timeoutDeadline, Date.now()) + additionalMs;
		scheduleTimeout();
		return { ok: true, timeoutAt: timeoutDeadline, message: `Extended timeout until ${new Date(timeoutDeadline).toISOString()}.` };
	});
	if (controlConfig.enabled) {
		activityTimer = setInterval(() => { if (updateActivityState(Date.now())) fireUpdate(); }, 1000);
		activityTimer.unref();
	}
	fireUpdate();
	try {
		const attempt = await runChildAttempt({
			args, cwd: options.cwd ?? runtimeCwd, env: sharedEnv, agent: agent.name, model: modelArg,
			maxSubagentDepth: options.maxSubagentDepth, maxExecutionTimeMs: options.maxExecutionTimeMs, maxTokens: options.maxTokens,
			claudeCodeInvocation, sessionFile: options.sessionFile, structuredOutput: options.structuredOutput, reportRuntime: shared.reportRuntime,
			signal: options.signal, interruptSignal: options.interruptSignal,
			onStart: (handle, state) => {
				control = handle;
				result.messages = state.messages;
				result.usage = state.usage;
				if (handle.pid && options.runId) saveQuestionContract(options.runId, options.index ?? 0, { pid: handle.pid, sessionFile: options.sessionFile, updatedAt: Date.now(),
					modelSelection: { model: progress.model, thinking: progress.thinking, modelStartedAt: startTime } });
				scheduleTimeout();
			},
			onFailure: (state) => {
				result.error = state.error;
				result.finalOutput = state.error ?? "Interrupted. Waiting for explicit next action.";
				result.timedOut = state.timedOut;
				result.interrupted = state.interrupted;
				result.resourceLimitExceeded = state.resourceLimitExceeded;
				result.terminalFailure = state.terminalFailure;
				progress.status = state.interrupted ? "running" : "failed";
				progress.activityState = undefined;
				if (state.error) appendRecentOutput(progress, [state.error]);
				fireUpdate();
			},
			onEvent: (event, state, mutation) => {
				const now = Date.now();
				progress.lastActivityAt = now;
				progress.tokens = state.usage.input + state.usage.output;
				progress.turnCount = state.usage.turns;
				result.model = state.model;
				updateActivityState(now);
				const text = updateStreamingText(progress.streamingText, event);
				if (text !== progress.streamingText) { progress.streamingText = text; fireUpdate(); }
				if (event.type === "agent_settled") blockingIntercomCalls.clear();
				if (event.type === "tool_execution_start") {
					const args = event.args ?? {};
					if ((event.toolName === "intercom" && args.action === "ask") || (event.toolName === "contact_supervisor" && (args.reason === "need_decision" || args.reason === "interview_request"))) {
						blockingIntercomCalls.add(event.toolCallId ?? event.toolName);
					}
					progress.toolCount++;
					progress.currentTool = event.toolName;
					progress.currentToolArgs = extractToolArgsPreview(args);
					progress.currentToolStartedAt = now;
					progress.currentPath = resolveCurrentPath(event.toolName, args);
					fireUpdate();
				} else if (event.type === "tool_execution_end") {
					blockingIntercomCalls.delete(event.toolCallId ?? event.toolName ?? "");
					if (progress.currentTool) progress.recentTools.push({ tool: progress.currentTool, args: progress.currentToolArgs || "", endMs: now });
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					progress.currentToolStartedAt = undefined;
					progress.currentPath = undefined;
					fireUpdate();
				} else if (event.type === "message_end" && event.message) {
					const messageText = extractTextFromContent(event.message.content);
					appendRecentOutput(progress, messageText.split("\n").slice(-10));
					if (mutation?.mutates && mutation.errored) {
						recordMutatingFailure(mutatingFailures, { tool: mutation.tool, path: mutation.path,
							error: messageText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed", ts: now }, mutatingFailureWindowMs);
						if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) emitNeedsAttention(now, {
							message: `${agent.name} needs attention after repeated mutating tool failures`, reason: "tool_failures",
							currentTool: mutation.tool, currentPath: mutation.path,
							currentToolDurationMs: mutation.startedAt ? Math.max(0, now - mutation.startedAt) : undefined,
							recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
						});
					} else if (mutation?.mutates) resetMutatingFailureState(mutatingFailures);
					updateActivityState(now);
					fireUpdate();
				}
			},
		});
		result.exitCode = attempt.exitCode;
		result.agentProcessExit = attempt.agentProcessExit;
		result.messages = attempt.messages;
		result.usage = attempt.usage;
		result.error = attempt.error;
		result.timedOut = attempt.timedOut;
		result.interrupted = attempt.interrupted;
		result.resourceLimitExceeded = attempt.resourceLimitExceeded;
		result.terminalFailure = attempt.terminalFailure;
		interruptedByControl = attempt.interrupted === true;
		observedCompletedMutation = attempt.observedCompletedMutation;
	} finally {
		processClosed = true;
		clearTimeout(timeoutTimer);
		clearInterval(activityTimer);
		unsubscribeIntercomDetach?.();
		cleanupTempDir(tempDir);
	}
	if (shared.reportRuntime) finalizationReportByResult.set(result, readFinalizationReport(result.messages ?? [], shared.reportRuntime));
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
	const submission = finalizationReportByResult.get(result);
	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	if (result.exitCode === 0 && !result.error && !submission?.output) {
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

	const acceptanceOutput = submission?.output ?? getFinalOutput(result.messages ?? []);
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
	if (options.outputPath && result.exitCode === 0 && !submission?.reportSubmissionError) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
		fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.writtenSnapshot) writtenOutputSnapshotByResult.set(result, resolvedOutput.writtenSnapshot);
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
		result.progress.status = result.interrupted ? "paused" : result.exitCode === 0 ? result.acceptance?.status === "blocked" ? "blocked" : "completed" : "failed";
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
			agentProcessExit: result.agentProcessExit,
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
		if (options.runId) saveQuestionContract(options.runId, options.index ?? 0, { result: compactForegroundResult(result), updatedAt: Date.now() });
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
	const configuredAgent = agents.find((a) => a.name === agentName);
	if (!configuredAgent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}
	const agent = options.inheritSkills === undefined
		? configuredAgent
		: { ...configuredAgent, inheritSkills: options.inheritSkills };
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
	saveForegroundLaunch(agent, task, systemPrompt, resolvedSkills.map((skill) => skill.name), candidates, effectiveOptions, runtimeCwd);
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
	const nativeReport = !result.model || !isClaudeCodeModel(result.model);
	result.acceptance = await evaluateRunAcceptance({
		acceptance: effectiveAcceptance,
		initial: result,
		nativeReport,
		initialOutput: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
		sessionFile: result.sessionFile ?? effectiveOptions.sessionFile,
		cwd: options.cwd ?? runtimeCwd,
		signal: AbortSignal.any([options.signal, options.interruptSignal].filter((signal) => signal !== undefined)),
		runTurn: async (prompt, _turn, sessionFile) => {
			const finalizationOptions: AttemptOptions = { ...effectiveOptions, sessionFile, outputMode: "inline" };
			delete finalizationOptions.sessionDir;
			delete finalizationOptions.structuredOutput;
			const reportRuntime = nativeReport ? createFinalizationReportRuntime() : undefined;
			let reviewed: AttemptResult;
			try {
				reviewed = await runSingleAttempt(runtimeCwd, agent, prompt, result.model, finalizationOptions, {
					sessionEnabled: true,
					systemPrompt,
					resolvedSkillNames: result.skills,
					skillsWarning: result.skillsWarning,
					attemptNotes: [],
					originalTask: prompt,
					completionPolicy: "acceptance-contract",
					previousOutput: artifactOutputByResult.get(result) ?? result.finalOutput,
					reportRuntime,
					outputSnapshot: nativeReport ? writtenOutputSnapshotByResult.get(result) : undefined,
				});
			} finally {
				if (reportRuntime) cleanupTempDir(path.dirname(reportRuntime.schemaPath));
			}
			modelAttempts.push({ model: reviewed.model ?? result.model ?? "default", success: reviewed.exitCode === 0 && !reviewed.error && !reviewed.interrupted,
				exitCode: reviewed.exitCode, error: reviewed.error, usage: { ...reviewed.usage } });
			result.usage = sumAttemptUsage(modelAttempts);
			result.agentProcessExit = reviewed.agentProcessExit ?? result.agentProcessExit;
			result.progressSummary = {
				toolCount: (result.progressSummary?.toolCount ?? 0) + (reviewed.progressSummary?.toolCount ?? 0),
				tokens: result.usage.input + result.usage.output,
				durationMs: (result.progressSummary?.durationMs ?? 0) + (reviewed.progressSummary?.durationMs ?? 0),
			};
			if (reviewed.controlEvents?.length) result.controlEvents = [...(result.controlEvents ?? []), ...reviewed.controlEvents];
			result.messages = [...(result.messages ?? []), ...(reviewed.messages ?? [])];
			const submission = finalizationReportByResult.get(reviewed);
			const output = submission?.output ?? acceptanceOutputByResult.get(reviewed) ?? getFinalOutput(reviewed.messages ?? []) ?? reviewed.finalOutput ?? "";
			if (reviewed.exitCode !== 0 || reviewed.error || reviewed.detached || reviewed.interrupted) {
				result.interrupted = reviewed.interrupted;
				result.timedOut = reviewed.timedOut;
				result.resourceLimitExceeded = reviewed.resourceLimitExceeded;
				result.exitCode = reviewed.exitCode;
				result.error = reviewed.error;
				return { ...submission, output, error: reviewed.error ?? "Acceptance finalization turn did not complete successfully." };
			}
			if (submission?.reportSubmissionError) return submission;
			const writtenSnapshot = writtenOutputSnapshotByResult.get(reviewed);
			if (writtenSnapshot) writtenOutputSnapshotByResult.set(result, writtenSnapshot);
			else writtenOutputSnapshotByResult.delete(result);
			result.finalOutput = reviewed.finalOutput;
			result.savedOutputPath = reviewed.savedOutputPath;
			result.outputReference = reviewed.outputReference;
			result.outputSaveError = reviewed.outputSaveError;
			artifactOutputByResult.set(result, artifactOutputByResult.get(reviewed) ?? reviewed.finalOutput ?? "");
			return { ...submission, output };
		},
	});
	if (result.acceptance.finalization) result.initialOutput = initialOutput;
	Object.assign(result, resolveExecutionOutcome({ result, acceptance: result.acceptance, signal: options.signal, interruptSignal: options.interruptSignal }));
	if (result.acceptance.unconfirmedOutput !== undefined) {
		const auditOutput = result.savedOutputPath && !writtenOutputSnapshotByResult.has(result)
			? artifactOutputByResult.get(result) ?? result.acceptance.unconfirmedOutput : result.acceptance.unconfirmedOutput;
		result.finalOutput = formatUnconfirmedFinalizationOutput(auditOutput);
		artifactOutputByResult.set(result, result.finalOutput);
	}
	stripAcceptanceReportsFromMessages(result.messages ?? []);
	delete result.terminalFailure;
	refreshQuestionLaunch(effectiveOptions.runId, effectiveOptions.index ?? 0, result.sessionFile);
	publishFinalResult(result, effectiveOptions);
	return result;
}
