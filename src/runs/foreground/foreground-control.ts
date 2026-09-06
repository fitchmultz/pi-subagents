import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { listSupervisorQuestions, questionProcessAlive, readNativeSessionConfiguration, readQuestionContract, recordQuestionDelivery, saveQuestionOwner, type SupervisorQuestionView, type SupervisorRunContract } from "../shared/supervisor-questions.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentScope } from "../../agents/agents.ts";
import { splitKnownThinkingSuffix, toModelInfo } from "../../shared/model-info.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { executeAsyncSingle, formatAsyncStartedMessage } from "../background/async-execution.ts";
import { resolveConfiguredChildProjectTrustPolicy } from "../shared/pi-args.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge, resolveIntercomSessionTarget, resolveOrchestratorIntercomTarget, resolveSubagentIntercomTarget, type IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "../shared/subagent-control.ts";
import { getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	deliverSubagentIntercomMessageEvent,
	deliverSubagentResultIntercomEvent,
	formatSubagentResultReceipt,
	resolveSubagentResultStatus,
	stripDetailsOutputsForIntercomReceipt,
} from "../../intercom/result-intercom.ts";
import { sendLiveSubagentMessage } from "../../intercom/live-intercom.ts";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget } from "../background/async-resume.ts";
import { readNestedControlResults, resolveInheritedNestedRouteFromEnv, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, updateForegroundNestedProjection, writeNestedControlRequest, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { buildManagementControl, formatLiveIntercomActionLines } from "../../shared/status-format.ts";
import { acceptanceInputFromResolved } from "../shared/acceptance.ts";
import { ownedRunStatusResult, ownedRunView, rememberOwnedRun, resolveOwnedRun, saveForegroundRun } from "../shared/run-records.ts";
import {
	ASYNC_DIR,
	getAsyncConfigPath,
	RUNNER_ERROR_LOG_FILE,
	type ControlEvent,
	type Details,
	type SubagentExecutionResult,
	type SubagentLiveIntercomHealth,
	type ForegroundControlState,
	type ForegroundResumeRun,
	type IntercomEventBus,
	type NestedRunSummary,
	type ResolvedAcceptanceConfig,
	type ResolvedControlConfig,
	type SingleResult,
	type SubagentRunMode,
	type SubagentState,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	checkSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../../shared/types.ts";

import {
	type ExecutionContextData,
	type ExecutorDeps,
	type SubagentParamsLike,
} from "./subagent-params.ts";

const ASYNC_CONTROL_REQUEST_FILE = "control-request.json";
export const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete"]);

export function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

export function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: ForegroundControlState | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

function formatForegroundActivity(control: ForegroundControlState): string | undefined {
	const facts: string[] = [];
	if (control.currentTool && control.currentToolStartedAt) facts.push(`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`);
	else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
	if (control.currentPath) facts.push(`path ${control.currentPath}`);
	if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
	if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
	if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
	if (!control.lastActivityAt) {
		if (control.currentActivityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	if (control.currentActivityState === "needs_attention") return [`no activity for ${seconds}s`, ...facts].join(" | ");
	return [`active ${seconds}s ago`, ...facts].join(" | ");
}

export function nestedResolutionScopeForExecutor(deps: ExecutorDeps): NestedRunResolutionScope | undefined {
	if (deps.allowMutatingManagementActions !== false) return undefined;
	const route = resolveInheritedNestedRouteFromEnv();
	const address = route ? resolveNestedParentAddressFromEnv() : undefined;
	return {
		routes: route ? [route] : [],
		...(address ? { descendantOf: { parentRunId: address.parentRunId, ...(address.parentStepIndex !== undefined ? { parentStepIndex: address.parentStepIndex } : {}) } } : {}),
	};
}

export function foregroundIntercomTarget(control: ForegroundControlState): string | undefined {
	return control.currentAgent ? resolveSubagentIntercomTarget(control.runId, control.currentAgent, control.currentIndex ?? 0) : undefined;
}

export function foregroundStatusResult(control: ForegroundControlState, health?: SubagentLiveIntercomHealth): SubagentExecutionResult {
	let nestedWarning: string | undefined;
	try {
		updateForegroundNestedProjection(control);
	} catch (error) {
		nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	const activity = formatForegroundActivity(control);
	const intercomTarget = foregroundIntercomTarget(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
		(control.activeChildren?.size ?? 0) > 1
			? `Active: ${[...control.activeChildren!.entries()].map(([index, child]) => `${index}:${child.agent}`).join(", ")}`
			: undefined,
		activity ? `Activity: ${activity}` : undefined,
		control.timeoutAt ? `Timeout: ${new Date(control.timeoutAt).toISOString()}` : undefined,
		control.timeoutAt && control.extendTimeout ? `Extend: subagent({ action: "extend", id: "${control.runId}", extendMs: 300000 })` : undefined,
	].filter((line): line is string => Boolean(line));
	if (intercomTarget) lines.push(...formatLiveIntercomActionLines({ runId: control.runId, target: intercomTarget, index: control.currentIndex, health }));
	lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "", commandHints: true, maxLines: 20 }));
	if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			mode: "management", results: [],
			managementControl: buildManagementControl({ state: "live", runId: control.runId, index: control.currentIndex, intercomTarget, canNudge: true, canResume: true, canInterrupt: true, canExtend: Boolean(control.timeoutAt && control.extendTimeout) }),
		},
	};
}

