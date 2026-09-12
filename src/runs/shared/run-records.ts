import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, parseSessionEntries } from "../../shared/native-session.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { compactForegroundResult, getFinalOutput, getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { buildManagementControl, formatAgentProcessExit, formatRunAction } from "../../shared/status-format.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { readAsyncResultFile } from "../background/async-result-file.ts";
import { applyThinkingSuffix } from "./pi-args.ts";
import { acceptanceHumanAction } from "./acceptance-evaluation.ts";
import { sumAttemptUsage } from "./model-fallback.ts";
import { collectInvocationAgentNames } from "../../shared/agent-context-policy.ts";
import type { SubagentParamsLike } from "../foreground/subagent-params.ts";
import { getRunMetadataDir, listRunQuestions, listSupervisorQuestions, migrateSupervisorQuestions, questionProcessAlive, readQuestionContract, readRunJson, saveAsyncRunResult, saveRunStatus, saveQuestionContract, saveQuestionOwner, type SupervisorRunContract } from "./supervisor-questions.ts";
import { ASYNC_DIR, DEFAULT_MAX_OUTPUT, RESULTS_DIR, SLASH_RESULT_TYPE, type AsyncResultChild, type AsyncResultFile, type AsyncStatus, type Details, type ForegroundResumeRun, type ManagementRunState, type OwnedRun, type OwnedRunView, type RunSyncOptions, type SingleResult, type SubagentExecutionResult, type SubagentState } from "../../shared/types.ts";

export const OWNED_RUN_ENTRY = "subagent-run";

export function rememberOwnedRun(state: SubagentState, run: OwnedRun): void {
	const previous = state.ownedRuns?.get(run.runId);
	(state.ownedRuns ??= new Map()).set(run.runId, run);
	if (JSON.stringify(previous) !== JSON.stringify(run)) {
		state.persistOwnedRun?.(run);
		state.onRunsChanged?.();
	}
}

export function resolveOwnedRun(state: SubagentState, requested: string): OwnedRun | undefined {
	const id = requested.trim();
	getRunMetadataDir(id); // Same ID boundary as the question and result files.
	const exact = state.ownedRuns?.get(id);
	if (exact && id !== "latest" && id !== "last") return exact;
	const runs = [...(state.ownedRuns?.values() ?? [])];
	if (id === "latest" || id === "last") return runs.sort((a, b) => b.startedAt - a.startedAt)[0];
	const matches = runs.filter((run) => run.runId.startsWith(id));
	if (matches.length > 1) throw new Error(`Ambiguous owned run id prefix '${id}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`);
	return matches[0];
}

export function saveForegroundRun(input: { runId: string; mode: ForegroundResumeRun["mode"]; cwd: string; results: SingleResult[]; error?: string; pausedReason?: string }): ForegroundResumeRun {
	const run: ForegroundResumeRun = {
		runId: input.runId, mode: input.mode, cwd: input.cwd, updatedAt: Date.now(),
		...(input.error ? { error: input.error } : {}),
		...(input.pausedReason ? { pausedReason: input.pausedReason } : {}),
		children: input.results.map((result, index) => ({
			agent: result.agent, index,
			status: resolveSubagentResultStatus(result),
			...(!result.detached ? { summary: getSingleResultOutput(result) || result.error } : {}),
			artifactPath: result.artifactPaths?.outputPath,
			sessionFile: result.sessionFile,
			effectiveAcceptance: result.acceptance?.effectiveAcceptance,
			result: compactForegroundResult(result),
		})),
	};
	writeAtomicJson(path.join(getRunMetadataDir(input.runId), "foreground.json"), run);
	return run;
}

