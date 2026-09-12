import { spawn, spawnSync } from "node:child_process";
import { addAbortListener } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { readAsyncControlRequests } from "./async-control.ts";
import { appendJsonl, getArtifactPaths } from "../../shared/artifacts.ts";
import { PI_CODING_AGENT_PACKAGE, getPiSpawnCommand, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import { captureSingleOutputSnapshot, cleanupSingleOutputFile, finalizeSingleOutput, findDuplicateOutputPath, formatConsumedOutputReference, formatSavedOutputReference, injectSingleOutputInstruction, resolveSingleOutput } from "../shared/single-output.ts";
import {
	type AcceptanceLedger,
	type AgentProcessExit,
	type AsyncResultFile,
	type ActivityState,
	type ArtifactPaths,
	type AsyncParallelGroupStatus,
	type AsyncStatus,
	type ChildProjectTrustPolicy,
	type ChainOutputMap,
	type ModelAttempt,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type ResourceLimitExceeded,
	type SubagentRunMode,
	type TokenUsage,
	type Usage,
	type WorkflowGraphSnapshot,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	deriveActivityState,
	claimControlNotification,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
} from "../shared/subagent-control.ts";
import {
	type RunnerSubagentStep as SubagentStep,
	type RunnerStep,
	isDynamicRunnerGroup,
	isParallelGroup,
	flattenSteps,
	MAX_PARALLEL_CONCURRENCY,
} from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir, SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../shared/pi-args.ts";
import {
	appendClaudeCodeMessage,
	buildClaudeCodeInvocation,
	claudeCodeMessageFromResult,
	isClaudeCodeModel,
	writeClaudeCodeSessionMetadata,
	type ClaudeCodeInvocation,
	type ClaudeCodeResultEvent,
} from "../shared/claude-code.ts";
import { renderChainTask } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime, readStructuredOutput, type StructuredOutputRuntime } from "../shared/structured-output.ts";
import { DynamicFanoutError, materializeDynamicParallelStep } from "../shared/dynamic-fanout.ts";
import { completeWorkflowStep, runParallelTasks, workflowChildSucceeded, type ParallelStopReason } from "../shared/workflow-policy.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.ts";
import { runModelAttempts, sumAttemptUsage } from "../shared/model-fallback.ts";
import { attachChildProcessLifecycle } from "../../shared/post-exit-stdio-guard.ts";
import { updateStreamingText } from "../shared/streaming-text.ts";
import { pendingSupervisorQuestion, refreshQuestionLaunch, saveAsyncRunResult, saveRunStatus, saveQuestionContract } from "../shared/supervisor-questions.ts";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, findLatestSessionFile, formatResourceLimitExceeded, getFinalOutput } from "../../shared/utils.ts";
import { hasCompletedMutationToolCall, resolveCompletionPolicy } from "../shared/completion-guard.ts";
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
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import {
	appendWorktreeSummary,
	cleanupWorktrees,
	createWorktrees,
	findWorktreeTaskCwdConflict,
	formatParallelWorktreeSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import { providerQualifiedModelId, resolveEffectiveThinking } from "../../shared/model-info.ts";
import { namespaceParallelOutput, writeInitialProgressFile } from "../../shared/settings.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
	evaluateRunAcceptance,
	acceptanceHumanAction,
	createFinalizationReportRuntime,
	readFinalizationReport,
	formatUnconfirmedFinalizationOutput,
	resolveExecutionOutcome,
	resolveFinalizationOutput,
	formatAcceptancePrompt,
	stripAcceptanceReport,
} from "../shared/acceptance.ts";

interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	chainDir?: string;
	originalTask?: string;
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	piPackageRoot?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
	projectTrust?: ChildProjectTrustPolicy;
}

interface StepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	exitCode?: number | null;
	skipped?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	resourceLimitExceeded?: ResourceLimitExceeded;
	interrupted?: boolean;
	agentProcessExit?: AgentProcessExit;
}

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = "SIGUSR2";

function formatProcessExitFailure(input: { agent: string; exitCode: number | null; durationMs?: number }): string {
	const duration = input.durationMs !== undefined ? ` after ${input.durationMs}ms` : "";
	if (input.exitCode === 143) {
		return `${input.agent} exited with code 143${duration}. The child process received SIGTERM or exited as if terminated by SIGTERM; if this was close to 300000ms, Pi's default HTTP idle timeout is a likely provider-side cause.`;
	}
	return `${input.agent} exited with code ${input.exitCode ?? 1}${duration} without producing a final assistant response.`;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function tokenUsageFromAttempts(attempts: ModelAttempt[] | undefined): TokenUsage | null {
	if (!attempts || attempts.length === 0) return null;
	let input = 0;
	let output = 0;
	for (const attempt of attempts) {
		input += attempt.usage?.input ?? 0;
		output += attempt.usage?.output ?? 0;
	}
	const total = input + output;
	return total > 0 ? { input, output, total } : null;
}

function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
	const nonEmpty = lines.filter((line) => line.trim());
	if (nonEmpty.length === 0) return;
	step.recentOutput ??= [];
	step.recentOutput.push(...nonEmpty);
	if (step.recentOutput.length > 50) {
		step.recentOutput.splice(0, step.recentOutput.length - 50);
	}
}

function clearStepCurrentActivity(step: RunnerStatusStep): void {
	step.currentTool = undefined;
	step.currentToolArgs = undefined;
	step.currentToolStartedAt = undefined;
	step.currentPath = undefined;
}

function resetStepLiveDetail(step: RunnerStatusStep): void {
	clearStepCurrentActivity(step);
	step.recentTools = [];
	step.recentOutput = [];
}

function markStepPaused(step: RunnerStatusStep, now: number): void {
	step.status = "paused";
	step.activityState = undefined;
	clearStepCurrentActivity(step);
	step.startedAt ??= now;
	step.endedAt = now;
	step.durationMs = step.startedAt !== undefined ? now - step.startedAt : undefined;
	step.lastActivityAt = now;
	step.exitCode = 0;
}

interface ChildEventContext {
	eventsPath: string;
	runId: string;
	stepIndex: number;
	agent: string;
}

interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