export function extendForegroundTimeoutResult(control: ForegroundControlState, additionalMs: number): SubagentExecutionResult {
	if (!Number.isInteger(additionalMs) || additionalMs <= 0) {
		return {
			content: [{ type: "text", text: "action='extend' requires extendMs or timeoutMs to be a positive integer number of milliseconds." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!control.extendTimeout) {
		return {
			content: [{ type: "text", text: `Foreground run ${control.runId} does not currently have an extendable timeout.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const result = control.extendTimeout(additionalMs);
	if (!result.ok) {
		return {
			content: [{ type: "text", text: result.message }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	control.timeoutAt = result.timeoutAt;
	control.updatedAt = Date.now();
	return {
		content: [{ type: "text", text: `Extended foreground run ${control.runId} by ${additionalMs}ms.${result.timeoutAt ? ` New timeout: ${new Date(result.timeoutAt).toISOString()}.` : ""}` }],
		details: { mode: "management", results: [], managementControl: buildManagementControl({ state: "live", runId: control.runId, index: control.currentIndex, intercomTarget: foregroundIntercomTarget(control), canNudge: true, canResume: true, canInterrupt: true, canExtend: true }) },
	};
}

export function rememberForegroundRun(state: SubagentState, input: Parameters<typeof saveForegroundRun>[0]): void {
	(state.foregroundRuns ??= new Map()).set(input.runId, saveForegroundRun(input));
}

const LATEST_FOREGROUND_ALIASES = new Set(["last", "latest"]);

export function resolveRememberedForegroundRun(requested: string | undefined, state: SubagentState): ForegroundResumeRun | undefined {
	if (!requested || !state.foregroundRuns?.size) return undefined;
	const normalized = requested.trim();
	if (!normalized) return undefined;
	if (LATEST_FOREGROUND_ALIASES.has(normalized)) {
		return [...state.foregroundRuns.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0];
	}
	const direct = state.foregroundRuns.get(normalized);
	const matches = direct ? [direct] : [...state.foregroundRuns.values()].filter((run) => run.runId.startsWith(normalized));
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Ambiguous foreground run id prefix '${normalized}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`);
	return matches[0]!;
}

function foregroundResumeGuidance(run: ForegroundResumeRun): string {
	const childWithSession = run.children.find((child) => child.sessionFile && child.status !== "detached");
	if (!childWithSession && run.children.some((child) => child.status === "detached")) return `Completion unconfirmed. Check agent_runs({ action: "questions", id: "${run.runId}" }) before continuing.`;
	if (run.children.length === 1 && childWithSession) return `Revive: subagent({ action: "resume", id: "${run.runId}", message: "..." })`;
	if (!childWithSession) return "Revive: unavailable; no child session file was persisted.";
	return `Revive child: subagent({ action: "resume", id: "${run.runId}", index: ${childWithSession.index}, message: "..." })`;
}

function compactStatusText(value: string, maxLength = 240): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function foregroundResultChildren(run: ForegroundResumeRun) {
	return run.children.map((child) => ({ child, finalOutput: child.summary }));
}

function rememberedForegroundState(children: ReturnType<typeof foregroundResultChildren>): "completed" | "paused" | "failed" | "unknown" {
	if (children.some(({ child }) => child.status === "failed" || child.status === "timed-out")) return "failed";
	if (children.some(({ child }) => child.status === "paused")) return "paused";
	return children.some(({ child }) => child.status === "detached") ? "unknown" : "completed";
}

export function rememberedForegroundStatusResult(run: ForegroundResumeRun): SubagentExecutionResult {
	const children = foregroundResultChildren(run);
	const state = run.error ? "failed" : rememberedForegroundState(children);
	const resumable = children.find(({ child }) => child.sessionFile && child.status !== "detached")?.child;
	const lines = [
		`Run: ${run.runId}`,
		"State: remembered foreground",
		`Outcome: ${state}`,
		...(run.error ? [`Error: ${run.error}`] : []),
		`Mode: ${run.mode}`,
		`Updated: ${new Date(run.updatedAt).toISOString()}`,
		`Cwd: ${run.cwd}`,
		"Children:",
		...children.map(({ child, finalOutput }) => `  ${child.index + 1}. ${child.agent} ${child.status}${child.sessionFile ? `, session: ${child.sessionFile}` : ""}${child.artifactPath ? `, artifact: ${child.artifactPath}` : ""}${finalOutput ? `, final: ${compactStatusText(finalOutput)}` : ""}`),
		foregroundResumeGuidance(run),
		`Status: subagent({ action: "status", id: "${run.runId}" })`,
	];
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			mode: "management", results: [],
			managementControl: buildManagementControl({ state, runId: run.runId, index: resumable?.index, canResume: Boolean(resumable) }),
		},
	};
}

function resolveForegroundResumeTarget(params: SubagentParamsLike, state: SubagentState): { runId: string; mode: "single" | "parallel" | "chain"; state: "complete"; agent: string; index: number; intercomTarget: string; cwd: string; sessionFile: string; effectiveAcceptance?: ResolvedAcceptanceConfig } | undefined {
	const requested = (params.id ?? params.runId)?.trim();
	const run = resolveRememberedForegroundRun(requested, state);
	if (!run) return undefined;
	if (run.children.length > 1 && params.index === undefined) throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`);
	const index = params.index ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
	if (index < 0 || index >= run.children.length) throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`);
	const child = run.children[index]!;
	if (child.status === "detached") throw new Error(`Foreground run '${run.runId}' child ${index} is detached for intercom coordination and cannot be revived safely from the remembered foreground state. Reply to the supervisor request first; after the child exits, start a fresh follow-up if needed.`);
	if (!child.sessionFile) throw new Error(`Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`);
	if (path.extname(child.sessionFile) !== ".jsonl") throw new Error(`Foreground run '${run.runId}' child ${index} session file must be a .jsonl file: ${child.sessionFile}`);
	const sessionFile = path.resolve(child.sessionFile);
	if (!fs.existsSync(sessionFile)) throw new Error(`Foreground run '${run.runId}' child ${index} session file does not exist: ${child.sessionFile}`);
	return { runId: run.runId, mode: run.mode, state: "complete", agent: child.agent, index, intercomTarget: resolveSubagentIntercomTarget(run.runId, child.agent, index), cwd: run.cwd, sessionFile, effectiveAcceptance: child.effectiveAcceptance };
}

type AsyncResumeSourceTarget = ReturnType<typeof resolveAsyncResumeTarget> & { source: "async" };
type ForegroundResumeSourceTarget = NonNullable<ReturnType<typeof resolveForegroundResumeTarget>> & { kind: "revive"; source: "foreground" };
type NestedResumeSourceTarget = {
	kind: "revive";
	source: "nested";
	runId: string;
	state: "complete" | "failed" | "paused";
	agent: string;
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile: string;
	effectiveAcceptance?: ResolvedAcceptanceConfig;
};
type ResumeSourceTarget = AsyncResumeSourceTarget | ForegroundResumeSourceTarget | NestedResumeSourceTarget;

function isAsyncRunNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Async run not found.");
}

function isResumeAmbiguity(error: unknown): boolean {
	return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}

function resumeTargetExact(target: { runId: string } | undefined, requested: string): boolean {
	return target?.runId === requested;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactResumeError(error: unknown, source: "async" | "foreground", requested: string): boolean {
	if (!(error instanceof Error) || !requested) return false;
	return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}

function resolveResumeTarget(params: SubagentParamsLike, state: SubagentState): ResumeSourceTarget {
	const requested = (params.id ?? params.runId)?.trim() ?? "";
	let foregroundTarget: ForegroundResumeSourceTarget | undefined;
	let foregroundError: unknown;
	let asyncTarget: AsyncResumeSourceTarget | undefined;
	let asyncError: unknown;

	try {
		const target = resolveForegroundResumeTarget(params, state);
		if (target) foregroundTarget = { kind: "revive", source: "foreground", ...target };
	} catch (error) {
		foregroundError = error;
	}
	try {
		asyncTarget = { source: "async", ...resolveAsyncResumeTarget(params) };
	} catch (error) {
		asyncError = error;
	}

	if (foregroundTarget && asyncTarget) {
		const foregroundExact = resumeTargetExact(foregroundTarget, requested);
		const asyncExact = resumeTargetExact(asyncTarget, requested);
		if (foregroundExact && !asyncExact) return foregroundTarget;
		if (asyncExact && !foregroundExact) return asyncTarget;
		throw new Error(`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`);
	}
	if (foregroundTarget) {
		if (isExactResumeError(asyncError, "async", requested)) throw asyncError;
		if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested)) throw asyncError;
		return foregroundTarget;
	}
	if (asyncTarget) {
		if (isExactResumeError(foregroundError, "foreground", requested)) throw foregroundError;
		if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested)) throw foregroundError;
		return asyncTarget;
	}
	if (foregroundError && !isAsyncRunNotFound(asyncError)) throw foregroundError;
	if (foregroundError) throw foregroundError;
	if (asyncError) throw asyncError;
	throw new Error("Run not found. Provide id or runId.");
}