export function saveForegroundLaunch(agent: AgentConfig, task: string, systemPrompt: string, skills: string[], models: string[], options: RunSyncOptions, runtimeCwd: string): void {
	if (!options.runId) return;
	const model = applyThinkingSuffix(models[0], agent.thinking);
	const contract = readQuestionContract(options.runId, options.index ?? 0);
	saveQuestionContract(options.runId, options.index ?? 0, {
		task, sessionFile: options.sessionFile,
		launch: {
			agent, systemPrompt, skills, model, thinking: resolveEffectiveThinking(model, agent.thinking),
			artifacts: options.artifactsDir !== undefined, artifactsDir: options.artifactsDir, share: options.share === true,
			modelCandidates: models.map((candidate) => applyThinkingSuffix(candidate, agent.thinking)!),
			cwd: options.cwd ?? runtimeCwd, context: agent.defaultContext ?? "fresh",
			output: options.outputPath ?? false, outputMode: options.outputMode ?? "inline", outputSchema: options.structuredOutput?.schema,
			...(options.outputPathFromAgentDefault && options.outputPath && typeof agent.output === "string" && !path.isAbsolute(agent.output) ? { generatedOutputFilename: path.basename(agent.output) } : {}),
			effectiveAcceptance: contract?.effectiveAcceptance,
			maxOutput: { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput }, maxSubagentDepth: options.maxSubagentDepth,
			maxExecutionTimeMs: options.maxExecutionTimeMs, maxTokens: options.maxTokens,
			controlConfig: options.controlConfig, projectTrust: options.projectTrust, projectTrusted: options.projectTrusted,
		},
	});
}

function receiptDetails(entry: SessionEntry): Details | undefined {
	if (entry.type === "message" && entry.message.role === "toolResult" && ["subagent", "delegate", "agent_runs"].includes(entry.message.toolName)) return entry.message.details as Details | undefined;
	if (entry.type === "custom_message" && entry.customType === SLASH_RESULT_TYPE) {
		const details = entry.details as { result?: SubagentExecutionResult } | undefined;
		return details?.result?.details;
	}
	return undefined;
}

function sessionFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
		? sessionFiles(path.join(root, entry.name))
		: entry.name.endsWith(".jsonl") ? [path.join(root, entry.name)] : []);
}

function recoverOutput(sessionFile: string | undefined, outputFile: string | undefined, endedAt: number): string | undefined {
	if (outputFile && fs.existsSync(outputFile)) return fs.readFileSync(outputFile, "utf8");
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;
	const entries = parseSessionEntries(fs.readFileSync(sessionFile, "utf8"));
	if (entries[0]?.type !== "session") return undefined;
	return getFinalOutput(buildSessionContext(entries.filter((entry): entry is SessionEntry => entry.type !== "session" && Date.parse(entry.timestamp) <= endedAt)).messages.filter((message) => message.role === "assistant"));
}

function recoverAsyncResult(status: AsyncStatus, asyncDir: string): AsyncResultFile | undefined {
	if (status.state === "running" || status.state === "queued") return undefined;
	return {
		id: status.runId, sessionId: status.sessionId, cwd: status.cwd, mode: status.mode, state: status.state, success: status.state === "complete",
		timestamp: status.endedAt ?? status.lastUpdate, sessionFile: status.sessionFile,
		results: status.steps?.map((step, index) => ({
			agent: step.agent, model: step.model, sessionFile: step.sessionFile, acceptance: step.acceptance,
			success: step.status === "complete" || step.status === "completed", interrupted: step.status === "paused", exitCode: step.exitCode, error: step.error,
			output: recoverOutput(step.sessionFile, undefined, step.endedAt ?? status.endedAt ?? status.lastUpdate ?? Date.now()) || recoverOutput(undefined, path.join(asyncDir, `output-${index}.log`), 0),
		})),
	};
}