type ChildMessage = Message & {
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

interface ChildEvent {
	type?: string;
	assistantMessageEvent?: Parameters<typeof updateStreamingText>[1]["assistantMessageEvent"];
	message?: ChildMessage;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	isError?: boolean;
}

interface RunPiStreamingResult {
	stderr: string;
	agentProcessExit?: AgentProcessExit;
	exitCode: number | null;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	finalOutput: string;
	interrupted?: boolean;
	observedCompletedMutation?: boolean;
	resourceLimitExceeded?: ResourceLimitExceeded;
	durationMs?: number;
}

interface RunSingleStepResult {
	agent: string;
	agentProcessExit?: AgentProcessExit;
	output: string;
	exitCode: number;
	error?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	interrupted?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	completionGuardTriggered?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	resourceLimitExceeded?: ResourceLimitExceeded;
}

type AsyncParallelStepResult = RunSingleStepResult & {
	skipped?: boolean;
};

function runPiStreaming(
	args: string[],
	cwd: string,
	outputFile: string,
	env?: Record<string, string | undefined>,
	maxSubagentDepth?: number,
	childEventContext?: ChildEventContext,
	interruptSignal?: AbortSignal,
	onChildEvent?: (event: ChildEvent) => void,
	maxExecutionTimeMs?: number,
	maxTokens?: number,
	claudeCodeInvocation?: ClaudeCodeInvocation,
	sessionFile?: string,
	structuredOutput?: StructuredOutputRuntime,
	signal?: AbortSignal,
	reportRuntime?: StructuredOutputRuntime,
): Promise<RunPiStreamingResult> {
	return new Promise((resolve) => {
		const startTime = Date.now();
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const spawnEnv = { ...process.env, ...(env ?? {}), ...getSubagentDepthEnv(maxSubagentDepth) };
		const spawnSpec = claudeCodeInvocation
			? { command: claudeCodeInvocation.command, args: claudeCodeInvocation.args }
			: getPiSpawnCommand(args);
		const child = spawn(spawnSpec.command, spawnSpec.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: spawnEnv,
			detached: true,
		});
		const lifecycle = attachChildProcessLifecycle(child);
		if (child.pid && childEventContext) saveQuestionContract(childEventContext.runId, childEventContext.stepIndex, { pid: child.pid, sessionFile, updatedAt: Date.now() });
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let resourceLimitExceeded: ResourceLimitExceeded | undefined;
		let observedCompletedMutation = false;
		const mutationTracker = createMutationCompletionTracker();
		let resourceLimitTimer: NodeJS.Timeout | undefined;
		const subagentLoopGuard = createRepeatedSubagentCallGuardState();
		const rawStdoutLines: string[] = [];

		const writeOutputLine = (line: string) => {
			if (!line.trim()) return;
			outputStream.write(`${line}\n`);
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				writeOutputLine(line);
			}
		};

		const failForToolLoop = (message: string) => {
			if (settled || resourceLimitExceeded || lifecycle.stopping) return;
			error = message;
			writeOutputLine(message);
			lifecycle.terminate();
		};

		const triggerResourceLimit = (kind: ResourceLimitExceeded["kind"], limit: number, observed?: number) => {
			if (settled || resourceLimitExceeded) return;
			const message = formatResourceLimitExceeded({ agent: childEventContext?.agent ?? "subagent", kind, limit, observed });
			resourceLimitExceeded = { kind, limit, ...(observed !== undefined ? { observed } : {}), message };
			error = message;
			writeOutputLine(message);
			lifecycle.terminate();
		};

		const appendChildEvent = (event: object) => {
			if (!childEventContext) return;
			appendJsonl(childEventContext.eventsPath, JSON.stringify({
				...event,
				subagentSource: "child",
				subagentRunId: childEventContext.runId,
				subagentStepIndex: childEventContext.stepIndex,
				subagentAgent: childEventContext.agent,
				observedAt: Date.now(),
			}));
		};

		const appendChildLine = (type: "subagent.child.stdout" | "subagent.child.stderr", line: string) => {
			appendChildEvent({ type, line });
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			let event: ChildEvent;
			try {
				event = JSON.parse(line) as ChildEvent;
			} catch {
				rawStdoutLines.push(line);
				writeOutputLine(line);
				appendChildLine("subagent.child.stdout", line);
				return;
			}
			if (!event || typeof event !== "object") return;
			lifecycle.observeEvent(claudeCodeInvocation && event.type === "result" ? "agent_settled" : event.type);
			if (claudeCodeInvocation && event.type === "result") {
				const resultEvent = event as ClaudeCodeResultEvent;
				if (structuredOutput && resultEvent.structured_output !== undefined) {
					fs.mkdirSync(path.dirname(structuredOutput.outputPath), { recursive: true });
					fs.writeFileSync(structuredOutput.outputPath, `${JSON.stringify(resultEvent.structured_output)}\n`, "utf-8");
				}
				const message = claudeCodeMessageFromResult(resultEvent, claudeCodeInvocation.model.inputModel);
				if (sessionFile) {
					writeClaudeCodeSessionMetadata(sessionFile, {
						sessionId: resultEvent.session_id || claudeCodeInvocation.sessionId,
						model: claudeCodeInvocation.model.inputModel,
						cliModel: claudeCodeInvocation.model.cliModel,
						family: claudeCodeInvocation.model.family,
						context: claudeCodeInvocation.model.context,
						updatedAt: Date.now(),
					});
					appendClaudeCodeMessage(sessionFile, message);
				}
				event = { type: "message_end", message } as ChildEvent;
			}

			appendChildEvent(event);
			onChildEvent?.(event);

			if (event.type === "tool_execution_start" && event.toolName) {
				const loopFailure = recordToolStartForSubagentLoopGuard({
					state: subagentLoopGuard,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				if (loopFailure) {
					failForToolLoop(loopFailure);
					return;
				}
				mutationTracker.recordToolStart({ toolName: event.toolName, args: event.args });
				const toolArgs = extractToolArgsPreview(event.args ?? {});
				writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
				return;
			}

			if (event.type === "tool_execution_end") {
				const loopFailure = recordToolEndForSubagentLoopGuard({
					state: subagentLoopGuard,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
				});
				if (loopFailure) failForToolLoop(loopFailure);
				return;
			}

			if (event.type === "message_end" && event.message) {
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (text) writeOutputText(text);
				if (event.message.role === "toolResult") {
					const toolSnapshot = mutationTracker.recordToolResult(event.message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown });
					if (toolSnapshot?.completedMutation) observedCompletedMutation = true;
					return;
				}

				if (event.message.role !== "assistant") return;
				model = providerQualifiedModelId(event.message.provider, event.message.model) ?? model;
				if (event.message.errorMessage) assistantError = event.message.errorMessage;
				const eventUsage = event.message.usage;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
					const observedTokens = usage.input + usage.output;
					if (maxTokens !== undefined && observedTokens >= maxTokens) {
						triggerResourceLimit("maxTokens", maxTokens, observedTokens);
					}
				}
				const stopReason = (event.message as { stopReason?: string }).stopReason;
				const hasToolCall = Array.isArray(event.message.content)
					&& event.message.content.some((part) => (part as { type?: string }).type === "toolCall");
				cleanTerminalAssistantStopReceived = stopReason === "stop" && !hasToolCall && !event.message.errorMessage;
				if (cleanTerminalAssistantStopReceived && text.trim()) assistantError = undefined;
			}
		};

		const processStderrText = (text: string) => {
			stderr += text;
			stderrBuf += text;
			outputStream.write(text);
			if (!childEventContext) return;
			const lines = stderrBuf.split("\n");
			stderrBuf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				appendChildLine("subagent.child.stderr", line);
			}
		};

		let cleanTerminalAssistantStopReceived = false;
		let settled = false;
		if (maxExecutionTimeMs !== undefined) {
			resourceLimitTimer = setTimeout(() => {
				triggerResourceLimit("maxExecutionTimeMs", maxExecutionTimeMs);
			}, maxExecutionTimeMs);
			resourceLimitTimer.unref?.();
		}
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdoutBuf += text;
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			processStderrText(chunk.toString());
		});
		const interruptListener = interruptSignal && addAbortListener(interruptSignal, () => {
			if (signal?.aborted || settled || resourceLimitExceeded) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			lifecycle.terminate();
		});
		const abortListener = signal && addAbortListener(signal, () => {
			interrupted = false;
			error = "Subagent cancelled.";
			lifecycle.terminate();
		});
		const cleanup = () => {
			clearTimeout(resourceLimitTimer);
			interruptListener?.[Symbol.dispose]();
			abortListener?.[Symbol.dispose]();
		};
		child.on("close", (exitCode, exitSignal) => {
			settled = true;
			cleanup();
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (stderrBuf.trim()) appendChildLine("subagent.child.stderr", stderrBuf);
			outputStream.end();
			const durationMs = Date.now() - startTime;
			const finalOutput = resourceLimitExceeded?.message ?? (getFinalOutput(messages) || rawStdoutLines.join("\n").trim());
			const currentReport = reportRuntime && readFinalizationReport(messages, reportRuntime).output;
			if (currentReport) assistantError = undefined;
			const finalError = resourceLimitExceeded?.message ?? error ?? assistantError;
			const forcedDrainAfterFinalSuccess = lifecycle.settledCleanup && (cleanTerminalAssistantStopReceived || currentReport) && !finalError;
			resolve({
				stderr,
				agentProcessExit: lifecycle.agentProcessExit,
				exitCode: resourceLimitExceeded ? 1 : interrupted || forcedDrainAfterFinalSuccess ? 0 : lifecycle.stopping || exitSignal ? (exitCode ?? 1) : exitCode,
				messages,
				usage,
				model,
				error: interrupted || forcedDrainAfterFinalSuccess ? undefined : finalError,
				finalOutput,
				interrupted,
				observedCompletedMutation,
				resourceLimitExceeded,
				durationMs,
			});
		});

		child.on("error", (spawnError) => {
			settled = true;
			cleanup();
			outputStream.end();
			const finalOutput = resourceLimitExceeded?.message ?? (getFinalOutput(messages) || rawStdoutLines.join("\n").trim());
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			resolve({ stderr, exitCode: 1, messages, usage, model, error: resourceLimitExceeded?.message ?? error ?? assistantError ?? spawnErrorMessage, finalOutput, observedCompletedMutation, resourceLimitExceeded, durationMs: Date.now() - startTime });
		});
	});
}

function resolvePiPackageRootFallback(): string {
	const root = resolveInstalledPiPackageRoot();
	if (root) return root;
	throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
}

async function exportSessionHtml(sessionFile: string, outputDir: string, piPackageRoot?: string): Promise<string> {
	const pkgRoot = piPackageRoot ?? resolvePiPackageRootFallback();
	const exportModulePath = path.join(pkgRoot, "dist", "core", "export-html", "index.js");
	const moduleUrl = pathToFileURL(exportModulePath).href;
	const mod = await import(moduleUrl);
	const exportFromFile = (mod as { exportFromFile?: (inputPath: string, options?: { outputPath?: string }) => string })
		.exportFromFile;
	if (typeof exportFromFile !== "function") {
		throw new Error("exportFromFile not available");
	}
	const outputPath = path.join(outputDir, `${path.basename(sessionFile, ".jsonl")}.html`);
	return exportFromFile(sessionFile, { outputPath });
}

function createShareLink(htmlPath: string): { shareUrl: string; gistUrl: string } | { error: string } {
	try {
		const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (auth.status !== 0) {
			return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
		}
	} catch {
		return { error: "GitHub CLI (gh) is not installed." };
	}

	try {
		const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
		if (result.status !== 0) {
			const err = (result.stderr || "").trim() || "Failed to create gist.";
			return { error: err };
		}
		const gistUrl = (result.stdout || "").trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) return { error: "Failed to parse gist ID." };
		const shareUrl = `https://shittycodingagent.ai/session/?${gistId}`;
		return { shareUrl, gistUrl };
	} catch (err) {
		return { error: String(err) };
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	return `${minutes}m${seconds}s`;
}

function writeRunLog(
	logPath: string,
	input: {
		id: string;
		mode: SubagentRunMode;
		cwd: string;
		startedAt: number;
		endedAt: number;
		steps: Array<{
			agent: string;
			status: string;
			durationMs?: number;
		}>;
		summary: string;
		truncated: boolean;
		artifactsDir?: string;
		sessionFile?: string;
		shareUrl?: string;
		shareError?: string;
	},
): void {
	const lines: string[] = [];
	lines.push(`# Subagent run ${input.id}`);
	lines.push("");
	lines.push(`- **Mode:** ${input.mode}`);
	lines.push(`- **Launch cwd:** ${input.cwd}`);
	lines.push(`- **Started:** ${new Date(input.startedAt).toISOString()}`);
	lines.push(`- **Ended:** ${new Date(input.endedAt).toISOString()}`);
	lines.push(`- **Duration:** ${formatDuration(input.endedAt - input.startedAt)}`);
	if (input.sessionFile) lines.push(`- **Session:** ${input.sessionFile}`);
	if (input.shareUrl) lines.push(`- **Share:** ${input.shareUrl}`);
	if (input.shareError) lines.push(`- **Share error:** ${input.shareError}`);
	if (input.artifactsDir) lines.push(`- **Artifacts:** ${input.artifactsDir}`);
	lines.push("");
	lines.push("## Steps");
	lines.push("| Step | Agent | Status | Duration |");
	lines.push("| --- | --- | --- | --- |");
	input.steps.forEach((step, i) => {
		const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : "-";
		lines.push(`| ${i + 1} | ${step.agent} | ${step.status} | ${duration} |`);
	});
	lines.push("");
	lines.push("## Summary");
	if (input.truncated) {
		lines.push("_Output truncated_");
		lines.push("");
	}
	lines.push(input.summary.trim() || "(no output)");
	lines.push("");
	fs.writeFileSync(logPath, lines.join("\n"), "utf-8");
}

/** Context for running a single step */
interface SingleStepContext {
	cwd: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	artifactsDir?: string;
	id: string;
	flatIndex: number;
	flatStepCount: number;
	outputFile: string;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: NestedRouteInfo;
	projectTrust?: ChildProjectTrustPolicy;
	onAttemptStart?: (attempt: { model?: string; thinking?: string }) => void;
	onChildEvent?: (event: ChildEvent) => void;
}