function getAsyncInterruptTarget(state: SubagentState, runId: string | undefined): { asyncId: string; asyncDir: string } | undefined {
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		return direct ? { asyncId: direct.asyncId, asyncDir: direct.asyncDir } : undefined;
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index);
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
	}
	if (input.controlConfig.notifyChannels.includes("intercom")) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

export function writeAsyncInterruptRequest(asyncDir: string, runId: string): void {
	writeAtomicJson(path.join(asyncDir, ASYNC_CONTROL_REQUEST_FILE), {
		requestId: randomUUID(),
		runId,
		action: "interrupt",
		createdAt: Date.now(),
	});
}

export function interruptAsyncRun(state: SubagentState, runId: string | undefined): SubagentExecutionResult | null {
	const target = getAsyncInterruptTarget(state, runId);
	if (!target) return null;
	const status = readStatus(target.asyncDir);
	if (!status || status.runId !== target.asyncId || status.state !== "running") {
		return {
			content: [{ type: "text", text: `No running async run with a matching control channel was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	try {
		writeAsyncInterruptRequest(target.asyncDir, target.asyncId);
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return {
			content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [], managementControl: buildManagementControl({ state: "live", runId: target.asyncId }) },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

function nestedRunSessionFile(run: NestedRunSummary): string | undefined {
	return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}

function nestedRunAgent(run: NestedRunSummary): string | undefined {
	return run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined);
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function validateNestedSessionFile(run: NestedRunSummary, trustedSessionRoots: string[]): string {
	const sessionFile = nestedRunSessionFile(run);
	if (!sessionFile) throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!path.isAbsolute(sessionFile)) throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
	if (!fs.existsSync(resolved)) throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
	const realSessionFile = fs.realpathSync(resolved);
	const trustedRoots = trustedSessionRoots
		.filter((root) => fs.existsSync(root))
		.map((root) => fs.realpathSync(root));
	if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
		throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
	}
	if (!realSessionFile.split(path.sep).includes(run.id)) {
		throw new Error(`Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`);
	}
	return realSessionFile;
}

function resolveNestedResumeTarget(match: ResolvedSubagentRunId & { kind: "nested" }, trustedSessionRoots: string[]): NestedResumeSourceTarget {
	const run = match.match.run;
	if (run.state === "running" || run.state === "queued") throw new Error(`Nested run '${run.id}' is live; route the follow-up to the owner process instead.`);
	const agent = nestedRunAgent(run);
	if (!agent) throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
	const state = run.state === "complete" || run.state === "failed" || run.state === "paused" ? run.state : "failed";
	const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
	const effectiveAcceptance = asyncDir ? readStatus(asyncDir)?.steps?.[0]?.acceptance?.effectiveAcceptance : undefined;
	return {
		kind: "revive",
		source: "nested",
		runId: run.id,
		state,
		agent,
		index: 0,
		intercomTarget: resolveSubagentIntercomTarget(run.id, agent, 0),
		cwd: asyncDir ? path.dirname(asyncDir) : undefined,
		sessionFile: validateNestedSessionFile(run, trustedSessionRoots),
		effectiveAcceptance,
	};
}

async function waitForNestedControlResult(target: ResolvedSubagentRunId & { kind: "nested" }, requestId: string, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = readNestedControlResults(target.match.route).find((candidate) => candidate.requestId === requestId && candidate.targetRunId === target.match.run.id);
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return undefined;
}

async function sendNestedControlRequest(target: ResolvedSubagentRunId & { kind: "nested" }, action: "interrupt" | "resume", message?: string) {
	const requestId = randomUUID();
	const targetChildIndex = target.match.run.path?.[0]?.stepIndex ?? target.match.run.parentStepIndex;
	writeNestedControlRequest(target.match.route, {
		ts: Date.now(),
		requestId,
		targetRunId: target.match.run.id,
		...(targetChildIndex !== undefined ? { targetChildIndex } : {}),
		action,
		...(message ? { message } : {}),
	});
	return waitForNestedControlResult(target, requestId);
}

function directNestedAsyncInterrupt(target: ResolvedSubagentRunId & { kind: "nested" }): SubagentExecutionResult | undefined {
	const run = target.match.run;
	const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const status = readStatus(asyncDir);
	if (!status || status.runId !== run.id || status.state !== "running") return undefined;
	try {
		writeAsyncInterruptRequest(asyncDir, run.id);
		return { content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }], details: { mode: "management", results: [], managementControl: buildManagementControl({ state: "live", runId: run.id, intercomTarget: run.intercomTarget ?? run.leafIntercomTarget, canInterrupt: true }) } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` }], isError: true, details: { mode: "management", results: [] } };
	}
}