export function restoreOwnedRuns(state: SubagentState, ctx: ExtensionContext): void {
	const ownerSessionId = ctx.sessionManager.getSessionId();
	const entries = ctx.sessionManager.getEntries();
	state.ownedRuns = new Map();
	migrateSupervisorQuestions(ownerSessionId);
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== OWNED_RUN_ENTRY) continue;
		const run = entry.data as OwnedRun | undefined;
		if (run?.ownerSessionId === ownerSessionId && run.runId && Array.isArray(run.children)) state.ownedRuns.set(run.runId, run);
	}
	// Forks copy old entries. Their old receipts are evidence, not ownership for the new parent.
	const inheritedIds = new Set<string>();
	const parentFile = ctx.sessionManager.getHeader()?.parentSession;
	if (parentFile && fs.existsSync(parentFile)) {
		for (const entry of parseSessionEntries(fs.readFileSync(parentFile, "utf8"))) if (entry.type !== "session") inheritedIds.add(entry.id);
	}
	const calls = new Map<string, SubagentParamsLike>();
	for (const entry of entries) if (entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
		for (const part of entry.message.content) if (part.type === "toolCall" && ["subagent", "delegate"].includes(part.name)) calls.set(part.id, part.arguments as SubagentParamsLike);
	}
	for (const entry of entries) {
		if (inheritedIds.has(entry.id) || (parentFile && !fs.existsSync(parentFile))) continue;
		const details = receiptDetails(entry);
		const runId = details?.runId ?? details?.asyncId;
		if (!runId || !details || !Array.isArray(details.results) || (details.mode !== "single" && details.mode !== "parallel" && details.mode !== "chain") || state.ownedRuns.has(runId)) continue;
		const cwd = details.results.find((result) => result.sessionFile)?.sessionFile;
		const request = entry.type === "message" && entry.message.role === "toolResult" ? calls.get(entry.message.toolCallId) : undefined;
		const run: OwnedRun = {
			runId, ownerSessionId, rootRunId: details.managementControl?.revivedFromRunId ?? runId,
			predecessorRunId: details.managementControl?.revivedFromRunId,
			source: details.asyncId ? "async" : "foreground", mode: details.mode,
			cwd: request?.cwd ? path.resolve(ctx.cwd, request.cwd) : ctx.cwd, task: details.results[0]?.task ?? request?.task ?? "Recovered delegated run",
			startedAt: Date.parse(entry.timestamp), asyncDir: details.asyncDir, legacy: true,
			children: details.results.length ? details.results.map((result, index) => ({ agent: result.agent, index, task: result.task, sessionFile: result.sessionFile })) : collectInvocationAgentNames(request ?? {}).map((agent, index) => ({ agent, index })),
		};
		if (cwd && fs.existsSync(cwd)) {
			const header = parseSessionEntries(fs.readFileSync(cwd, "utf8"))[0];
			if (header?.type === "session" && header.cwd) run.cwd = header.cwd;
		}
		if (run.source === "foreground") saveForegroundRun({ ...run, results: details.results.map((result) => ({ ...result, finalOutput: result.finalOutput ?? recoverOutput(result.sessionFile, result.artifactPaths?.outputPath, Date.parse(entry.timestamp)) })) });
		saveQuestionOwner(runId, ownerSessionId);
		rememberOwnedRun(state, run);
	}
	// Pre-update background runs may have no parent tool receipt (for example slash launches).
	for (const name of fs.existsSync(ASYNC_DIR) ? fs.readdirSync(ASYNC_DIR) : []) {
		const asyncDir = path.join(ASYNC_DIR, name);
		try {
			const status = readStatus(asyncDir);
			if (!status || status.sessionId !== resolveCurrentSessionId(ctx.sessionManager)) continue;
			saveRunStatus(status.runId, status);
			const old = state.ownedRuns.get(status.runId);
			rememberOwnedRun(state, {
				...old, runId: status.runId, ownerSessionId, rootRunId: old?.rootRunId ?? status.runId,
				source: "async", mode: status.mode, cwd: status.cwd ?? old?.cwd ?? ctx.cwd,
				task: old?.task ?? "Recovered background run", startedAt: status.startedAt,
				asyncDir, pid: status.pid, legacy: old?.legacy ?? true,
				children: (status.steps ?? []).map((step, index) => ({ ...old?.children.find((child) => child.index === index), agent: step.agent, index, label: step.label ?? old?.children[index]?.label, sessionFile: step.sessionFile ?? (status.steps?.length === 1 ? status.sessionFile : undefined) })),
			});
			const resultPath = path.join(RESULTS_DIR, `${status.runId}.json`);
			if (!fs.existsSync(path.join(getRunMetadataDir(status.runId), "result.json"))) {
				const recovered = fs.existsSync(resultPath) ? readAsyncResultFile(resultPath) : recoverAsyncResult(status, asyncDir);
				if (recovered) saveAsyncRunResult(status.runId, recovered);
			}
		} catch (error) {
			console.error(`Could not recover owned async metadata for '${name}':`, error);
		}
	}
	for (const run of state.ownedRuns.values()) {
		const stored = readRunJson<ForegroundResumeRun>(path.join(getRunMetadataDir(run.runId), "foreground.json"));
		if (stored) (state.foregroundRuns ??= new Map()).set(run.runId, stored);
		if (run.children.some((child) => child.sessionFile) || !run.legacy) continue;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) continue;
		const root = path.join(path.dirname(file), path.basename(file, ".jsonl"), run.runId);
		const files = sessionFiles(root).sort();
		if (files.length) rememberOwnedRun(state, { ...run, children: files.map((sessionFile, index) => ({ agent: run.children[index]?.agent ?? "unknown", index, sessionFile })) });
	}
}