/** Run a single pi agent step, returning output and metadata */
async function runSingleStep(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<RunSingleStepResult> {
	if (ctx.signal?.aborted) return { agent: step.agent, output: "", exitCode: 1, error: "Subagent cancelled." };
	saveQuestionContract(ctx.id, ctx.flatIndex, { task: step.task, label: step.label, effectiveAcceptance: step.effectiveAcceptance, output: step.outputPath ?? false, outputMode: step.outputMode, outputSchema: step.structuredOutputSchema ?? step.structuredOutput?.schema, launch: step.launch ? { ...step.launch, cwd: step.cwd ?? ctx.cwd, output: step.outputPath ?? false, outputMode: step.outputMode ?? "inline", outputSchema: step.structuredOutputSchema ?? step.structuredOutput?.schema, model: step.model, thinking: step.thinking } : undefined, sessionFile: step.sessionFile });
	const interruptController = new AbortController();
	ctx.registerInterrupt?.(() => interruptController.abort());
	const interruptSignal = AbortSignal.any([ctx.interruptSignal, interruptController.signal].filter((signal) => signal !== undefined));
	const verificationSignal = AbortSignal.any([ctx.signal, interruptSignal].filter((signal) => signal !== undefined));
	const effectiveStructuredOutput = step.structuredOutput ?? (step.structuredOutputSchema
		? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(ctx.outputFile), "structured-output"))
		: undefined);
	let task = step.task;
	if (step.effectiveAcceptance) {
		const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance);
		if (acceptancePrompt) task = `${task}\n${acceptancePrompt}`;
	}
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;
	let artifactPaths: ArtifactPaths | undefined;
	if (ctx.artifactsDir) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
	}

	type StepAttempt = RunPiStreamingResult & {
		terminalFailure?: boolean;
		completionGuardTriggered?: boolean;
		structuredOutput?: unknown;
		reportSubmission?: ReturnType<typeof readFinalizationReport>;
		resolvedOutput: ReturnType<typeof resolveSingleOutput>;
	};
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	async function runAttempt(prompt: string, model: string | undefined, review?: { turn: number; sessionFile: string; previousOutput: string; reportRuntime?: StructuredOutputRuntime; outputSnapshot?: ReturnType<typeof captureSingleOutputSnapshot> }): Promise<StepAttempt> {
		if (verificationSignal.aborted) {
			const outcome = resolveExecutionOutcome({ result: { exitCode: 1 }, signal: ctx.signal, interruptSignal });
			return { stderr: "", messages: [], usage: emptyUsage(), finalOutput: outcome.error ?? "Interrupted. Waiting for explicit next action.",
				...outcome, model, terminalFailure: true, resolvedOutput: { fullOutput: "" } };
		}
		ctx.onAttemptStart?.({ model, thinking: resolveEffectiveThinking(model, step.thinking) });
		const structuredRuntime = review ? review.reportRuntime : effectiveStructuredOutput;
		const outputSnapshot = review ? review.outputSnapshot : captureSingleOutputSnapshot(step.outputPath);
		if (structuredRuntime) {
			try { fs.rmSync(structuredRuntime.outputPath, { force: true }); } catch {
				// readStructuredOutput reports unreadable or stale output after the attempt.
			}
		}
		let args: string[];
		let env: Record<string, string | undefined>;
		let tempDir: string | undefined;
		let claudeCodeInvocation: ClaudeCodeInvocation | undefined;
		const sessionFile = review?.sessionFile ?? step.sessionFile;
		try {
			if (model && isClaudeCodeModel(model)) {
				claudeCodeInvocation = buildClaudeCodeInvocation({ model, task: prompt, systemPrompt: step.systemPrompt ?? undefined,
					systemPromptMode: step.systemPromptMode, sessionFile, sessionName: ctx.childIntercomTarget,
					tools: step.tools, mcpDirectTools: step.mcpDirectTools, allowSubagents: step.allowSubagents, outputSchema: structuredRuntime?.schema });
				args = claudeCodeInvocation.args;
				env = claudeCodeInvocation.env;
			} else {
				const built = buildPiArgs({
					baseArgs: ["--mode", "json", "-p"], task: prompt, model, thinking: step.thinking,
					sessionEnabled: review ? true : sessionEnabled, sessionDir: review ? undefined : sessionDir, sessionFile,
					inheritProjectContext: step.inheritProjectContext, inheritSkills: step.inheritSkills,
					tools: step.tools, allowSubagents: step.allowSubagents, extensions: step.extensions,
					systemPrompt: step.systemPrompt, systemPromptMode: step.systemPromptMode, mcpDirectTools: step.mcpDirectTools,
					cwd: step.cwd ?? ctx.cwd, intercomSessionName: ctx.childIntercomTarget, orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
					runId: ctx.id, childAgentName: step.agent, childIndex: ctx.flatIndex,
					parentEventSink: ctx.nestedRoute?.eventSink, parentControlInbox: ctx.nestedRoute?.controlInbox,
					parentRootRunId: ctx.nestedRoute?.rootRunId, parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
					structuredOutput: structuredRuntime, projectTrust: ctx.projectTrust,
				});
				args = built.args;
				env = built.env;
				tempDir = built.tempDir;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { stderr: message, exitCode: 1, messages: [], usage: emptyUsage(), model, error: message,
				finalOutput: message, terminalFailure: true, resolvedOutput: { fullOutput: message } };
		}
		let run: RunPiStreamingResult;
		try {
			run = await runPiStreaming(args, step.cwd ?? ctx.cwd, review ? `${ctx.outputFile}.finalization-${review.turn}.log` : ctx.outputFile,
				env, step.maxSubagentDepth, { eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
				interruptSignal, ctx.onChildEvent, step.maxExecutionTimeMs, step.maxTokens, claudeCodeInvocation,
				sessionFile, structuredRuntime, ctx.signal, review?.reportRuntime);
		} finally {
			cleanupTempDir(tempDir);
		}
		const reportSubmission = review?.reportRuntime ? readFinalizationReport(run.messages, review.reportRuntime) : undefined;
		const hiddenError = run.exitCode === 0 && !run.error && !reportSubmission?.output ? detectSubagentError(run.messages) : undefined;
		let structuredOutput: unknown;
		let structuredError: string | undefined;
		if (!review && structuredRuntime && run.exitCode === 0 && !run.error && !hiddenError?.hasError && !run.interrupted) {
			const structured = readStructuredOutput(structuredRuntime);
			structuredError = structured.error;
			structuredOutput = structured.value;
		}
		const completionGuardTriggered = !review && run.exitCode === 0 && !run.error && !hiddenError?.hasError && !run.interrupted
			&& resolveCompletionPolicy({ completionGuardEnabled: step.completionGuard === true, usesAcceptanceContract: step.effectiveAcceptance?.explicit === true }) === "mutation-guard"
			&& !run.observedCompletedMutation && !hasCompletedMutationToolCall(run.messages);
		let error = completionGuardTriggered
			? "Subagent completed without making edits required by completionGuard: true.\nUse an acceptance contract when a valid no-op is allowed."
			: structuredError ?? (hiddenError?.hasError
				? hiddenError.details ? `${hiddenError.errorType} failed (exit ${hiddenError.exitCode ?? 1}): ${hiddenError.details}` : `${hiddenError.errorType} failed with exit code ${hiddenError.exitCode ?? 1}`
				: run.error || (run.exitCode !== 0 ? run.stderr.trim() || formatProcessExitFailure({ agent: step.agent, exitCode: run.exitCode, durationMs: run.durationMs }) : undefined));
		let exitCode = completionGuardTriggered || structuredError ? 1 : hiddenError?.hasError ? hiddenError.exitCode ?? 1 : error && run.exitCode === 0 ? 1 : run.exitCode;
		const finalOutput = reportSubmission?.output ?? run.finalOutput;
		const fullOutput = review ? resolveFinalizationOutput(finalOutput, review.previousOutput) : stripAcceptanceReport(finalOutput);
		const resolvedOutput = step.outputPath && exitCode === 0 && !run.interrupted && !reportSubmission?.reportSubmissionError
			? resolveSingleOutput(step.outputPath, fullOutput, outputSnapshot)
			: { fullOutput };
		if (resolvedOutput.saveError) {
			exitCode = 1;
			error = `Failed to save output file '${step.outputPath}': ${resolvedOutput.saveError}`;
		}
		return { ...run, exitCode, error, model: model ?? run.model, structuredOutput, reportSubmission, finalOutput, resolvedOutput, completionGuardTriggered,
			terminalFailure: Boolean(completionGuardTriggered || structuredError || hiddenError?.hasError || resolvedOutput.saveError) };
	}

	const { result: initial, modelAttempts, attemptedModels, notes: attemptNotes } = await runModelAttempts({
		candidates: step.modelCandidates?.length ? step.modelCandidates : [step.model], signal: verificationSignal,
		runAttempt: (model) => runAttempt(task, model),
	});
	let execution = initial;
	let resolvedOutput = initial.resolvedOutput;
	let output = stripAcceptanceReport(resolvedOutput.fullOutput);
	const initialOutput = output;
	const sessionFile = step.sessionFile ?? (sessionDir ? findLatestSessionFile(sessionDir) ?? undefined : undefined);
	const nativeReport = !initial.model || !isClaudeCodeModel(initial.model);
	const acceptance = step.effectiveAcceptance ? await evaluateRunAcceptance({
		acceptance: step.effectiveAcceptance, initial, initialOutput: initial.finalOutput, sessionFile, cwd: step.cwd ?? ctx.cwd, signal: verificationSignal, nativeReport,
		runTurn: async (prompt, turn, sessionFile) => {
			const reportRuntime = nativeReport ? createFinalizationReportRuntime() : undefined;
			let reviewed: StepAttempt;
			try {
				reviewed = await runAttempt(prompt, initial.model ?? step.model, { turn, sessionFile, previousOutput: output, reportRuntime,
					outputSnapshot: nativeReport ? resolvedOutput.writtenSnapshot : undefined });
			} finally {
				if (reportRuntime) cleanupTempDir(path.dirname(reportRuntime.schemaPath));
			}
			execution = reviewed;
			modelAttempts.push({ model: reviewed.model ?? "default", success: reviewed.exitCode === 0 && !reviewed.error && !reviewed.interrupted,
				exitCode: reviewed.exitCode, error: reviewed.error, usage: { ...reviewed.usage } });
			if (reviewed.exitCode !== 0 || reviewed.error || reviewed.interrupted) return { ...reviewed.reportSubmission, output: reviewed.finalOutput,
				error: reviewed.error ?? reviewed.resourceLimitExceeded?.message ?? "Acceptance finalization turn did not complete successfully." };
			if (reviewed.reportSubmission?.reportSubmissionError) return reviewed.reportSubmission;
			resolvedOutput = reviewed.resolvedOutput;
			output = stripAcceptanceReport(resolvedOutput.fullOutput);
			return { ...reviewed.reportSubmission, output: reviewed.finalOutput };
		},
	}) : undefined;
	const outcome = resolveExecutionOutcome({ result: execution, acceptance, signal: ctx.signal, interruptSignal });
	if (acceptance?.unconfirmedOutput !== undefined) {
		const auditOutput = resolvedOutput.savedPath && !resolvedOutput.writtenSnapshot ? output : acceptance.unconfirmedOutput;
		output = formatUnconfirmedFinalizationOutput(auditOutput);
	}
	const effectiveFinalExitCode = outcome.exitCode ?? 1;
	const cleanup = effectiveFinalExitCode === 0 && !outcome.interrupted && resolvedOutput.savedPath && step.outputMode !== "file-only" && step.outputPathFromAgentDefault === true
		? cleanupSingleOutputFile(resolvedOutput.savedPath, output, undefined)
		: undefined;
	const outputReference = resolvedOutput.savedPath
		? cleanup ? formatConsumedOutputReference(resolvedOutput.savedPath, output, cleanup) : formatSavedOutputReference(resolvedOutput.savedPath, output)
		: undefined;
	const outputForSummary = finalizeSingleOutput({
		fullOutput: attemptNotes.length ? `${attemptNotes.join("\n")}\n\n${output}`.trim() : output,
		outputPath: step.outputPath, outputMode: step.outputMode, exitCode: effectiveFinalExitCode,
		savedPath: resolvedOutput.savedPath, outputReference, saveError: resolvedOutput.saveError, cleanup,
	}).displayOutput;
	const usage = sumAttemptUsage(modelAttempts);
	if (artifactPaths) {
		fs.writeFileSync(artifactPaths.outputPath, output, "utf-8");
		fs.writeFileSync(artifactPaths.metadataPath, JSON.stringify({
			runId: ctx.id, agent: step.agent, task, exitCode: effectiveFinalExitCode, interrupted: outcome.interrupted, agentProcessExit: execution.agentProcessExit,
			error: outcome.error, acceptance, initialOutput: acceptance?.finalization ? initialOutput : undefined, usage,
			model: initial.model, attemptedModels: attemptedModels.length ? attemptedModels : undefined, modelAttempts,
			resourceLimitExceeded: outcome.resourceLimitExceeded, skills: step.skills, timestamp: Date.now(),
		}, null, 2), "utf-8");
	}
	// Snapshot before a continuation can append different choices to this same session.
	refreshQuestionLaunch(ctx.id, ctx.flatIndex, sessionFile);
	const result: RunSingleStepResult = {
		agent: step.agent, output: outputForSummary, exitCode: effectiveFinalExitCode, error: outcome.error, agentProcessExit: execution.agentProcessExit,
		sessionFile, intercomTarget: ctx.childIntercomTarget, model: initial.model,
		attemptedModels: attemptedModels.length ? attemptedModels : undefined, modelAttempts, artifactPaths,
		interrupted: outcome.interrupted, completionGuardTriggered: initial.completionGuardTriggered,
		structuredOutput: initial.structuredOutput, structuredOutputPath: effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath: effectiveStructuredOutput?.schemaPath, acceptance, resourceLimitExceeded: outcome.resourceLimitExceeded,
	};
	saveQuestionContract(ctx.id, ctx.flatIndex, { result: { ...result, task, usage, finalOutput: result.output }, updatedAt: Date.now() });
	return result;
}

type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
};