export async function interruptNestedRun(target: ResolvedSubagentRunId & { kind: "nested" }): Promise<SubagentExecutionResult> {
	const run = target.match.run;
	if (run.state === "complete") return { content: [{ type: "text", text: `Nested run ${run.id} is already complete and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "failed") return { content: [{ type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "paused") return { content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }], isError: true, details: { mode: "management", results: [] } };
	const result = await sendNestedControlRequest(target, "interrupt");
	if (result?.ok) return {
		content: [{ type: "text", text: result.message }],
		details: {
			mode: "management", results: [],
			managementControl: buildManagementControl({ state: "live", runId: run.id, intercomTarget: run.intercomTarget ?? run.leafIntercomTarget, canResume: true, canInterrupt: true }),
		},
	};
	const direct = directNestedAsyncInterrupt(target);
	if (direct) return direct;
	if (result) return { content: [{ type: "text", text: result.message }], isError: true, details: { mode: "management", results: [] } };
	return { content: [{ type: "text", text: `Nested run ${run.id} owner is not reachable and no safe direct async interrupt fallback is available.` }], isError: true, details: { mode: "management", results: [] } };
}

const LIVE_ACCEPTANCE_OVERRIDE_NOTICE = "Acceptance override applies only to revive and was not applied to this live delivery.";

export function liveLaunchOverrideNotice(params: SubagentParamsLike): string | undefined {
	if (params.acceptance !== undefined) return LIVE_ACCEPTANCE_OVERRIDE_NOTICE;
	return [params.agent, params.model, params.cwd, params.output, params.outputMode, params.outputSchema, params.skill, params.maxOutput, params.control, params.artifacts, params.share].some((value) => value !== undefined)
		? "Launch overrides change a newly started continuation, not this live child. No launch settings were changed."
		: undefined;
}

async function resumeLiveNestedRun(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string; acceptanceOverrideSupplied: boolean; events: IntercomEventBus }): Promise<SubagentExecutionResult> {
	const run = input.target.match.run;
	const result = await sendNestedControlRequest(input.target, "resume", input.message);
	if (result?.ok) return { content: [{ type: "text", text: [result.message, input.acceptanceOverrideSupplied ? LIVE_ACCEPTANCE_OVERRIDE_NOTICE : undefined].filter(Boolean).join("\n") }], details: { mode: "management", results: [] } };
	const directTarget = run.leafIntercomTarget ?? run.intercomTarget;
	if (directTarget) {
		const delivered = await deliverSubagentIntercomMessageEvent(
			input.events,
			directTarget,
			`Follow-up for nested run ${run.id}:\n\n${input.message}`,
			500,
			{ source: "nested-resume-fallback", runId: run.id, agent: run.agent, index: run.currentStep },
		);
		if (delivered) return { content: [{ type: "text", text: [`Delivered follow-up directly to live nested run ${run.id}.`, input.acceptanceOverrideSupplied ? LIVE_ACCEPTANCE_OVERRIDE_NOTICE : undefined].filter(Boolean).join("\n") }], details: { mode: "management", results: [] } };
	}
	if (result) return { content: [{ type: "text", text: result.message }], isError: true, details: { mode: "management", results: [] } };
	return { content: [{ type: "text", text: `Nested run ${run.id} appears live but its owner route is not reachable. Wait for completion, then retry action='resume'.` }], isError: true, details: { mode: "management", results: [] } };
}

function terminalNudgeResult(runId: string, deps: ExecutorDeps): SubagentExecutionResult | undefined {
	const owned = resolveOwnedRun(deps.state, runId);
	if (owned) {
		const result = ownedRunStatusResult(owned, deps.state);
		const state = result.details.run!.state;
		if (state === "live") return undefined;
		return { ...result, content: [{ type: "text", text: `Nudge not sent: ${state === "unknown" ? "completion is unconfirmed" : `run is already ${state}`}. No child was restarted.\n\n${result.content.map((part) => part.type === "text" ? part.text : "").join("\n")}` }] };
	}
	const remembered = deps.state.foregroundRuns?.get(runId);
	if (!remembered && deps.state.foregroundControls.get(runId)?.currentAgent) return undefined;
	const status = remembered
		? rememberedForegroundStatusResult(remembered)
		: inspectSubagentStatus({ id: runId }, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
	const state = status.details.managementControl?.state;
	if (status.isError || !state || state === "live" || state === "unknown") return undefined;
	return {
		...status,
		content: [{ type: "text", text: `Nudge not sent: run is already ${state}. No child was restarted.\n\n${status.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")}` }],
	};
}

export async function nudgeSubagentRun(input: {
	params: SubagentParamsLike;
	deps: ExecutorDeps;
}): Promise<SubagentExecutionResult> {
	const message = input.params.message?.trim() || "What are you blocked on? Reply with the smallest next step, or state the exact decision you need.";
	const requestedId = input.params.id ?? input.params.runId;
	let runId: string;
	let agent: string;
	let index: number;
	let target: string;
	let resolvedRunId: string | undefined;

	try {
		const owned = requestedId ? resolveOwnedRun(input.deps.state, requestedId) : undefined;
		if (owned) {
			resolvedRunId = owned.runId;
			const terminal = terminalNudgeResult(owned.runId, input.deps);
			if (terminal) return terminal;
			const view = ownedRunView(owned, input.deps.state);
			const children = view.children.filter((child) => child.state === "live" && (input.params.index === undefined || input.params.index === child.index));
			if (children.length !== 1) throw new Error(`Run '${owned.runId}' has ${children.length} matching live children. Provide index to choose one.`);
			const child = children[0]!;
			runId = owned.runId; agent = child.agent; index = child.index;
			target = resolveSubagentIntercomTarget(runId, agent, index);
		} else {
		const resolved = requestedId ? resolveSubagentRunId(requestedId, { state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }) : undefined;
		const remembered = !resolved && requestedId ? resolveRememberedForegroundRun(requestedId, input.deps.state) : undefined;
		resolvedRunId = resolved?.id ?? remembered?.runId;
		const terminal = resolvedRunId ? terminalNudgeResult(resolvedRunId, input.deps) : undefined;
		if (terminal) return terminal;
		if (resolved?.kind === "nested") {
			const run = resolved.match.run;
			const state = run.state === "running" || run.state === "queued" ? "live" : run.state === "complete" ? "completed" : run.state === "paused" || run.state === "failed" ? run.state : "unknown";
			const intercomTarget = run.intercomTarget ?? run.leafIntercomTarget;
			const valid = [`subagent({ action: "status", id: "${run.id}" })`];
			if (state === "live" || run.sessionFile) valid.push(`subagent({ action: "resume", id: "${run.id}", message: "..." })`);
			if (state === "live") valid.push(`subagent({ action: "interrupt", id: "${run.id}" })`);
			return {
				content: [{ type: "text", text: `Nested run ${run.id} cannot be nudged. Valid actions: ${valid.join(" or ")}${intercomTarget ? `. Intercom target: ${intercomTarget}` : "."}` }],
				isError: true,
				details: { mode: "management", results: [], managementControl: buildManagementControl({ state, runId: run.id, intercomTarget, canNudge: false, canResume: state === "live" || Boolean(run.sessionFile), canInterrupt: state === "live", unavailableActions: { nudge: "Nested runs do not support nudge; use an advertised exact action or intercom target." } }) },
			};
		}
		if (resolved?.kind === "foreground" || remembered || (!resolved && !requestedId)) {
			const control = getForegroundControl(input.deps.state, resolved?.kind === "foreground" ? resolved.id : requestedId);
			if (control?.currentAgent) {
				const currentIndex = input.params.index ?? control.currentIndex ?? 0;
				const activeChild = control.activeChildren?.get(currentIndex);
				if (input.params.index !== undefined) {
					if (control.activeChildren?.size ? !activeChild : currentIndex !== (control.currentIndex ?? 0)) {
						throw new Error(`Foreground run '${control.runId}' has no live child at index ${currentIndex}. Inspect status before targeting another child.`);
					}
				}
				runId = control.runId;
				agent = activeChild?.agent ?? control.currentAgent;
				index = currentIndex;
				target = resolveSubagentIntercomTarget(runId, agent, index);
			} else if (resolved?.kind === "foreground" || remembered) {
				const rememberedRun = remembered ?? resolveRememberedForegroundRun(resolved?.id, input.deps.state);
				if (!rememberedRun) throw new Error(`Foreground run '${resolved?.id}' has no live child to nudge.`);
				return rememberedForegroundStatusResult(rememberedRun);
			} else {
				throw new Error("No live foreground child found. Provide id for a running async child or inspect status first.");
			}
		} else {
			const asyncTarget = resolveAsyncResumeTarget({ id: input.params.id, runId: input.params.runId, dir: input.params.dir, index: input.params.index });
			if (asyncTarget.kind !== "live") {
				return terminalNudgeResult(asyncTarget.runId, input.deps)
					?? inspectSubagentStatus({ id: asyncTarget.runId }, { state: input.deps.state });
			}
			runId = asyncTarget.runId;
			agent = asyncTarget.agent;
			index = asyncTarget.index;
			target = asyncTarget.intercomTarget;
		}
		}
	} catch (error) {
		const terminal = resolvedRunId ? terminalNudgeResult(resolvedRunId, input.deps) : undefined;
		if (terminal) return terminal;
		const text = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
	}

	const result = await sendLiveSubagentMessage(input.deps.pi.events, {
		to: target,
		message: `Nudge for subagent run ${runId} (${agent}${index !== undefined ? ` step ${index + 1}` : ""}):\n\n${message}`,
		delivery: "steer",
		extra: { source: "subagent-nudge", runId, agent, index },
	});
	if (!result.delivered) {
		const terminal = terminalNudgeResult(runId, input.deps);
		if (terminal) return terminal;
		return { content: [{ type: "text", text: [`Nudge was not delivered.`, `Run: ${runId}`, `Intercom target: ${target}`, result.reason ? `Reason: ${result.reason}` : undefined].filter((line): line is string => Boolean(line)).join("\n") }], isError: true, details: { mode: "management", results: [] } };
	}
	return {
		content: [{ type: "text", text: [`Nudge delivered to live subagent.`, `Run: ${runId}`, `Agent: ${agent}`, `Intercom target: ${target}`].join("\n") }],
		details: { mode: "management", results: [], managementControl: buildManagementControl({ state: "live", runId, index, intercomTarget: target, canNudge: true, canResume: true, canInterrupt: true }) },
	};
}

export async function resumeAsyncRun(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
}): Promise<SubagentExecutionResult> {
	const followUp = (input.params.message ?? input.params.task ?? "").trim();
	if (!followUp) {
		return {
			content: [{ type: "text", text: "action='resume' requires message." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	let target: ResumeSourceTarget;
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	try {
		const requestedId = input.params.id ?? input.params.runId;
		const pendingQuestions = requestedId && !input.params.dir
			? listSupervisorQuestions(input.ctx.sessionManager.getSessionId(), requestedId).filter((question) => question.state === "awaiting_input" || question.state === "answer_pending")
			: [];
		if (pendingQuestions.length) return continueQuestionSession(input, pendingQuestions);
		const owned = requestedId && !input.params.dir ? resolveOwnedRun(input.deps.state, requestedId) : undefined;
		if (owned) {
			const view = ownedRunView(owned, input.deps.state);
			if (view.children.length > 1 && input.params.index === undefined) throw new Error(`Run '${owned.runId}' has ${view.children.length} children. Provide index to choose one.`);
			const child = view.children.find((entry) => entry.index === (input.params.index ?? 0));
			if (!child) throw new Error(`Run '${owned.runId}' has no child at index ${input.params.index ?? 0}.`);
			if (child.state === "live") {
				const result = await nudgeSubagentRun({ params: { ...input.params, id: owned.runId, message: followUp }, deps: input.deps });
				const notice = liveLaunchOverrideNotice(input.params);
				if (notice) result.content.push({ type: "text", text: notice });
				return result;
			}
			if (child.sessionFile) {
				for (const candidate of input.deps.state.ownedRuns?.values() ?? []) {
					if (candidate.runId === owned.runId) continue;
					const active = ownedRunView(candidate, input.deps.state).children.find((entry) => entry.sessionFile === child.sessionFile && entry.state === "live");
					if (active) {
						const result = await nudgeSubagentRun({ params: { ...input.params, id: candidate.runId, index: active.index, message: followUp }, deps: input.deps });
						const notice = liveLaunchOverrideNotice(input.params);
						if (notice) result.content.push({ type: "text", text: notice });
						return result;
					}
				}
			}
			const contract = readQuestionContract(owned.runId, child.index);
			return reviveSavedSubagent(input, {
				...contract, runId: owned.runId, agent: child.agent, index: child.index, source: owned.source,
				cwd: child.launch?.cwd ?? owned.cwd, sessionFile: child.sessionFile,
				effectiveAcceptance: contract?.effectiveAcceptance ?? child.result?.acceptance?.effectiveAcceptance,
				model: child.result?.model,
			});
		}
		const resolved = requestedId ? resolveSubagentRunId(requestedId, { state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }) : undefined;
		if (resolved?.kind === "foreground") {
			const result = await nudgeSubagentRun({ params: { ...input.params, message: followUp }, deps: input.deps });
			if (input.params.acceptance !== undefined) result.content.push({ type: "text", text: LIVE_ACCEPTANCE_OVERRIDE_NOTICE });
			return result;
		}
		if (resolved?.kind === "nested") {
			if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
				return resumeLiveNestedRun({ target: resolved, message: followUp, acceptanceOverrideSupplied: input.params.acceptance !== undefined, events: input.deps.pi.events });
			}
			const trustedSessionRoots = [
				...(input.deps.config.defaultSessionDir ? [path.resolve(input.deps.expandTilde(input.deps.config.defaultSessionDir))] : []),
				...(parentSessionFile ? [input.deps.getSubagentSessionRoot(parentSessionFile)] : []),
			];
			target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
		} else {
			target = resolveResumeTarget(input.params, input.deps.state);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const requestedId = input.params.id ?? input.params.runId;
		if (requestedId && !input.params.dir && (isAsyncRunNotFound(error) || message.includes("is detached for intercom coordination"))) {
			try {
				const questions = listSupervisorQuestions(input.ctx.sessionManager.getSessionId(), requestedId);
				if (questions.length) return continueQuestionSession(input, questions);
			} catch (questionError) {
				return { content: [{ type: "text", text: questionError instanceof Error ? questionError.message : String(questionError) }], isError: true, details: { mode: "management", results: [] } };
			}
		}
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	if (target.kind === "live") {
		const delivered = await deliverSubagentIntercomMessageEvent(
			input.deps.pi.events,
			target.intercomTarget,
			`Follow-up for async run ${target.runId} (${target.agent}):\n\n${followUp}`,
			500,
			{ source: "async-resume", runId: target.runId, agent: target.agent, index: target.index },
		);
		if (delivered) {
			return {
				content: [{ type: "text", text: [`Delivered follow-up to live async child.`, `Run: ${target.runId}`, `Intercom target: ${target.intercomTarget}`, input.params.acceptance !== undefined ? LIVE_ACCEPTANCE_OVERRIDE_NOTICE : undefined].filter(Boolean).join("\n") }],
				details: { mode: "management", results: [], managementControl: buildManagementControl({ state: "live", runId: target.runId, index: target.index, intercomTarget: target.intercomTarget, canNudge: true, canResume: true, canInterrupt: true }) },
			};
		}
		return {
			content: [{ type: "text", text: [`Async child appears live but its intercom target is not registered.`, `Run: ${target.runId}`, `Intercom target: ${target.intercomTarget}`, `Wait for completion, then retry action='resume'.`].join("\n") }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	return reviveSavedSubagent(input, target);
}

function continueQuestionSession(input: Parameters<typeof reviveSavedSubagent>[0], questions: SupervisorQuestionView[]): SubagentExecutionResult {
	if (input.params.index === undefined && new Set(questions.map((question) => question.index)).size > 1) throw new Error("Provide index to choose which child question to continue.");
	const question = questions.findLast((entry) => input.params.index === undefined || entry.index === input.params.index);
	if (!question) throw new Error("No saved question for that child index.");
	if (questionProcessAlive(question)) throw new Error("The question's child is still alive. Answer the question or stop it before continuing.");
	if (question.delivery?.kind === "revive") throw new Error(`Use continue with the answer's continuation run ${question.delivery.runId}.`);
	const revival = question.revival;
	const prior = revival ? resolveSubagentRunId(revival.runId, { state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }) : undefined;
	const priorExists = prior?.kind === "async"
		? prior.location.resultPath || (prior.location.asyncDir && fs.existsSync(path.join(prior.location.asyncDir, "status.json")))
		: Boolean(prior);
	if (revival && (questionProcessAlive(revival) || priorExists || fs.existsSync(getAsyncConfigPath(revival.runId)) || fs.existsSync(path.join(ASYNC_DIR, revival.runId, RUNNER_ERROR_LOG_FILE)))) {
		throw new Error(`Continuation ${revival.runId} may already have launched. Inspect or continue that run; the original question was not restarted.`);
	}
	const message = [input.params.message ?? input.params.task, question.answer ? `Saved supervisor answer:\n${question.answer.message}\n\nOriginal question:\n${question.message}` : undefined].filter(Boolean).join("\n\n");
	const result = reviveSavedSubagent({ ...input, params: { ...input.params, message } }, { ...question, source: "question" });
	if (!result.isError && question.answer && !question.delivery) recordQuestionDelivery(question, { kind: "revive", runId: result.details.asyncId!, deliveredAt: Date.now() });
	return result;
}

export function reviveSavedSubagent(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
}, target: Pick<ResumeSourceTarget, "runId" | "agent" | "index" | "cwd" | "sessionFile" | "effectiveAcceptance"> & SupervisorRunContract & { source: string; model?: string }, runId: string = randomUUID()): SubagentExecutionResult {
	const followUp = (input.params.message ?? input.params.task ?? "").trim();
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	if (!target.sessionFile || path.extname(target.sessionFile) !== ".jsonl" || !fs.existsSync(target.sessionFile)) {
		return { content: [{ type: "text", text: `Saved child session file is unavailable: ${target.sessionFile ?? "none"}. No child was started; any saved answer remains pending.` }], isError: true, details: { mode: "management", results: [] } };
	}
	const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
	if (blocked) {
		return {
			content: [{ type: "text", text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
	const contract = readQuestionContract(target.runId, target.index) ?? target;
	const savedLaunch = input.params.agent === undefined ? contract.launch : undefined;
	const effectiveCwd = input.params.cwd ?? savedLaunch?.cwd ?? target.cwd ?? input.requestCwd;
	const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
	if (!savedLaunch && !input.params.agent) {
		return { content: [{ type: "text", text: `Run '${target.runId}' predates saved launch configuration. Its session and known result remain available, but the original profile cannot be reconstructed safely. Continue with agent: '${target.agent}' to explicitly use that profile's current configuration; known model, output and acceptance are retained unless overridden.` }], isError: true, details: { mode: "management", results: [] } };
	}
	const discoveredAgents = savedLaunch ? [savedLaunch.agent] : input.deps.discoverAgents(effectiveCwd, scope, { projectTrusted: input.ctx.isProjectTrusted() }).agents;
	const fallbackTarget = resolveIntercomSessionTarget(input.deps.pi.getSessionName(), input.ctx.sessionManager.getSessionId());
	const orchestratorTarget = resolveOrchestratorIntercomTarget(input.deps.pi.events, fallbackTarget);
	const intercomBridge = resolveIntercomBridge(orchestratorTarget);
	const agents = discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge));
	const selectedAgent = input.params.agent ?? target.agent;
	const profile = agents.find((agent) => agent.name === selectedAgent);
	const agentConfig = profile && savedLaunch ? { ...profile, thinking: savedLaunch.thinking ?? profile.thinking, maxExecutionTimeMs: savedLaunch.maxExecutionTimeMs, maxTokens: savedLaunch.maxTokens } : profile;
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${selectedAgent}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	saveQuestionOwner(runId, input.ctx.sessionManager.getSessionId());
	const prior = input.deps.state.ownedRuns?.get(target.runId);
	rememberOwnedRun(input.deps.state, {
		runId, ownerSessionId: input.ctx.sessionManager.getSessionId(), rootRunId: prior?.rootRunId ?? target.runId,
		predecessorRunId: target.runId, predecessorIndex: target.index,
		source: "async", mode: "single", cwd: effectiveCwd, task: followUp, startedAt: Date.now(),
		children: [{ agent: selectedAgent, index: 0, sessionFile: target.sessionFile }],
	});
	const native = !savedLaunch ? readNativeSessionConfiguration(target.sessionFile) : {};
	const model = input.params.model ?? savedLaunch?.model ?? target.model ?? native.model;
	const thinking = savedLaunch?.thinking ?? native.thinking;
	const modelOverride = model && thinking && !splitKnownThinkingSuffix(model).thinkingSuffix ? `${model}:${thinking}` : model;
	const skill = normalizeSkillInput(input.params.skill);
	const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
	const result = executeAsyncSingle(runId, {
		agent: selectedAgent,
		task: buildRevivedAsyncTask(target, followUp),
		agentConfig,
		ctx: {
			pi: input.deps.pi,
			cwd: input.requestCwd,
			currentSessionId: input.deps.state.currentSessionId,
			currentModelProvider: input.ctx.model?.provider,
			projectTrusted: input.ctx.isProjectTrusted(),
		},
		cwd: effectiveCwd,
		maxOutput: input.params.maxOutput ?? savedLaunch?.maxOutput,
		artifactsDir: input.params.artifacts === false || (input.params.artifacts === undefined && savedLaunch?.artifacts === false) ? undefined : savedLaunch?.artifactsDir ?? input.deps.tempArtifactsDir,
		shareEnabled: input.params.share ?? savedLaunch?.share ?? false,
		sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
		sessionFile: target.sessionFile,
		maxSubagentDepth: savedLaunch?.maxSubagentDepth ?? resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
		worktreeSetupHook: input.deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
		controlConfig: resolveControlConfig(savedLaunch?.controlConfig ?? input.deps.config.control, input.params.control),
		controlIntercomTarget: intercomBridge.orchestratorTarget,
		childIntercomTarget: (agent, index) => resolveSubagentIntercomTarget(runId, agent, index),
		availableModels, savedLaunch, modelOverride,
		skills: skill === false ? [] : skill,
		acceptance: input.params.acceptance ?? acceptanceInputFromResolved(contract.effectiveAcceptance ?? savedLaunch?.effectiveAcceptance),
		output: input.params.output ?? savedLaunch?.output ?? contract.output,
		outputMode: input.params.outputMode ?? savedLaunch?.outputMode ?? contract.outputMode,
		outputSchema: input.params.outputSchema ?? savedLaunch?.outputSchema ?? contract.outputSchema,
		projectTrust: savedLaunch?.projectTrust ?? resolveConfiguredChildProjectTrustPolicy(input.deps.config.projectTrust),
	});
	const owned = input.deps.state.ownedRuns?.get(runId);
	if (owned) rememberOwnedRun(input.deps.state, { ...owned, asyncDir: result.details.asyncDir, pid: input.deps.state.asyncJobs.get(runId)?.pid, ...(result.isError ? { error: result.content.map((part) => part.text).join("\n") } : {}) });
	if (result.isError) return result;

	const revivedId = result.details.asyncId ?? runId;
	const revivedTarget = resolveSubagentIntercomTarget(revivedId, selectedAgent, 0);
	const sourceLabel = target.source;
	const lines = [
		`Revived ${sourceLabel} subagent from ${target.runId}.`,
		`Run mapping: ${target.runId} -> ${revivedId}`,
		`Revived run: ${revivedId}`,
		`Agent: ${selectedAgent}`,
		`Configuration: ${savedLaunch ? "saved effective launch" : "explicitly selected current profile"}${modelOverride ? `; model ${modelOverride}` : ""}`,
		`Root: ${prior?.rootRunId ?? target.runId}`,
		`Session: ${target.sessionFile}`,
		result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
		revivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,
		`Prior pending-reply context for ${target.runId} is invalid; use the revived run and target only.`,
		`Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
	].filter((line): line is string => Boolean(line));
	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n")) }],
		details: {
			...result.details,
			managementControl: buildManagementControl({ state: "live", runId: revivedId, index: 0, intercomTarget: revivedTarget, canInterrupt: true, revivedFromRunId: target.runId }),
		},
	};
}

function resultSummaryForIntercom(result: SingleResult): string {
	const output = result.truncation?.truncated ? result.truncation.text : getSingleResultOutput(result);
	if (result.exitCode !== 0 && result.error) {
		return output ? `${result.error}\n\nOutput:\n${output}` : result.error;
	}
	return output || result.error || "(no output)";
}

export function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">, deps: Pick<ExecutorDeps, "pi">): (event: ControlEvent) => void {
	return (event) => emitControlNotification({
		pi: deps.pi,
		controlConfig: data.controlConfig,
		intercomBridge: data.intercomBridge,
		event,
	});
}

async function emitForegroundResultIntercom(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	results: SingleResult[];
	error?: string;
	chainSteps?: number;
	nestedChildren?: NestedRunSummary[];
}): Promise<ReturnType<typeof buildSubagentResultIntercomPayload> | null> {
	const children = input.results.flatMap((result, index) => result.detached ? [] : [{
		agent: result.agent,
		status: resolveSubagentResultStatus({
			exitCode: result.exitCode,
			interrupted: result.interrupted,
			detached: result.detached,
			timedOut: result.timedOut,
		}),
		summary: resultSummaryForIntercom(result),
		index,
		artifactPath: result.artifactPaths?.outputPath,
		sessionPath: result.sessionFile,
		intercomTarget: resolveSubagentIntercomTarget(input.runId, result.agent, index),
	}]);
	if (children.length === 0) return null;
	const payload = buildSubagentResultIntercomPayload({
		to: input.intercomBridge.orchestratorTarget,
		runId: input.runId,
		mode: input.mode,
		source: "foreground",
		...(input.error ? { status: "failed", error: input.error } : {}),
		children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
		...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
	});
	const delivered = await deliverSubagentResultIntercomEvent(input.pi.events, payload);
	if (!delivered) return null;
	return payload;
}

interface DetachedCompletionGroup {
	onComplete: (result: SingleResult, index: number) => void;
	setResults: (results: SingleResult[], nestedChildren?: NestedRunSummary[]) => void;
	hasDetached: () => boolean;
}

export function createDetachedCompletionGroup(input: {
	pi: ExtensionAPI;
	state: SubagentState;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	chainSteps?: number;
	finalizeResults?: (results: SingleResult[]) => void;
	onResultsSettled?: (results: SingleResult[]) => void;
	onSettled?: () => void;
}): DetachedCompletionGroup {
	let results: SingleResult[] | undefined;
	let nestedChildren: NestedRunSummary[] | undefined;
	let wasDetached = false;
	let deliveryStarted = false;
	let settledCallbackStarted = false;
	const completions = new Map<number, SingleResult>();

	const maybeEmit = () => {
		if (!wasDetached || deliveryStarted || !results || results.some((result) => result.detached)) return;
		deliveryStarted = true;
		try {
			input.finalizeResults?.(results);
		} catch (error) {
			const target = results[0];
			if (target) {
				target.exitCode = 1;
				target.error = `Detached completion finalization failed: ${error instanceof Error ? error.message : String(error)}`;
				target.finalOutput = target.error;
				target.truncation = undefined;
			}
		}
		try {
			const remembered = input.state.foregroundRuns?.get(input.runId);
			if (remembered) rememberForegroundRun(input.state, { ...remembered, results });
			input.onResultsSettled?.(results);
		} catch (error) {
			console.error("Failed to finalize detached nested status:", error);
		}
		if (!settledCallbackStarted && input.onSettled) {
			settledCallbackStarted = true;
			queueMicrotask(input.onSettled);
		}
		void emitForegroundResultIntercom({
			pi: input.pi,
			intercomBridge: input.intercomBridge,
			runId: input.runId,
			mode: input.mode,
			results,
			...(input.chainSteps !== undefined ? { chainSteps: input.chainSteps } : {}),
			...(nestedChildren?.length ? { nestedChildren } : {}),
		}).then((payload) => {
			if (!payload) console.error(`Failed to emit detached foreground result for '${input.runId}'.`);
		}).catch((error) => console.error("Failed to emit detached foreground result:", error));
	};

	return {
		onComplete(result, index) {
			wasDetached = true;
			completions.set(index, result);
			if (results) results[index] = result;
			const remembered = input.state.foregroundRuns?.get(input.runId);
			const child = remembered?.children[index];
			if (child) {
				child.status = resolveSubagentResultStatus({ exitCode: result.exitCode, interrupted: result.interrupted, timedOut: result.timedOut });
				child.summary = resultSummaryForIntercom(result);
				child.result = result;
				child.artifactPath = result.artifactPaths?.outputPath;
				remembered!.updatedAt = Date.now();
			}
			maybeEmit();
		},
		setResults(initialResults, initialNestedChildren) {
			results = [...initialResults];
			nestedChildren = initialNestedChildren;
			wasDetached ||= results.some((result) => result.detached) || completions.size > 0;
			for (const [index, result] of completions) results[index] = result;
			maybeEmit();
		},
		hasDetached: () => wasDetached,
	};
}

export async function maybeBuildForegroundIntercomReceipt(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	details: Details;
	error?: string;
	nestedChildren?: NestedRunSummary[];
}): Promise<{ text: string; details: Details; status: ReturnType<typeof buildSubagentResultIntercomPayload>["status"] } | null> {
	const payload = await emitForegroundResultIntercom({
		pi: input.pi,
		intercomBridge: input.intercomBridge,
		runId: input.runId,
		mode: input.mode,
		results: input.details.results,
		error: input.error,
		...(typeof input.details.totalSteps === "number" ? { chainSteps: input.details.totalSteps } : {}),
		...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
	});
	if (!payload) return null;
	return {
		text: formatSubagentResultReceipt({ mode: input.mode, runId: input.runId, payload }),
		details: stripDetailsOutputsForIntercomReceipt(input.details, {
			delivered: true,
			to: payload.to,
			status: payload.status,
			summary: payload.summary,
		}),
		status: payload.status,
	};
}