function normalizedState(value: string | undefined): ManagementRunState {
	if (value === "running" || value === "queued") return "live";
	if (value === "complete" || value === "completed") return "completed";
	if (value === "failed" || value === "timed-out") return "failed";
	if (value === "blocked") return "blocked";
	if (value === "paused") return "paused";
	return "unknown";
}

function processAlive(pid: number | undefined): boolean {
	return Boolean(pid && Number.isSafeInteger(pid) && pid > 0 && questionProcessAlive({ pid }));
}

function asyncChildResult(child: AsyncResultChild, task: string) {
	return {
		...child, agent: child.agent ?? "unknown", task, exitCode: child.exitCode ?? (child.success ? 0 : 1),
		finalOutput: child.output, usage: sumAttemptUsage(child.modelAttempts ?? []),
	};
}

function runAttention(run: OwnedRun, executionState: ManagementRunState, pendingInput: boolean): string[] {
	return [
		...(pendingInput ? ["awaiting_input"] : []),
		...(run.review?.decision === "needs_changes" ? ["needs_changes"] : []),
		...(run.review?.decision !== "accepted" && ["failed", "blocked", "paused", "unknown"].includes(executionState) ? [executionState] : []),
		...(executionState === "completed" && !run.review ? ["unreviewed"] : []),
	];
}