type RunnerStatusPayload = Omit<AsyncStatus, "steps" | "parallelGroups" | "pid" | "cwd" | "currentStep" | "chainStepCount" | "lastUpdate"> & {
	pid: number;
	cwd: string;
	currentStep: number;
	chainStepCount: number;
	parallelGroups: AsyncParallelGroupStatus[];
	steps: RunnerStatusStep[];
	lastUpdate: number;
	artifactsDir?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	error?: string;
};

function markParallelGroupSetupFailure(input: {
	statusPayload: RunnerStatusPayload;
	results: StepResult[];
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	setupError: string;
	failedAt: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		input.statusPayload.steps[flatTaskIndex].status = "failed";
		input.statusPayload.steps[flatTaskIndex].startedAt = input.failedAt;
		input.statusPayload.steps[flatTaskIndex].endedAt = input.failedAt;
		input.statusPayload.steps[flatTaskIndex].durationMs = 0;
		input.statusPayload.steps[flatTaskIndex].exitCode = 1;
		input.results.push({ agent: input.group.parallel[taskIndex].agent, output: input.setupError, success: false, exitCode: 1, sessionFile: input.group.parallel[taskIndex].sessionFile });
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.lastUpdate = input.failedAt;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeAtomicJson(input.statusPath, input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.completed",
		ts: input.failedAt,
		runId: input.runId,
		stepIndex: input.stepIndex,
		success: false,
	}));
}

function markParallelGroupRunning(input: {
	statusPayload: RunnerStatusPayload;
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	groupStartTime: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		input.statusPayload.steps[flatTaskIndex].status = "pending";
		input.statusPayload.steps[flatTaskIndex].startedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].endedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].durationMs = undefined;
		input.statusPayload.steps[flatTaskIndex].lastActivityAt = undefined;
		input.statusPayload.steps[flatTaskIndex].activityState = undefined;
		input.statusPayload.steps[flatTaskIndex].error = undefined;
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.activityState = undefined;
	input.statusPayload.lastActivityAt = input.groupStartTime;
	input.statusPayload.lastUpdate = input.groupStartTime;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeAtomicJson(input.statusPath, input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.started",
		ts: input.groupStartTime,
		runId: input.runId,
		stepIndex: input.stepIndex,
		agents: input.group.parallel.map((task) => task.agent),
		count: input.group.parallel.length,
	}));
}

function prepareParallelTaskRun(
	task: SubagentStep,
	cwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	taskIndex: number,
): { taskForRun: SubagentStep; taskCwd: string } {
	if (!worktreeSetup) return { taskForRun: task, taskCwd: cwd };
	return {
		taskForRun: { ...task, cwd: undefined },
		taskCwd: worktreeSetup.worktrees[taskIndex]!.agentCwd,
	};
}

function formatRunnerWorktreeSummary(
	worktreeSetup: WorktreeSetup | undefined,
	asyncDir: string,
	stepIndex: number,
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>,
): string {
	return formatParallelWorktreeSummary(
		worktreeSetup,
		path.join(asyncDir, "worktree-diffs", `step-${stepIndex}`),
		group.parallel.map((task) => task.agent),
	);
}

function ensureParallelProgressFile(cwd: string, group: Extract<RunnerStep, { parallel: SubagentStep[] }>): void {
	const progressPath = path.join(cwd, "progress.md");
	if (!group.parallel.some((task) => task.task.includes(`Update progress at: ${progressPath}`))) return;
	writeInitialProgressFile(cwd);
}

function materializeDynamicOutputPath(input: {
	step: SubagentStep;
	chainDir: string;
	stepIndex: number;
	taskIndex: number;
}): SubagentStep {
	if (!input.step.output || !input.step.outputPath) return input.step;
	const output = namespaceParallelOutput(input.step.output, input.step.agent, input.stepIndex, input.taskIndex);
	if (!output) return input.step;
	const outputPath = path.resolve(input.chainDir, output);
	const task = input.step.task.includes(input.step.outputPath)
		? input.step.task.split(input.step.outputPath).join(outputPath)
		: injectSingleOutputInstruction(input.step.task, outputPath);
	return { ...input.step, task, outputPath };
}