export function ownedRunView(run: OwnedRun, state: SubagentState, options: { pendingInput?: boolean; includeContinuations?: boolean } = {}): OwnedRunView {
	const root = getRunMetadataDir(run.runId);
	const foreground = readRunJson<ForegroundResumeRun>(path.join(root, "foreground.json")) ?? state.foregroundRuns?.get(run.runId);
	const resultPath = path.join(root, "result.json");
	const result = fs.existsSync(resultPath) ? readAsyncResultFile(resultPath) : undefined;
	const liveStatus = run.asyncDir ? readStatus(run.asyncDir) : null;
	const status = liveStatus ?? readRunJson<AsyncStatus>(path.join(root, "status.json"));
	const contracts = new Map<number, SupervisorRunContract>();
	const contractDir = path.join(root, "contracts");
	for (const name of fs.existsSync(contractDir) ? fs.readdirSync(contractDir) : []) {
		if (!/^\d+\.json$/.test(name)) continue;
		const index = Number(name.slice(0, -5));
		const contract = readQuestionContract(run.runId, index);
		if (contract) contracts.set(index, contract);
	}
	// Terminal snapshots contain materialized children; declared slots can include an empty fanout or unstarted downstream steps.
	const terminalIndices = result?.results?.map((_, index) => index) ?? foreground?.children.map((child) => child.index);
	const indices = new Set(terminalIndices ?? [...run.children.map((child) => child.index), ...contracts.keys(), ...(status?.steps?.map((_, index) => index) ?? [])]);
	const children: OwnedRunView["children"] = [...indices].sort((a, b) => a - b).map((index) => {
		const declared = run.children.find((child) => child.index === index);
		const contract = contracts.get(index);
		const fg = foreground?.children.find((child) => child.index === index);
		const bg = result?.results?.[index];
		const step = status?.steps?.[index];
		const sessionFile = fg?.sessionFile ?? bg?.sessionFile ?? step?.sessionFile ?? contract?.sessionFile ?? declared?.sessionFile;
		const control = state.foregroundControls.get(run.runId);
		const live = control?.activeChildren?.has(index) || (control?.currentAgent !== undefined && control.currentAgent === (declared?.agent ?? fg?.agent) && (control.currentIndex ?? 0) === index) || processAlive(contract?.pid) || ((!step || step.status === "running" || step.status === "pending") && processAlive(status?.pid ?? run.pid));
		const pending = !fg && !bg && !contract?.pid && !contract?.result && (Boolean(control) && !live || step?.status === "pending" && processAlive(status?.pid ?? run.pid));
		const childState = bg ? normalizedState(resolveSubagentResultStatus({ success: bg.success, exitCode: bg.exitCode ?? undefined, interrupted: bg.interrupted, acceptance: bg.acceptance, state: typeof bg.success !== "boolean" && bg.exitCode == null ? result?.terminalState : undefined }))
			: fg && fg.status !== "detached" ? normalizedState(fg.status)
			: contract?.result ? normalizedState(resolveSubagentResultStatus(contract.result))
			: live || pending ? "live"
			: step && !["running", "pending"].includes(step.status) ? normalizedState(step.status) : "unknown";
		const task = contract?.task ?? declared?.task ?? fg?.result?.task ?? (run.children.length === 1 ? run.task : undefined);
		return {
			agent: fg?.agent ?? bg?.agent ?? step?.agent ?? contract?.launch?.agent.name ?? declared?.agent ?? "unknown", index, sessionFile,
			task, label: contract?.label ?? step?.label ?? declared?.label,
			activity: childState === "live" ? control?.progress?.find((progress) => progress.index === index) ?? (pending ? { status: "pending" as const } : step) : undefined,
			state: childState, result: fg?.status !== "detached" && fg?.result ? fg.result : bg ? asyncChildResult(bg, task ?? "Original child assignment unavailable") : contract?.result ?? fg?.result,
			launch: contract?.launch, configuration: contract?.launch ? "saved" : "legacy-partial",
			...(sessionFile && !fs.existsSync(sessionFile) ? { missingSession: true } : {}),
		};
	});
	const live = state.foregroundControls.has(run.runId) || children.some((child) => child.state === "live") || (!result && (!status || status.state === "running" || status.state === "queued") && processAlive(status?.pid ?? run.pid));
	const error = foreground?.error ?? run.error;
	const executionState: ManagementRunState = error ? "failed" : result ? normalizedState(result.terminalState)
		: live ? "live"
		: children.some((child) => child.state === "failed") ? "failed"
		: children.some((child) => child.state === "blocked") ? "blocked"
		: children.some((child) => child.state === "paused") ? "paused"
		: children.length && children.every((child) => child.state === "completed") ? (foreground?.pausedReason ? "paused" : "completed")
		: status && !["running", "queued"].includes(status.state) ? normalizedState(status.state) : "unknown";
	const pendingInput = options.pendingInput ?? listSupervisorQuestions(run.ownerSessionId, run.runId).some((question) => question.state === "awaiting_input" || question.state === "answer_pending");
	return {
		...run, state: executionState, children, attention: runAttention(run, executionState, pendingInput),
		canInterrupt: pendingInput || Boolean(state.foregroundControls.get(run.runId)?.interrupt) || (liveStatus?.state === "running" && state.asyncJobs.has(run.runId)),
		updatedAt: result?.timestamp ?? status?.lastUpdate ?? foreground?.updatedAt ?? run.startedAt,
		continuations: options.includeContinuations === false ? [] : [...(state.ownedRuns?.values() ?? [])].filter((candidate) => candidate.rootRunId === run.rootRunId && candidate.predecessorRunId).sort((a, b) => a.startedAt - b.startedAt).map((candidate) => ({ runId: candidate.runId, predecessorRunId: candidate.predecessorRunId!, predecessorIndex: candidate.predecessorIndex })),
		...(result ? { resultPath } : foreground ? { resultPath: path.join(root, "foreground.json") } : {}),
		...(error ? { diagnosis: error } : executionState === "paused" && foreground?.pausedReason ? { diagnosis: foreground.pausedReason } : executionState === "unknown" ? { diagnosis: "Completion is unconfirmed. Saved sessions are context, not proof of successful execution." } : {}),
	};
}

function compact(value: string, max = 180): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function ownedRunControl(view: OwnedRunView) {
	const active = view.children.find((child) => child.state === "live" && child.activity?.status !== "pending");
	const resumable = active ?? view.children.find((child) => child.state !== "live" && child.sessionFile && !child.missingSession);
	return buildManagementControl({ state: view.state, runId: view.runId, index: resumable?.index, canReview: view.state !== "live", canResume: Boolean(resumable), canNudge: Boolean(active), canInterrupt: view.canInterrupt, intercomTarget: active ? resolveSubagentIntercomTarget(view.runId, active.agent, active.index) : undefined });
}

export function ownedRunStatusResult(run: OwnedRun, state: SubagentState, runtime?: SubagentExecutionResult, options: { full?: boolean; childSafe?: boolean } = {}): SubagentExecutionResult {
	const view = ownedRunView(run, state);
	const liveControl = view.state === "live" && runtime?.details.managementControl?.state === "live" ? runtime.details.managementControl : undefined;
	const control = liveControl ?? ownedRunControl(view);
	const lines = [
		`Run: ${run.runId}`, `State: ${view.state}`, `Mode: ${run.mode} (${run.source})`, `Task: ${options.full ? run.task : compact(run.task)}`, `Launch cwd: ${run.cwd}`,
		`Root: ${run.rootRunId}`, ...(run.predecessorRunId ? [`Predecessor: ${run.predecessorRunId} (child ${run.predecessorIndex ?? 0})`] : []),
		`Parent review (not sent to child): ${run.review?.decision ?? "unreviewed"}${run.review?.message ? ` — ${options.full ? run.review.message : compact(run.review.message)}` : ""}`,
		`Notification: ${run.delivery ? `recorded ${new Date(run.delivery.notifiedAt).toISOString()}; intercom ${run.delivery.intercomDelivered ? "delivered" : "not confirmed"}` : "not recorded"}`,
		...(view.attention.length ? [`Attention: ${view.attention.join(", ")}`] : []),
		...(view.resultPath ? [`Result: ${view.resultPath}`] : []), ...(view.diagnosis ? [view.diagnosis] : []),
		...(runtime && !runtime.isError && (run.source === "async" || liveControl) ? runtime.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []),
	];
	for (const child of view.children) {
		lines.push(`Child ${child.index}: ${child.agent} | ${child.state}${child.result?.acceptance ? ` | validation: ${child.result.acceptance.status}` : ""}`);
		const humanAction = acceptanceHumanAction(child.result?.acceptance);
		if (humanAction) lines.push(`  Needs your action — acceptance incomplete:\n${humanAction}`);
		if (child.state !== "live") lines.push(`  ${formatAgentProcessExit(child.result?.agentProcessExit)}`);
		if (child.sessionFile) lines.push(`  Session: ${child.sessionFile}${child.missingSession ? " (missing; continuation unavailable)" : ""}`);
		const artifact = child.result?.artifactPaths?.outputPath;
		if (artifact) lines.push(`  Artifact: ${artifact}${fs.existsSync(artifact) ? "" : " (missing)"}`);
		const metadata = child.result?.artifactPaths?.metadataPath;
		if (metadata) lines.push(`  Result metadata (acceptance details when configured): ${metadata}${fs.existsSync(metadata) ? "" : " (missing)"}`);
		if (child.launch) {
			const launch = child.launch;
			lines.push(`  Effective model: ${launch.model ?? "native default"}; thinking: ${launch.thinking ?? "native default"}`,
				`  Output: ${launch.output || "disabled"} (${launch.outputMode}); configuration: saved launch snapshot`);
			if (options.full) lines.push(`  Saved launch configuration:\n${JSON.stringify(launch, null, 2)}`);
		} else lines.push("  Configuration: legacy-partial; original profile snapshot was not recorded.");
		const output = child.result && getSingleResultOutput(child.result);
		if (output) lines.push(`  Result: ${compact(output, 600)}`);
		if (child.result?.error) lines.push(`  Error: ${child.result.error}`);
	}
	if (control.capabilities.includes("review")) lines.push(`Review (parent-only, not sent to child): ${formatRunAction("review", run.runId, { decision: "accepted" }, options.childSafe)} or decision: "needs_changes".`);
	if (view.continuations.length) lines.push("Continuation history:", ...view.continuations.map((next) => `  ${next.predecessorRunId}:${next.predecessorIndex ?? 0} -> ${next.runId}`));
	if (control.capabilities.includes("resume")) lines.push(`Continue: ${formatRunAction("resume", run.runId, { ...(view.children.length > 1 ? { index: control.nextActions.find((action) => action.action === "resume")?.index ?? 0 } : {}), message: "..." }, options.childSafe)}`);
	if (!options.full) lines.push(`Full task/configuration: ${formatRunAction("status", run.runId, { full: true }, options.childSafe)}`);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { ...runtime?.details, mode: "management", results: [], run: view, managementControl: control },
	};
}