async function runSubagent(config: SubagentRunConfig): Promise<void> {
	const { id, steps, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir } =
		config;
	let previousOutput = "";
	const outputs: ChainOutputMap = {};
	const renderTask = (template: string, item?: { name: string; value: unknown }): string =>
		config.resultMode === "single" || config.resultMode === "parallel" ? template
			: renderChainTask(template, { originalTask: config.originalTask, previousOutput, chainDir: config.chainDir, outputs, item }, placeholder);
	const results: StepResult[] = [];
	const worktreeSummaries: string[] = [];
	const overallStartTime = Date.now();
	const shareEnabled = config.share === true;
	const asyncDir = config.asyncDir;
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const cancellation = new AbortController();
	const cancelRunner = () => cancellation.abort();
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, cancelRunner);
	const activeChildInterrupts = new Map<number, () => void>();
	const interruption = new AbortController();
	let interrupted = false;
	let currentActivityState: ActivityState | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let controlRequestTimer: NodeJS.Timeout | undefined;
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
	let latestSessionFile: string | undefined;

	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const initialStatusSteps: RunnerStatusStep[] = [];
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			for (const task of step.parallel) {
				initialStatusSteps.push({
					agent: task.agent,
					phase: task.phase,
					label: task.label,
					outputName: task.outputName,
					structured: task.structured,
					status: "pending",
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					recentTools: [],
					recentOutput: [],
				});
			}
			flatStepCount += step.parallel.length;
		} else if (isDynamicRunnerGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: 1, stepIndex });
			initialStatusSteps.push({
				agent: `expand:${step.parallel.agent}`,
				phase: step.phase ?? step.parallel.phase,
				label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
				outputName: step.collect.as,
				structured: Boolean(step.collect.outputSchema),
				status: "pending",
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		} else {
			initialStatusSteps.push({
				agent: step.agent,
				phase: step.phase,
				label: step.label,
				outputName: step.outputName,
				structured: step.structured,
				status: "pending",
				...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
				skills: step.skills,
				model: step.model,
				thinking: step.thinking,
				attemptedModels: step.modelCandidates && step.modelCandidates.length > 0 ? step.modelCandidates : step.model ? [step.model] : undefined,
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		}
	}
	const flatSteps = flattenSteps(steps);
	const sessionEnabled = Boolean(config.sessionDir)
		|| shareEnabled
		|| flatSteps.some((step) => Boolean(step.sessionFile));
	const statusPayload: RunnerStatusPayload = {
		runId: id,
		indexedControl: true,
		controlRequestFiles: true,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		mode: config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single"),
		state: "running",
		lastActivityAt: overallStartTime,
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		pid: process.pid,
		cwd,
		currentStep: 0,
		chainStepCount: steps.length,
		parallelGroups,
		workflowGraph: config.workflowGraph,
		steps: initialStatusSteps,
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	};

	fs.mkdirSync(asyncDir, { recursive: true });
	writeAtomicJson(statusPath, statusPayload);
	saveRunStatus(id, statusPayload);
	const emitNestedSelfEvent = (type: "subagent.nested.updated" | "subagent.nested.completed"): void => {
		if (!config.nestedRoute || !config.nestedSelf) return;
		try {
			writeNestedEvent(config.nestedRoute, {
				type,
				ts: Date.now(),
				parentRunId: config.nestedSelf.parentRunId,
				parentStepIndex: config.nestedSelf.parentStepIndex,
				child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
					id,
					parentRunId: config.nestedSelf.parentRunId,
					parentStepIndex: config.nestedSelf.parentStepIndex,
					depth: config.nestedSelf.depth,
					path: config.nestedSelf.path,
					mode: statusPayload.mode,
					ts: Date.now(),
				}),
			});
		} catch (error) {
			console.error("Failed to emit nested async status event:", error);
		}
	};
	const refreshWorkflowGraph = (): void => {
		if (!config.workflowGraph) return;
		const graph = structuredClone(statusPayload.workflowGraph ?? config.workflowGraph);
		const normalize = (status: RunnerStatusStep["status"]): "pending" | "running" | "completed" | "failed" | "blocked" | "paused" | "detached" => {
			if (status === "complete" || status === "completed") return "completed";
			if (status === "running" || status === "failed" || status === "blocked" || status === "paused" || status === "pending") return status;
			return "pending";
		};
		const updateNode = (node: NonNullable<typeof graph.nodes>[number]): void => {
			if (node.flatIndex !== undefined) {
				const step = statusPayload.steps[node.flatIndex];
				if (step) {
					node.status = normalize(step.status);
					node.error = step.error;
					node.acceptanceStatus = step.acceptance?.status;
				}
				if (statusPayload.currentStep === node.flatIndex) graph.currentNodeId = node.id;
			}
			for (const child of node.children ?? []) updateNode(child);
			if (node.children?.length) {
				if (node.children.every((child) => child.status === "completed")) node.status = "completed";
				else if (node.children.some((child) => child.status === "running")) node.status = "running";
				else if (node.children.some((child) => child.status === "failed")) node.status = "failed";
				else if (node.children.some((child) => child.status === "blocked")) node.status = "blocked";
				else if (node.children.some((child) => child.status === "paused")) node.status = "paused";
			}
			if (node.error) node.status = "failed";
		};
		for (const node of graph.nodes) updateNode(node);
		statusPayload.workflowGraph = graph;
	};
	let statusWriteTimer: NodeJS.Timeout | undefined;
	const writeStatusPayload = (): void => {
		if (statusWriteTimer) {
			clearTimeout(statusWriteTimer);
			statusWriteTimer = undefined;
		}
		refreshWorkflowGraph();
		writeAtomicJson(statusPath, statusPayload);
		saveRunStatus(id, statusPayload);
		emitNestedSelfEvent(statusPayload.state === "running" || statusPayload.state === "queued" ? "subagent.nested.updated" : "subagent.nested.completed");
	};
	const scheduleStatusWrite = (): void => {
		if (statusWriteTimer) return;
		statusWriteTimer = setTimeout(writeStatusPayload, 200);
		statusWriteTimer.unref?.();
	};
	const markDynamicGraphGroup = (stepIndex: number, status: "completed" | "failed" | "blocked" | "running" | "paused", error?: string, acceptance?: AcceptanceLedger): void => {
		const groupNode = statusPayload.workflowGraph?.nodes.find((node) => node.id === `step-${stepIndex}`);
		if (!groupNode) return;
		groupNode.status = status;
		groupNode.error = error;
		groupNode.acceptanceStatus = acceptance?.status ?? groupNode.acceptanceStatus;
	};

	const stepOutputActivityAt = (index: number): number => {
		const step = statusPayload.steps[index];
		let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? overallStartTime;
		const outputPath = path.join(asyncDir, `output-${index}.log`);
		try {
			lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`Failed to inspect async output file '${outputPath}':`, error);
			}
		}
		return lastActivityAt;
	};
	const childSafeControls = Boolean(config.nestedSelf) || (process.env[SUBAGENT_CHILD_ENV] === "1" && process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1");
	const emittedControlEventKeys = new Set<string>();
	const mutatingFailureStates = initialStatusSteps.map(() => createMutatingFailureState());
	const mutationTrackers = initialStatusSteps.map(() => createMutationCompletionTracker());
	const mutatingFailureWindowMs = 5 * 60_000;
	const appendControlEvent = (event: ReturnType<typeof buildControlEvent>) => {
		if (!controlConfig.enabled) return;
		const childIntercomTarget = config.childIntercomTargets?.[event.index ?? statusPayload.currentStep];
		const channels = controlConfig.notifyChannels;
		if (channels.length === 0 || !claimControlNotification(controlConfig, event, emittedControlEventKeys, childIntercomTarget)) return;
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.control",
			event,
			channels,
			childIntercomTarget,
			noticeText: formatControlNoticeMessage(event, childIntercomTarget, childSafeControls),
			...(config.controlIntercomTarget && channels.includes("intercom") ? {
				intercom: {
					to: config.controlIntercomTarget,
					message: formatControlIntercomMessage(event, childIntercomTarget, childSafeControls),
				},
			} : {}),
		}));
	};
	const syncTopLevelCurrentTool = (): void => {
		const activeStep = statusPayload.steps
			.filter((step) => step.status === "running" && typeof step.currentTool === "string" && step.currentTool.length > 0)
			.sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
		statusPayload.currentTool = activeStep?.currentTool;
		statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
		statusPayload.currentPath = activeStep?.currentPath;
	};
	const updateStepModel = (flatIndex: number, model: string | undefined, thinking: string | undefined, now = Date.now()): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		step.model = model;
		step.thinking = thinking;
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	const clearControlNotificationKeys = (flatIndex: number): void => {
		const childKey = config.childIntercomTargets?.[flatIndex] ?? `${config.id}:${flatIndex}`;
		for (const key of emittedControlEventKeys) if (key.startsWith(`${childKey}:`)) emittedControlEventKeys.delete(key);
	};
	const updateStepFromChildEvent = (flatIndex: number, event: ChildEvent): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const now = Date.now();
		statusPayload.currentStep = flatIndex;
		if (step.activityState === "needs_attention") {
			step.activityState = undefined;
			clearControlNotificationKeys(flatIndex);
			statusPayload.activityState = statusPayload.steps.some((candidate) => candidate.activityState === "needs_attention")
				? "needs_attention"
				: undefined;
		}
		step.streamingText = updateStreamingText(step.streamingText, event);
		if (event.type === "tool_execution_start" && event.toolName) {
			const currentPath = resolveCurrentPath(event.toolName, event.args);
			step.toolCount = (step.toolCount ?? 0) + 1;
			step.currentTool = event.toolName;
			step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
			step.currentToolStartedAt = now;
			step.currentPath = currentPath;
			mutationTrackers[flatIndex]?.recordToolStart({ toolName: event.toolName, args: event.args, path: currentPath, startedAt: now });
			statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_execution_end") {
			if (step.currentTool) {
				step.recentTools ??= [];
				step.recentTools.push({ tool: step.currentTool, args: step.currentToolArgs || "", endMs: now });
			}
			step.currentTool = undefined;
			step.currentToolArgs = undefined;
			step.currentToolStartedAt = undefined;
			step.currentPath = undefined;
			syncTopLevelCurrentTool();
		} else if (event.type === "message_end" && event.message?.role === "toolResult") {
			const toolSnapshot = mutationTrackers[flatIndex]?.recordToolResult(event.message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown });
			const resultText = extractTextFromContent(event.message.content);
			appendRecentStepOutput(step, resultText.split("\n").slice(-10));
			if (toolSnapshot?.mutates && toolSnapshot.errored) {
				const state = mutatingFailureStates[flatIndex]!;
				recordMutatingFailure(state, {
					tool: toolSnapshot.tool,
					path: toolSnapshot.path,
					error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
					ts: now,
				}, mutatingFailureWindowMs);
				if (controlConfig.enabled && shouldEscalateMutatingFailures(state, controlConfig.failedToolAttemptsBeforeAttention) && step.activityState !== "needs_attention") {
					const previous = step.activityState;
					step.activityState = "needs_attention";
					statusPayload.activityState = "needs_attention";
					appendControlEvent(buildControlEvent({
						type: "needs_attention",
						from: previous,
						to: "needs_attention",
						runId: id,
						agent: step.agent,
						index: flatIndex,
						ts: now,
						message: `${step.agent} needs attention after repeated mutating tool failures`,
						reason: "tool_failures",
						turns: step.turnCount,
						tokens: step.tokens?.total,
						toolCount: step.toolCount,
						currentTool: toolSnapshot.tool,
						currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
						currentPath: toolSnapshot.path,
						recentFailureSummary: summarizeRecentMutatingFailures(state),
					}));
				}
			} else if (toolSnapshot?.mutates) {
				resetMutatingFailureState(mutatingFailureStates[flatIndex]!);
			}
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			appendRecentStepOutput(step, stripAcceptanceReport(extractTextFromContent(event.message.content)).split("\n").slice(-10));
			step.turnCount = (step.turnCount ?? 0) + 1;
			const usage = event.message.usage;
			if (usage) {
				const input = usage.input ?? usage.inputTokens ?? 0;
				const output = usage.output ?? usage.outputTokens ?? 0;
				const previousInput = step.tokens?.input ?? 0;
				const previousOutput = step.tokens?.output ?? 0;
				step.tokens = { input: previousInput + input, output: previousOutput + output, total: previousInput + previousOutput + input + output };
				const totalInput = statusPayload.totalTokens?.input ?? 0;
				const totalOutput = statusPayload.totalTokens?.output ?? 0;
				statusPayload.totalTokens = { input: totalInput + input, output: totalOutput + output, total: totalInput + totalOutput + input + output };
			}
			statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
		}
		syncTopLevelCurrentTool();
		step.lastActivityAt = now;
		statusPayload.lastActivityAt = now;
		statusPayload.lastUpdate = now;
		scheduleStatusWrite();
	};
	const updateRunnerActivityState = (now: number): boolean => {
		if (!controlConfig.enabled) return false;
		let changed = false;
		let runLastActivityAt = statusPayload.lastActivityAt ?? overallStartTime;
		for (let index = 0; index < statusPayload.steps.length; index++) {
			const step = statusPayload.steps[index]!;
			if (step.status !== "running") continue;
			const lastActivityAt = stepOutputActivityAt(index);
			runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
			if (step.lastActivityAt !== lastActivityAt) {
				step.lastActivityAt = lastActivityAt;
				changed = true;
			}
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: step.startedAt ?? overallStartTime,
				lastActivityAt,
				now,
			});
			if (idleState === "needs_attention") {
				const previous = step.activityState;
				step.activityState = "needs_attention";
				if (previous !== "needs_attention") {
					appendControlEvent(buildControlEvent({
						from: previous,
						to: "needs_attention",
						runId: id,
						agent: step.agent,
						index,
						ts: now,
						lastActivityAt,
						currentTool: step.currentTool,
						currentToolDurationMs: step.currentToolStartedAt !== undefined ? Math.max(0, now - step.currentToolStartedAt) : undefined,
						supervisorQuestion: pendingSupervisorQuestion({ runId: id, agent: step.agent, index, sessionFile: step.sessionFile }),
					}));
					changed = true;
				}
			} else if (step.activityState === "needs_attention") {
				step.activityState = undefined;
				clearControlNotificationKeys(index);
				changed = true;
			}
		}
		if (statusPayload.lastActivityAt !== runLastActivityAt) {
			statusPayload.lastActivityAt = runLastActivityAt;
			changed = true;
		}
		const nextRunState = statusPayload.steps.some((step) => step.activityState === "needs_attention")
			? "needs_attention"
			: undefined;
		if (nextRunState !== currentActivityState) {
			currentActivityState = nextRunState;
			statusPayload.activityState = nextRunState;
			changed = true;
		}
		statusPayload.lastUpdate = now;
		if (changed) writeStatusPayload();
		return changed;
	};
	if (controlConfig.enabled) {
		activityTimer = setInterval(() => {
			if (statusPayload.state !== "running") return;
			const now = Date.now();
			updateRunnerActivityState(now);
		}, 1000);
		activityTimer.unref?.();
	}

	const interruptRunner = () => {
		if (interrupted || statusPayload.state !== "running") return;
		interrupted = true;
		interruption.abort();
		const now = Date.now();
		currentActivityState = undefined;
		statusPayload.activityState = undefined;
		statusPayload.lastUpdate = now;
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.run.stop-requested",
			ts: now,
			runId: id,
		}));
		for (const interrupt of activeChildInterrupts.values()) interrupt();
	};
	process.on(ASYNC_INTERRUPT_SIGNAL, interruptRunner);
	controlRequestTimer = setInterval(() => {
		for (const request of readAsyncControlRequests(asyncDir, id)) {
			if (request.action === "cancel") cancellation.abort();
			else if (request.index === undefined) interruptRunner();
			else activeChildInterrupts.get(request.index)?.();
		}
	}, 100);
	controlRequestTimer.unref?.();
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.started",
			ts: overallStartTime,
			runId: id,
			mode: statusPayload.mode,
			cwd,
			pid: process.pid,
		}),
	);

	const stoppedParallelChild = (task: SubagentStep, index: number, reason: ParallelStopReason): AsyncParallelStepResult => {
		const now = Date.now();
		const step = statusPayload.steps[index]!;
		const paused = reason === "interrupted";
		const error = `Skipped due to ${reason}`;
		const exitCode = paused ? 0 : -1;
		if (paused) markStepPaused(step, now);
		else Object.assign(step, { status: "failed", error, startedAt: now, endedAt: now, durationMs: 0, exitCode });
		statusPayload.lastUpdate = now;
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({ type: paused ? "subagent.step.paused" : "subagent.step.failed", ts: now, runId: id, stepIndex: index, agent: task.agent, exitCode, interrupted: paused, durationMs: 0 }));
		return { agent: task.agent, output: error, error, exitCode, interrupted: paused, skipped: true };
	};

	const runParallelChild = async (input: {
		task: SubagentStep;
		flatIndex: number;
		interruptSignal: AbortSignal;
		item?: { name: string; value: unknown };
		taskCwd: string;
		sessionDir?: string;
		flatStepCount: number;
		resetTiming?: boolean;
		trackSession?: boolean;
		notifyCompletionGuard?: boolean;
	}): Promise<AsyncParallelStepResult> => {
		const { task, flatIndex: fi } = input;
		const taskStartTime = Date.now();
		const statusStep = statusPayload.steps[fi];
		statusPayload.currentStep = fi;
		statusStep.status = "running";
		statusStep.error = undefined;
		statusStep.activityState = undefined;
		resetStepLiveDetail(statusStep);
		statusStep.startedAt = taskStartTime;
		if (input.resetTiming) {
			statusStep.endedAt = undefined;
			statusStep.durationMs = undefined;
		}
		statusStep.lastActivityAt = taskStartTime;
		statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
		statusPayload.lastActivityAt = taskStartTime;
		statusPayload.lastUpdate = taskStartTime;
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent }));

		const singleResult = await runSingleStep({ ...task, task: renderTask(task.task, input.item) }, {
			cwd: input.taskCwd, sessionEnabled,
			sessionDir: input.sessionDir,
			artifactsDir, id,
			flatIndex: fi, flatStepCount: input.flatStepCount,
			outputFile: path.join(asyncDir, `output-${fi}.log`),
			childIntercomTarget: config.childIntercomTargets?.[fi],
			orchestratorIntercomTarget: config.childIntercomTargets?.[fi] ? config.controlIntercomTarget : undefined,
			nestedRoute: config.nestedRoute,
			projectTrust: config.projectTrust,
			signal: cancellation.signal,
			interruptSignal: input.interruptSignal,
			registerInterrupt: (interrupt) => {
				if (interrupt) activeChildInterrupts.set(fi, interrupt);
				else activeChildInterrupts.delete(fi);
			},
			onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
			onChildEvent: (event) => updateStepFromChildEvent(fi, event),
		});
		activeChildInterrupts.delete(fi);
		if (input.trackSession && task.sessionFile) latestSessionFile = task.sessionFile;

		const taskEndTime = Date.now();
		statusStep.status = singleResult.interrupted ? "paused" : singleResult.exitCode === 0 ? singleResult.acceptance?.status === "blocked" ? "blocked" : "complete" : "failed";
		clearStepCurrentActivity(statusStep);
		statusStep.endedAt = taskEndTime;
		statusStep.durationMs = taskEndTime - taskStartTime;
		statusStep.exitCode = singleResult.exitCode;
		statusStep.agentProcessExit = singleResult.agentProcessExit;
		statusStep.model = singleResult.model;
		statusStep.thinking = resolveEffectiveThinking(singleResult.model, statusStep.thinking);
		statusStep.attemptedModels = singleResult.attemptedModels;
		statusStep.modelAttempts = singleResult.modelAttempts;
		statusStep.error = singleResult.error;
		statusStep.structuredOutput = singleResult.structuredOutput;
		statusStep.structuredOutputPath = singleResult.structuredOutputPath;
		statusStep.structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
		statusStep.acceptance = singleResult.acceptance;
		statusStep.resourceLimitExceeded = singleResult.resourceLimitExceeded;
		statusPayload.lastUpdate = taskEndTime;
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: singleResult.interrupted ? "subagent.step.paused" : singleResult.exitCode !== 0 ? "subagent.step.failed" : singleResult.acceptance?.status === "blocked" ? "subagent.step.blocked" : "subagent.step.completed",
			ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
			exitCode: singleResult.exitCode, durationMs: taskEndTime - taskStartTime,
			interrupted: singleResult.interrupted, agentProcessExit: singleResult.agentProcessExit,
			resourceLimitExceeded: singleResult.resourceLimitExceeded,
		}));
		if (input.notifyCompletionGuard && singleResult.completionGuardTriggered) {
			appendControlEvent(buildControlEvent({
				from: statusStep.activityState,
				to: "needs_attention",
				runId: id,
				agent: task.agent,
				index: fi,
				ts: taskEndTime,
				message: `${task.agent} completed without making edits for an implementation task`,
				reason: "completion_guard",
			}));
		}
		return { ...singleResult, skipped: false };
	};

	let flatIndex = 0;
	let workflowComplete = false;

	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		if (interrupted || cancellation.signal.aborted) break;
		const step = steps[stepIndex];

		if (isDynamicRunnerGroup(step)) {
			const groupStartFlatIndex = flatIndex;
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step, outputs, stepIndex, { maxItems: config.dynamicFanoutMaxItems, allowRunnerFields: true });
			} catch (error) {
				const now = Date.now();
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				statusPayload.state = "failed";
				statusPayload.error = message;
				statusPayload.currentStep = flatIndex;
				const placeholder = statusPayload.steps[groupStartFlatIndex];
				if (placeholder) {
					placeholder.status = "failed";
					placeholder.error = message;
					placeholder.startedAt = now;
					placeholder.endedAt = now;
					placeholder.durationMs = 0;
					placeholder.exitCode = 1;
				}
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "failed", message);
				writeStatusPayload();
				results.push({ agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1 });
				break;
			}

			const dynamicSteps = materialized.parallel.map((task, itemIndex) => materializeDynamicOutputPath({
				step: {
					...step.parallel,
					label: task.label ?? step.parallel.label,
					sessionFile: step.sessionFiles?.[itemIndex],
					structuredOutput: undefined,
					structuredOutputSchema: step.parallel.structuredOutputSchema ?? step.parallel.structuredOutput?.schema,
				},
				chainDir: config.chainDir ?? cwd,
				stepIndex,
				taskIndex: itemIndex,
			}));
			const duplicateOutputError = findDuplicateOutputPath(dynamicSteps);
			if (duplicateOutputError) {
				const now = Date.now();
				statusPayload.state = "failed";
				statusPayload.error = duplicateOutputError;
				statusPayload.currentStep = flatIndex;
				const placeholderStep = statusPayload.steps[groupStartFlatIndex];
				if (placeholderStep) {
					placeholderStep.status = "failed";
					placeholderStep.error = duplicateOutputError;
					placeholderStep.startedAt = now;
					placeholderStep.endedAt = now;
					placeholderStep.durationMs = 0;
					placeholderStep.exitCode = 1;
				}
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "failed", duplicateOutputError);
				writeStatusPayload();
				results.push({ agent: step.parallel.agent, output: duplicateOutputError, error: duplicateOutputError, success: false, exitCode: 1 });
				break;
			}
			const dynamicStatusSteps: RunnerStatusStep[] = dynamicSteps.map((task) => ({
					agent: task.agent,
					phase: task.phase ?? step.phase,
					label: task.label,
					outputName: undefined,
					structured: Boolean(task.structuredOutputSchema),
					status: "pending",
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					recentTools: [],
					recentOutput: [],
				}));
			const previousChildIntercomTargets = config.childIntercomTargets;
			statusPayload.steps.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps);
			if (previousChildIntercomTargets) {
				const dynamicGroupUsesIntercom = previousChildIntercomTargets[groupStartFlatIndex] !== undefined;
				config.childIntercomTargets = statusPayload.steps.map((statusStep, index) => {
					if (index >= groupStartFlatIndex && index < groupStartFlatIndex + dynamicStatusSteps.length) {
						return dynamicGroupUsesIntercom ? resolveSubagentIntercomTarget(id, statusStep.agent, index) : undefined;
					}
					const previousIndex = index < groupStartFlatIndex ? index : index - (dynamicStatusSteps.length - 1);
					return previousChildIntercomTargets[previousIndex] !== undefined
						? resolveSubagentIntercomTarget(id, statusStep.agent, index)
						: undefined;
				});
			}
			mutatingFailureStates.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => createMutatingFailureState()));
			mutationTrackers.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => createMutationCompletionTracker()));
			const materializedDelta = dynamicStatusSteps.length - 1;
			for (const group of statusPayload.parallelGroups) {
				if (group.stepIndex === stepIndex) {
					group.start = groupStartFlatIndex;
					group.count = dynamicStatusSteps.length;
				} else if (group.stepIndex > stepIndex) {
					group.start += materializedDelta;
				}
			}
			if (statusPayload.workflowGraph) {
				const shiftFlatIndexes = (nodes: NonNullable<typeof statusPayload.workflowGraph>["nodes"]): void => {
					for (const node of nodes) {
						if (node.stepIndex !== undefined && node.stepIndex > stepIndex && node.flatIndex !== undefined && node.flatIndex >= groupStartFlatIndex) {
							node.flatIndex += dynamicStatusSteps.length;
						}
						if (node.children) shiftFlatIndexes(node.children);
					}
				};
				shiftFlatIndexes(statusPayload.workflowGraph.nodes);
				const groupNode = statusPayload.workflowGraph.nodes.find((node) => node.id === `step-${stepIndex}`);
				if (groupNode) {
					groupNode.children = materialized.items.map((item, itemIndex) => ({
						id: `step-${stepIndex}-item-${item.idKey}`,
						kind: "agent",
						agent: step.parallel.agent,
						phase: dynamicSteps[itemIndex]?.phase ?? step.phase,
						label: dynamicSteps[itemIndex]?.label?.trim() || `${step.parallel.agent} ${item.key}`,
						status: "pending",
						flatIndex: groupStartFlatIndex + itemIndex,
						stepIndex,
						itemKey: item.key,
						structured: Boolean(dynamicSteps[itemIndex]?.structuredOutputSchema),
					}));
				}
			}
			writeStatusPayload();

			const parallelResults = await runParallelTasks<SubagentStep, AsyncParallelStepResult>({
				tasks: dynamicSteps,
				concurrency: step.concurrency ?? MAX_PARALLEL_CONCURRENCY,
				failFast: step.failFast,
				signal: cancellation.signal,
				interruptSignal: interruption.signal,
				stoppedTask: (task, index, reason) => stoppedParallelChild(task, groupStartFlatIndex + index, reason),
				runTask: (task, taskIdx, failFastSignal) => runParallelChild({
					task,
					flatIndex: groupStartFlatIndex + taskIdx,
					interruptSignal: failFastSignal,
					item: { name: step.expand.item ?? "item", value: materialized.items[taskIdx]!.item },
					taskCwd: cwd,
					sessionDir: config.sessionDir ? path.join(config.sessionDir, `dynamic-${stepIndex}-${taskIdx}`) : undefined,
					flatStepCount: Math.max(statusPayload.steps.length, 1),
				}),
			});

			flatIndex += dynamicSteps.length;
			for (const pr of parallelResults) {
				results.push({
					agent: pr.agent,
					output: pr.output,
					error: pr.error,
					success: workflowChildSucceeded(pr),
					exitCode: pr.exitCode,
					skipped: pr.skipped,
					sessionFile: pr.sessionFile,
					intercomTarget: pr.intercomTarget,
					model: pr.model,
					attemptedModels: pr.attemptedModels,
					modelAttempts: pr.modelAttempts,
					artifactPaths: pr.artifactPaths,
					structuredOutput: pr.structuredOutput,
					structuredOutputPath: pr.structuredOutputPath,
					structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
					acceptance: pr.acceptance,
					resourceLimitExceeded: pr.resourceLimitExceeded,
					interrupted: pr.interrupted,
					agentProcessExit: pr.agentProcessExit,
				});
			}
			const completion = completeWorkflowStep({ stepIndex, stepCount: steps.length, results: parallelResults, previousOutput, dynamic: { step, items: materialized.items } });
			Object.assign(outputs, completion.outputs);
			statusPayload.outputs = outputs;
			if (completion.error) {
				results.push({ agent: step.parallel.agent, output: completion.error, error: completion.error, success: false, exitCode: 1, structuredOutput: completion.collection });
				statusPayload.error = completion.error;
			}
			previousOutput = completion.previousOutput;
			workflowComplete = completion.complete;
			const error = completion.error ?? parallelResults[completion.failedIndices[0]]?.error;
			markDynamicGraphGroup(stepIndex, completion.status === "completed" ? "completed" : completion.status === "blocked" ? "blocked" : completion.status === "paused" ? "paused" : "failed", error);
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.dynamic.completed",
				ts: Date.now(),
				runId: id,
				stepIndex,
				success: completion.advance,
				state: completion.status === "completed" ? "complete" : completion.status,
			}));
			statusPayload.lastUpdate = Date.now();
			writeStatusPayload();
			if (!completion.advance) break;
			continue;
		}

		if (isParallelGroup(step)) {
			const group = step;
			const groupCwd = group.cwd ?? cwd;
			const groupStartFlatIndex = flatIndex;
			let worktreeSetup: WorktreeSetup | undefined;
			if (group.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(group.parallel, groupCwd);
				if (worktreeTaskCwdConflict) {
					const failedAt = Date.now();
					markParallelGroupSetupFailure({
						statusPayload,
						results,
						group,
						groupStartFlatIndex,
						setupError: formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, groupCwd),
						failedAt,
						statusPath,
						eventsPath,
						asyncDir,
						runId: id,
						stepIndex,
					});
					flatIndex += group.parallel.length;
					break;
				}
				try {
					worktreeSetup = createWorktrees(groupCwd, `${id}-s${stepIndex}`, group.parallel.length, {
						agents: group.parallel.map((task) => task.agent),
						setupHook: config.worktreeSetupHook
							? { hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs }
							: undefined,
					});
				} catch (error) {
					const setupError = error instanceof Error ? error.message : String(error);
					const failedAt = Date.now();
					markParallelGroupSetupFailure({
						statusPayload,
						results,
						group,
						groupStartFlatIndex,
						setupError,
						failedAt,
						statusPath,
						eventsPath,
						asyncDir,
						runId: id,
						stepIndex,
					});
					flatIndex += group.parallel.length;
					break;
				}
			}

			try {
				if (group.worktree) ensureParallelProgressFile(groupCwd, group);
				const groupStartTime = Date.now();
				markParallelGroupRunning({
					statusPayload,
					group,
					groupStartFlatIndex,
					groupStartTime,
					statusPath,
					eventsPath,
					asyncDir,
					runId: id,
					stepIndex,
				});
				const parallelResults = await runParallelTasks<SubagentStep, AsyncParallelStepResult>({
					tasks: group.parallel,
					concurrency: group.concurrency ?? MAX_PARALLEL_CONCURRENCY,
					failFast: group.failFast,
					signal: cancellation.signal,
					interruptSignal: interruption.signal,
					stoppedTask: (task, index, reason) => stoppedParallelChild(task, groupStartFlatIndex + index, reason),
					runTask: (task, taskIdx, failFastSignal) => {
						const { taskForRun, taskCwd } = prepareParallelTaskRun(task, groupCwd, worktreeSetup, taskIdx);
						return runParallelChild({
							task: taskForRun,
							flatIndex: groupStartFlatIndex + taskIdx,
							interruptSignal: failFastSignal,
							taskCwd,
							sessionDir: config.sessionDir ? path.join(config.sessionDir, `parallel-${taskIdx}`) : undefined,
							flatStepCount: flatSteps.length,
							resetTiming: true,
							trackSession: true,
							notifyCompletionGuard: true,
						});
					},
				});

				flatIndex += group.parallel.length;

				for (let t = 0; t < group.parallel.length; t++) {
					const fi = groupStartFlatIndex + t;
					const sessionTokens = config.sessionDir
						? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
						: null;
					const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
					if (!taskTokens) continue;
					statusPayload.steps[fi].tokens = taskTokens;
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + taskTokens.input,
						output: previousCumulativeTokens.output + taskTokens.output,
						total: previousCumulativeTokens.total + taskTokens.total,
					};
				}
				statusPayload.totalTokens = { ...previousCumulativeTokens };
				statusPayload.lastUpdate = Date.now();
				writeStatusPayload();

				for (const pr of parallelResults) {
					results.push({
						agent: pr.agent,
						output: pr.output,
						error: pr.error,
						success: workflowChildSucceeded(pr),
						exitCode: pr.exitCode,
						skipped: pr.skipped,
						sessionFile: pr.sessionFile,
						intercomTarget: pr.intercomTarget,
						model: pr.model,
						attemptedModels: pr.attemptedModels,
						modelAttempts: pr.modelAttempts,
						artifactPaths: pr.artifactPaths,
							structuredOutput: pr.structuredOutput,
							structuredOutputPath: pr.structuredOutputPath,
							structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
							acceptance: pr.acceptance,
							resourceLimitExceeded: pr.resourceLimitExceeded,
							interrupted: pr.interrupted,
							agentProcessExit: pr.agentProcessExit,
						});
					}
				const completion = completeWorkflowStep({
					stepIndex, stepCount: steps.length, results: parallelResults, previousOutput, parallel: true,
					outputNames: group.parallel.map((task) => task.outputName),
				});
				Object.assign(outputs, completion.outputs);
				statusPayload.outputs = outputs;
				const worktreeSummary = formatRunnerWorktreeSummary(worktreeSetup, asyncDir, stepIndex, group);
				previousOutput = completion.advance ? appendWorktreeSummary(completion.previousOutput, worktreeSummary) : completion.previousOutput;
				workflowComplete = completion.complete;
				if (worktreeSummary) worktreeSummaries.push(worktreeSummary);
				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.parallel.completed",
					ts: Date.now(),
					runId: id,
					stepIndex,
					success: completion.advance,
					state: completion.status === "completed" ? "complete" : completion.status,
				}));
				writeStatusPayload();
				if (!completion.advance) break;
			} finally {
				if (worktreeSetup) cleanupWorktrees(worktreeSetup);
			}
		} else {
			const seqStep = step as SubagentStep;
			const stepStartTime = Date.now();
			statusPayload.currentStep = flatIndex;
			statusPayload.steps[flatIndex].status = "running";
			statusPayload.steps[flatIndex].activityState = undefined;
			statusPayload.activityState = undefined;
			resetStepLiveDetail(statusPayload.steps[flatIndex]);
			statusPayload.steps[flatIndex].skills = seqStep.skills;
			statusPayload.steps[flatIndex].startedAt = stepStartTime;
			statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
			statusPayload.lastActivityAt = stepStartTime;
			statusPayload.lastUpdate = stepStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
			writeStatusPayload();

			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.step.started",
				ts: stepStartTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
			}));

			const singleResult = await runSingleStep({ ...seqStep, task: renderTask(seqStep.task) }, {
				cwd, sessionEnabled,
				sessionDir: config.sessionDir,
				artifactsDir, id,
				flatIndex, flatStepCount: flatSteps.length,
				outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
				childIntercomTarget: config.childIntercomTargets?.[flatIndex],
				orchestratorIntercomTarget: config.childIntercomTargets?.[flatIndex] ? config.controlIntercomTarget : undefined,
				nestedRoute: config.nestedRoute,
				projectTrust: config.projectTrust,
				signal: cancellation.signal,
				registerInterrupt: (interrupt) => {
					if (interrupt) activeChildInterrupts.set(flatIndex, interrupt);
					else activeChildInterrupts.delete(flatIndex);
				},
				onAttemptStart: (attempt) => updateStepModel(flatIndex, attempt.model, attempt.thinking),
				onChildEvent: (event) => updateStepFromChildEvent(flatIndex, event),
			});
			activeChildInterrupts.delete(flatIndex);
			if (seqStep.sessionFile) {
				latestSessionFile = seqStep.sessionFile;
			}

			const completion = completeWorkflowStep({ stepIndex, stepCount: steps.length, results: [singleResult], previousOutput, outputNames: [seqStep.outputName] });
			previousOutput = completion.previousOutput;
			workflowComplete = completion.complete;
			results.push({
				agent: singleResult.agent,
				output: singleResult.output,
				error: singleResult.error,
				success: workflowChildSucceeded(singleResult),
				exitCode: singleResult.exitCode,
				sessionFile: singleResult.sessionFile,
				intercomTarget: singleResult.intercomTarget,
				model: singleResult.model,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				artifactPaths: singleResult.artifactPaths,
				structuredOutput: singleResult.structuredOutput,
				structuredOutputPath: singleResult.structuredOutputPath,
				structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
				acceptance: singleResult.acceptance,
				resourceLimitExceeded: singleResult.resourceLimitExceeded,
				interrupted: singleResult.interrupted, agentProcessExit: singleResult.agentProcessExit,
			});
			Object.assign(outputs, completion.outputs);
			statusPayload.outputs = outputs;

			const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
			let stepTokens: TokenUsage | null = cumulativeTokens
				? {
						input: cumulativeTokens.input - previousCumulativeTokens.input,
						output: cumulativeTokens.output - previousCumulativeTokens.output,
						total: cumulativeTokens.total - previousCumulativeTokens.total,
					}
				: null;
			if (cumulativeTokens) {
				previousCumulativeTokens = cumulativeTokens;
			} else {
				stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
				if (stepTokens) {
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + stepTokens.input,
						output: previousCumulativeTokens.output + stepTokens.output,
						total: previousCumulativeTokens.total + stepTokens.total,
					};
				}
			}

			const stepEndTime = Date.now();
			statusPayload.steps[flatIndex].status = singleResult.interrupted ? "paused" : singleResult.exitCode === 0 ? singleResult.acceptance?.status === "blocked" ? "blocked" : "complete" : "failed";
			clearStepCurrentActivity(statusPayload.steps[flatIndex]);
			statusPayload.steps[flatIndex].endedAt = stepEndTime;
			statusPayload.steps[flatIndex].durationMs = stepEndTime - stepStartTime;
			statusPayload.steps[flatIndex].exitCode = singleResult.exitCode;
			statusPayload.steps[flatIndex].agentProcessExit = singleResult.agentProcessExit;
			statusPayload.steps[flatIndex].model = singleResult.model;
			statusPayload.steps[flatIndex].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[flatIndex].thinking);
			statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
			statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
			statusPayload.steps[flatIndex].error = singleResult.error;
			statusPayload.steps[flatIndex].structuredOutput = singleResult.structuredOutput;
			statusPayload.steps[flatIndex].structuredOutputPath = singleResult.structuredOutputPath;
			statusPayload.steps[flatIndex].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
			statusPayload.steps[flatIndex].acceptance = singleResult.acceptance;
			statusPayload.steps[flatIndex].resourceLimitExceeded = singleResult.resourceLimitExceeded;
			if (stepTokens) {
				statusPayload.steps[flatIndex].tokens = stepTokens;
				statusPayload.totalTokens = { ...previousCumulativeTokens };
			}
			statusPayload.lastUpdate = stepEndTime;
			writeStatusPayload();

			appendJsonl(eventsPath, JSON.stringify({
				type: singleResult.interrupted ? "subagent.step.paused" : singleResult.exitCode !== 0 ? "subagent.step.failed" : singleResult.acceptance?.status === "blocked" ? "subagent.step.blocked" : "subagent.step.completed",
				ts: stepEndTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
				exitCode: singleResult.exitCode,
				durationMs: stepEndTime - stepStartTime,
				interrupted: singleResult.interrupted, agentProcessExit: singleResult.agentProcessExit,
				tokens: stepTokens,
				resourceLimitExceeded: singleResult.resourceLimitExceeded,
			}));
			if (singleResult.completionGuardTriggered) {
				const event = buildControlEvent({
					from: statusPayload.steps[flatIndex].activityState,
					to: "needs_attention",
					runId: id,
					agent: seqStep.agent,
					index: flatIndex,
					ts: stepEndTime,
					message: `${seqStep.agent} completed without making edits for an implementation task`,
					reason: "completion_guard",
				});
				appendControlEvent(event);
			}

			flatIndex++;
			if (!completion.advance) break;
		}
	}

	let summary = results.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");
	if (worktreeSummaries.length > 0) summary = appendWorktreeSummary(summary, worktreeSummaries.join("\n\n"));
	let truncated = false;

	const outputLimits = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
	const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
	const truncResult = truncateOutput(summary, outputLimits, lastArtifactPath);
	if (truncResult.truncated) {
		summary = truncResult.text;
		truncated = true;
	}

	const resultMode = config.resultMode ?? statusPayload.mode;
	const agentName = flatSteps.length === 1
		? flatSteps[0].agent
		: resultMode === "parallel"
			? `parallel:${flatSteps.map((s) => s.agent).join("+")}`
			: `chain:${flatSteps.map((s) => s.agent).join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (shareEnabled) {
		sessionFile = config.sessionDir
			? (findLatestSessionFile(config.sessionDir) ?? undefined)
			: undefined;
		if (!sessionFile && latestSessionFile) {
			sessionFile = latestSessionFile;
		}
		if (sessionFile) {
			try {
				const exportDir = config.sessionDir ?? path.dirname(sessionFile);
				const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
				const share = createShareLink(htmlPath);
				if ("error" in share) shareError = share.error;
				else {
					shareUrl = share.shareUrl;
					gistUrl = share.gistUrl;
				}
			} catch (err) {
				shareError = String(err);
			}
		} else {
			shareError = "Session file not found.";
		}
	}

	if (activityTimer) {
		clearInterval(activityTimer);
		activityTimer = undefined;
	}
	if (controlRequestTimer) {
		clearInterval(controlRequestTimer);
		controlRequestTimer = undefined;
	}
	process.off(ASYNC_INTERRUPT_SIGNAL, interruptRunner);
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(signal, cancelRunner);
	const effectiveSessionFile = sessionFile ?? latestSessionFile ?? undefined;
	const runEndedAt = Date.now();
	if (interrupted) {
		for (let index = 0; index < statusPayload.steps.length; index++) {
			const step = statusPayload.steps[index]!;
			if (step.status !== "pending") continue;
			markStepPaused(step, runEndedAt);
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.step.paused",
				ts: runEndedAt,
				runId: id,
				stepIndex: index,
				agent: step.agent,
				interrupted: true,
				durationMs: 0,
			}));
		}
	}
	const hasFailedSteps = statusPayload.steps.some((step) => step.status === "failed");
	const hasPausedSteps = statusPayload.steps.some((step) => step.status === "paused");
	const finalRunState: AsyncStatus["state"] = hasFailedSteps || statusPayload.error || cancellation.signal.aborted ? "failed"
		: statusPayload.steps.some((step) => step.status === "blocked") ? "blocked"
		: interrupted || hasPausedSteps ? "paused" : workflowComplete ? "complete" : "failed";
	statusPayload.state = finalRunState;
	statusPayload.activityState = undefined;
	statusPayload.currentTool = undefined;
	statusPayload.currentToolStartedAt = undefined;
	statusPayload.currentPath = undefined;
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	statusPayload.sessionFile = effectiveSessionFile;
	statusPayload.shareUrl = shareUrl;
	statusPayload.gistUrl = gistUrl;
	statusPayload.shareError = shareError;
	if (statusPayload.state === "failed" && !statusPayload.error) {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		} else if (cancellation.signal.aborted) {
			statusPayload.error = "Subagent cancelled.";
		}
	}
	writeStatusPayload();
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.completed",
			ts: runEndedAt,
			runId: id,
			status: statusPayload.state,
			durationMs: runEndedAt - overallStartTime,
		}),
	);
	writeRunLog(logPath, {
		id,
		mode: statusPayload.mode,
		cwd,
		startedAt: overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			durationMs: step.durationMs,
		})),
		summary,
		truncated,
		artifactsDir,
		sessionFile: effectiveSessionFile,
		shareUrl,
		shareError,
	});

	try {
		const resultData: AsyncResultFile = {
			id,
			agent: agentName,
			mode: resultMode,
			success: finalRunState === "complete",
			state: finalRunState,
			summary: finalRunState === "blocked" ? `Needs your action — acceptance incomplete.\n${results.map((result) => acceptanceHumanAction(result.acceptance)).filter(Boolean).join("\n")}` : finalRunState === "paused" ? "Paused after interrupt. Waiting for explicit next action." : summary,
			results: results.map((r) => {
				const childOutput = truncateOutput(r.output, outputLimits, r.artifactPaths?.outputPath);
				return {
					agent: r.agent,
					output: childOutput.text,
					exitCode: r.exitCode,
					error: r.error,
					success: r.success,
					skipped: r.skipped || undefined,
					sessionFile: r.sessionFile,
					intercomTarget: r.intercomTarget,
					model: r.model,
					attemptedModels: r.attemptedModels,
					modelAttempts: r.modelAttempts,
					artifactPaths: r.artifactPaths,
					truncated: r.truncated || childOutput.truncated || undefined,
					structuredOutput: r.structuredOutput,
					structuredOutputPath: r.structuredOutputPath,
					structuredOutputSchemaPath: r.structuredOutputSchemaPath,
					acceptance: r.acceptance,
					resourceLimitExceeded: r.resourceLimitExceeded,
					interrupted: r.interrupted,
					agentProcessExit: r.agentProcessExit,
				};
			}),
			outputs,
			workflowGraph: statusPayload.workflowGraph,
			exitCode: finalRunState === "failed" ? 1 : 0,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			sessionId: config.sessionId ?? undefined,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			shareUrl,
			gistUrl,
			shareError,
			...(taskIndex !== undefined && { taskIndex }),
			...(totalTasks !== undefined && { totalTasks }),
		};
		saveAsyncRunResult(id, { ...resultData, results });
		writeAtomicJson(resultPath, resultData);
	} catch (err) {
		console.error(`Failed to write result file ${resultPath}:`, err);
	}
}

const configArg = process.argv[2];
if (configArg) {
	try {
		const configJson = fs.readFileSync(configArg, "utf-8");
		const config = JSON.parse(configJson) as SubagentRunConfig;
		try {
			fs.unlinkSync(configArg);
		} catch {
			// Temp config cleanup is best effort.
		}
		runSubagent(config).catch((runErr) => {
			console.error("Subagent runner error:", runErr);
			process.exit(1);
		});
	} catch (err) {
		console.error("Subagent runner error:", err);
		process.exit(1);
	}
} else {
	let input = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
	});
	process.stdin.on("end", () => {
		try {
			const config = JSON.parse(input) as SubagentRunConfig;
			runSubagent(config).catch((runErr) => {
				console.error("Subagent runner error:", runErr);
				process.exit(1);
			});
		} catch (err) {
			console.error("Subagent runner error:", err);
			process.exit(1);
		}
	});
}