// Keep ordering facts, not every historical result and launch prompt. File replacement
// invalidates them; live/unconfirmed runs and selected-page controls are always read fresh.
const listSummaryCache = new WeakMap<OwnedRun, {
	stamp: string;
	foreground?: ForegroundResumeRun;
	summary: Pick<OwnedRunView, "state" | "updatedAt">;
}>();

function runListSummary(run: OwnedRun, state: SubagentState, pendingInput: boolean) {
	const root = getRunMetadataDir(run.runId);
	const files = [path.join(root, "foreground.json"), path.join(root, "result.json"), path.join(root, "status.json"), path.join(root, "contracts"), ...(run.asyncDir ? [path.join(run.asyncDir, "status.json")] : [])];
	const stamp = files.map((file) => {
		const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
		return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "missing";
	}).join("|");
	const foreground = state.foregroundRuns?.get(run.runId);
	let cached = listSummaryCache.get(run);
	if (!cached || cached.stamp !== stamp || cached.foreground !== foreground || state.foregroundControls.has(run.runId) || cached.summary.state === "live" || cached.summary.state === "unknown") {
		const view = ownedRunView(run, state, { pendingInput, includeContinuations: false });
		cached = { stamp, foreground, summary: { state: view.state, updatedAt: view.updatedAt } };
		listSummaryCache.set(run, cached);
	}
	return { run, pendingInput, ...cached.summary, attention: runAttention(run, cached.summary.state, pendingInput) };
}

export function ownedRunList(state: SubagentState, params: { offset?: number; limit?: number }): SubagentExecutionResult {
	const offset = params.offset ?? 0, limit = params.limit ?? 20;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Run list requires offset >= 0 and limit from 1 to 100.");
	const owned = [...(state.ownedRuns?.values() ?? [])];
	for (const owner of new Set(owned.map((run) => run.ownerSessionId))) migrateSupervisorQuestions(owner);
	const rank = (run: ReturnType<typeof runListSummary>) => run.attention.includes("awaiting_input") ? 0 : run.attention.some((reason) => reason !== "unreviewed") ? 1 : run.state === "live" ? 2 : run.attention.length ? 3 : 4;
	const views = owned.map((run) => runListSummary(run, state, listRunQuestions(getRunMetadataDir(run.runId)).some((question) => question.ownerSessionId === run.ownerSessionId && (question.state === "awaiting_input" || question.state === "answer_pending"))))
		.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt || a.run.runId.localeCompare(b.run.runId));
	const page = views.slice(offset, offset + limit).map(({ run, pendingInput }) => ownedRunView(run, state, { pendingInput, includeContinuations: false }));
	const runs = page.map(({ runId, source, mode, cwd, task, state: runState, updatedAt, attention, review, rootRunId, predecessorRunId, predecessorIndex, children }) => ({ runId, source, mode, cwd, task, state: runState, updatedAt, attention, review, rootRunId, predecessorRunId, predecessorIndex, continuations: owned.filter((candidate) => candidate.predecessorRunId === runId).map((candidate) => candidate.runId), summary: compact(children.map((child) => child.result ? getSingleResultOutput(child.result) || child.result.error || "" : "").filter(Boolean).join(" | ")) }));
	const controls = page.map(ownedRunControl);
	const nextOffset = offset + page.length < views.length ? offset + page.length : undefined;
	return {
		content: [{ type: "text", text: views.length ? [`Owned runs: ${views.length} (showing ${page.length ? `${offset + 1}–${offset + page.length}` : "none"}; attention first)`, ...runs.map((run) => `- ${run.runId} | ${run.state}${run.attention.length ? ` | ${run.attention.join(", ")}` : ""} | ${compact(run.task)}${run.summary ? ` | ${run.summary}` : ""} | Launch cwd: ${run.cwd}${run.predecessorRunId ? ` | from ${run.predecessorRunId}:${run.predecessorIndex ?? 0}` : ""}${run.continuations.length ? ` | continued as ${run.continuations.join(", ")} (separate results/reviews)` : ""}`), ...(nextOffset !== undefined ? [`Next: agent_runs({ action: "list", offset: ${nextOffset}, limit: ${limit} })`] : [])].join("\n") : "No delegated runs owned by this session." }],
		details: { mode: "management", results: [], runs, managementControls: controls, managementControl: controls.find((control) => control.state === "live"), runList: { total: views.length, offset, limit, ...(nextOffset !== undefined ? { nextOffset } : {}) } },
	};
}
