import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, parseSessionEntries } from "../../shared/native-session.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { compactForegroundResult, getFinalOutput, getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import { resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { buildManagementControl, formatAgentProcessExit, formatRunAction } from "../../shared/status-format.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { isDurableRun, readAsyncResultFile } from "../background/async-result-file.ts";
import { exactAsyncRunLocation, type AsyncRunRecord } from "../background/async-resume.ts";
import { createAsyncRunDiscovery } from "../background/async-status.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { acceptanceHumanAction } from "./acceptance-evaluation.ts";
import { formatRunIdAmbiguity } from "./run-id-ambiguity.ts";
import { resolveFinalizationOutput } from "./acceptance-finalization.ts";
import { parseAcceptanceReport, validateAcceptanceReportShape } from "./acceptance-reports.ts";
import { sumAttemptUsage } from "./model-fallback.ts";
import { workflowAgentNodes } from "./workflow-graph.ts";
import { collectInvocationAgentNames } from "../../shared/agent-context-policy.ts";
import type { SubagentParamsLike } from "../foreground/subagent-params.ts";
import { getRunMetadataDir, listRunQuestions, listOwnedRunQuestions, migrateSupervisorQuestions, questionProcessAlive, readQuestionContract, readRunJson, saveAsyncRunResult, saveRunStatus, saveQuestionOwner, type SupervisorRunContract } from "./supervisor-questions.ts";
import { ASYNC_DIR, DEFAULT_MAX_OUTPUT, RESULTS_DIR, SLASH_RESULT_TYPE, truncateOutput, type AgentProgress, type AsyncResultChild, type AsyncStatus, type Details, type ForegroundResumeRun, type ManagementRunState, type OwnedRun, type OwnedRunView, type SingleResult, type SubagentExecutionResult, type SubagentState, type WorkflowGraphSnapshot } from "../../shared/types.ts";

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
	if (matches.length > 1) throw new Error(formatRunIdAmbiguity("owned", id, matches.map((run) => run.runId)));
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

function recoverLegacyTerminalOutput(sessionFile: string | undefined, startedAt: number, endedAt: number | undefined, acceptance: SingleResult["acceptance"]): string | undefined {
	const review = acceptance?.finalization;
	const reviewedOutput = review?.status === "completed" ? review.turns.at(-1)?.rawOutput : undefined;
	if (reviewedOutput?.trim()) return resolveFinalizationOutput(reviewedOutput, "") || undefined;
	// Live and finalization logs are separate, mutable streams, not a final-answer receipt.
	if (endedAt === undefined || !Number.isFinite(endedAt) || !sessionFile || !fs.existsSync(sessionFile)) return;
	const entries = parseSessionEntries(fs.readFileSync(sessionFile, "utf8"));
	if (entries[0]?.type !== "session") return;
	const messages = buildSessionContext(entries.filter((entry): entry is SessionEntry => entry.type !== "session" && Date.parse(entry.timestamp) >= startedAt && Date.parse(entry.timestamp) <= endedAt)).messages;
	const index = messages.findLastIndex((message) => message.role === "assistant");
	const last = messages[index];
	if (last?.role !== "assistant" || last.errorMessage || !["stop", "toolUse"].includes(last.stopReason) || !Array.isArray(last.content)) return;
	const calls = last.content.filter((part) => part.type === "toolCall");
	if (!calls.length) return index === messages.length - 1 && last.stopReason === "stop" ? resolveFinalizationOutput(getFinalOutput([last]), "") || undefined : undefined;
	if (calls.length !== 1 || calls[0]!.name !== "structured_output") return;
	const following = messages.slice(index + 1);
	const result = following.at(-1);
	if (following.some((message) => message.role !== "toolResult") || result?.role !== "toolResult" || result.toolCallId !== calls[0]!.id || result.toolName !== "structured_output" || result.isError !== false) return;
	const value = calls[0]!.arguments.value;
	if (!value || typeof value !== "object" || !("report" in value)) return;
	if (typeof value.report === "string" && parseAcceptanceReport(value.report).report) return resolveFinalizationOutput(value.report, "") || undefined;
	if ("answer" in value && typeof value.answer === "string" && value.answer.trim() && !validateAcceptanceReportShape(value.report)) return value.answer;
}

export function workflowChildren(children: OwnedRun["children"], graph: WorkflowGraphSnapshot | undefined): OwnedRun["children"] {
	if (!graph || (graph.mode !== "chain" && !children.some((child) => child.workflowNodeId))) return children;
	return workflowAgentNodes(graph).map((node, index) => {
		const declared = children.find((child) => child.workflowNodeId === node.id);
		return { ...declared, index, workflowNodeId: node.id, agent: node.agent ?? declared?.agent ?? "unknown",
			...(node.itemKey !== undefined ? { label: node.label } : {}) };
	});
}

function savedWorkflowNodes(status: AsyncStatus | null | undefined) {
	if (!status?.workflowGraph || status.workflowGraph.runId !== status.runId) return;
	const nodes = workflowAgentNodes(status.workflowGraph);
	if (nodes.length !== status.steps?.length || new Set(nodes.map((node) => node.id)).size !== nodes.length) return;
	if (nodes.some((node, index) => typeof node.id !== "string" || !node.id || (node.agent && node.agent !== status.steps![index]!.agent))) return;
	return nodes;
}

export interface OwnedRunRestoration {
	startedAt: number;
	records: AsyncRunRecord[];
	discover: () => AsyncRunRecord[];
}

export function restoreOwnedRuns(state: SubagentState, ctx: ExtensionContext, options: { strict?: boolean } = {}): OwnedRunRestoration {
	const startedAt = Date.now();
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
		let owner: { sessionId?: unknown } | undefined;
		try { owner = readRunJson(path.join(getRunMetadataDir(runId), "question-owner.json")); } catch { /* Unusable metadata can be repaired from the genuine receipt. */ }
		if (typeof owner?.sessionId !== "string" || !owner.sessionId.trim()) saveQuestionOwner(runId, ownerSessionId);
		rememberOwnedRun(state, run);
	}
	// Pre-update background runs may have no parent tool receipt (for example slash launches).
	const scan = createAsyncRunDiscovery(ASYNC_DIR, {
		sessionId: resolveCurrentSessionId(ctx.sessionManager), ownerSessionId,
		receiptRunIds: () => state.ownedRuns!.keys(), skipInvalid: !options.strict,
	});
	const discover = () => {
		const records = scan();
		for (const { location, status, durable } of records) {
			try {
				const asyncDir = location.asyncDir;
				if (!asyncDir || !status) continue;
				const terminal = !["running", "queued"].includes(status.state);
				if (!durable && terminal) saveRunStatus(status.runId, status);
				const old = state.ownedRuns!.get(status.runId);
				const nodes = savedWorkflowNodes(status);
				const declared = status.mode === "chain" && nodes && !old?.children.some((child) => child.workflowNodeId) ? [] : old?.children ?? [];
				const children = workflowChildren(declared, nodes ? status.workflowGraph : undefined);
				rememberOwnedRun(state, {
					...old, runId: status.runId, ownerSessionId, rootRunId: old?.rootRunId ?? status.runId,
					source: "async", mode: status.mode, cwd: status.cwd ?? old?.cwd ?? ctx.cwd,
					task: old?.task ?? "Recovered background run", startedAt: status.startedAt,
					asyncDir, pid: status.pid, legacy: old?.legacy ?? !durable,
					children: (status.steps ?? []).map((step, index) => ({ ...children.find((child) => child.index === index), agent: step.agent, index, ...(status.mode === "chain" && nodes?.[index] ? { workflowNodeId: nodes[index]!.id } : {}), label: step.label ?? children[index]?.label, sessionFile: step.sessionFile ?? (status.steps?.length === 1 ? status.sessionFile : undefined) })),
				});
				const resultPath = path.join(RESULTS_DIR, `${status.runId}.json`);
				if (!durable && terminal && !fs.existsSync(path.join(getRunMetadataDir(status.runId), "result.json"))) {
					if (fs.existsSync(resultPath)) saveAsyncRunResult(status.runId, readAsyncResultFile(resultPath));
					else if (status.steps?.length && status.steps.every((step) => !["running", "pending"].includes(step.status))) {
						const endedAt = status.endedAt ?? status.lastUpdate ?? status.startedAt;
						const results = status.steps.map((step) => {
							const sessionFile = step.sessionFile ?? (status.steps!.length === 1 ? status.sessionFile : undefined);
							return { agent: step.agent, sessionFile, model: step.model, acceptance: step.acceptance,
								exitCode: step.exitCode, agentProcessExit: step.agentProcessExit, success: step.status === "complete" || step.status === "completed",
								interrupted: step.status === "paused" || undefined, timedOut: step.status === "timed-out" || undefined, error: step.error,
								output: recoverLegacyTerminalOutput(sessionFile, step.startedAt ?? status.startedAt, step.endedAt ?? status.endedAt, step.acceptance) ?? "" };
						});
						saveAsyncRunResult(status.runId, { id: status.runId, sessionId: status.sessionId, mode: status.mode, state: status.state,
							success: status.state === "complete", error: status.error, timestamp: endedAt, cwd: status.cwd, asyncDir, sessionFile: status.sessionFile, results });
					}
				}
			} catch (error) {
				if (options.strict) throw error;
				console.error(`Could not recover owned async metadata for '${location.resolvedId}':`, error);
			}
		}
		return records;
	};
	const records = discover();
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
	return { startedAt, records, discover };
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
	const { output, ...result } = child;
	return {
		...result, agent: child.agent ?? "unknown", task: child.task ?? task, exitCode: child.exitCode ?? (child.success ? 0 : 1),
		finalOutput: child.finalOutput ?? output, usage: child.usage ?? sumAttemptUsage(child.modelAttempts ?? []),
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

export function ownedRunView(run: OwnedRun, state: SubagentState, options: { pendingInput?: boolean; includeContinuations?: boolean; readConfiguration?: import("./supervisor-questions.ts").NativeConfigurationReader | false } = {}): OwnedRunView {
	run = state.ownedRuns?.get(run.runId) ?? run;
	const root = getRunMetadataDir(run.runId);
	const foreground = readRunJson<ForegroundResumeRun>(path.join(root, "foreground.json")) ?? state.foregroundRuns?.get(run.runId);
	const resultPath = path.join(root, "result.json");
	const result = fs.existsSync(resultPath) ? readAsyncResultFile(resultPath) : undefined;
	const location = exactAsyncRunLocation(run.runId, ASYNC_DIR, RESULTS_DIR);
	const asyncDir = location.asyncDir ?? run.asyncDir;
	const liveStatus = asyncDir ? readStatus(asyncDir) : null;
	const savedStatus = liveStatus ?? readRunJson<AsyncStatus>(path.join(root, "status.json"));
	const durable = isDurableRun(savedStatus) || isDurableRun(readRunJson<object>(path.join(root, "launch.json")));
	const reconciliation = durable ? reconcileAsyncRun(asyncDir ?? root) : undefined;
	const status = reconciliation?.status ?? savedStatus;
	const contracts = new Map<number, SupervisorRunContract>();
	const contractDir = path.join(root, "contracts");
	for (const name of fs.existsSync(contractDir) ? fs.readdirSync(contractDir) : []) {
		if (!/^\d+\.json$/.test(name)) continue;
		const index = Number(name.slice(0, -5));
		const contract = readQuestionContract(run.runId, index, undefined, { endedAt: status?.steps?.[index]?.endedAt ?? result?.timestamp ?? foreground?.updatedAt, readConfiguration: options.readConfiguration });
		if (contract) contracts.set(index, contract);
	}
	const nodes = savedWorkflowNodes(status);
	const declarations = workflowChildren(run.children, nodes ? status?.workflowGraph : undefined);
	// Terminal snapshots contain materialized children; declared slots can include an empty fanout or unstarted downstream steps.
	const terminalIndices = result?.results?.map((_, index) => index) ?? foreground?.children.map((child) => child.index);
	const indices = new Set(terminalIndices ?? [...declarations.map((child) => child.index), ...contracts.keys(), ...(status?.steps?.map((_, index) => index) ?? [])]);
	const sessions = new Map([...indices].map((index) => [index, foreground?.children.find((child) => child.index === index)?.sessionFile ?? result?.results?.[index]?.sessionFile ?? status?.steps?.[index]?.sessionFile ?? contracts.get(index)?.sessionFile]));
	const sessionUses = new Map<string, number>();
	for (const file of sessions.values()) if (file) sessionUses.set(file, (sessionUses.get(file) ?? 0) + 1);
	const uncertainIndices = run.mode === "chain" && (!run.children.some((child) => child.workflowNodeId) || (run.source === "async" && status && !nodes));
	const children: OwnedRunView["children"] = [...indices].sort((a, b) => a - b).map((index) => {
		const boundSession = sessions.get(index);
		const declared = uncertainIndices && !nodes
			? run.children.find((child) => boundSession && sessionUses.get(boundSession) === 1 && child.sessionFile === boundSession)
			: declarations.find((child) => child.index === index);
		const contract = contracts.get(index);
		const fg = foreground?.children.find((child) => child.index === index);
		const bg = result?.results?.[index];
		const step = status?.steps?.[index];
		const sessionFile = boundSession ?? declared?.sessionFile;
		const live = processAlive(contract?.pid) || ((!step || step.status === "running" || step.status === "pending") && processAlive(status?.pid ?? run.pid));
		const pending = !fg && !bg && !contract?.pid && !contract?.result && ((!step || step.status === "pending") && processAlive(status?.pid ?? run.pid));
		const childState = bg ? normalizedState(resolveSubagentResultStatus({ success: bg.success, exitCode: bg.exitCode ?? undefined, interrupted: bg.interrupted, acceptance: bg.acceptance, state: typeof bg.success !== "boolean" && bg.exitCode == null ? result?.terminalState : undefined }))
			: fg && fg.status !== "detached" ? normalizedState(fg.status)
			: contract?.result ? normalizedState(resolveSubagentResultStatus(contract.result))
			: live || pending ? "live"
			: step && !["running", "pending"].includes(step.status) ? normalizedState(step.status) : "unknown";
		const task = contract?.task ?? declared?.task ?? fg?.result?.task ?? (run.children.length === 1 ? run.task : undefined);
		const selection = contract?.modelSelection ?? step ?? fg?.result?.progress;
		return {
			agent: fg?.agent ?? bg?.agent ?? step?.agent ?? contract?.launch?.agent.name ?? declared?.agent ?? "unknown", index, workflowNodeId: declared?.workflowNodeId, sessionFile,
			task, label: contract?.label ?? step?.label ?? declared?.label,
			...(run.mode === "chain" && !declared?.workflowNodeId && (!boundSession || sessionUses.get(boundSession) !== 1) ? { identityUnavailable: true } : {}),
			modelSelection: selection ? { model: selection.model, thinking: selection.thinking, modelStartedAt: selection.modelStartedAt } : undefined,
			activity: childState === "live" ? (pending ? { ...step, status: "pending" as const } : step) : undefined,
			state: childState, result: fg?.status !== "detached" && fg?.result ? fg.result : bg ? asyncChildResult(bg, task ?? "Original child assignment unavailable") : contract?.result ?? fg?.result,
			launch: contract?.launch, configuration: contract?.launch ? "saved" : "legacy-partial",
			...(sessionFile && !fs.existsSync(sessionFile) ? { missingSession: true } : {}),
		};
	});
	const live = children.some((child) => child.state === "live") || (!result && (!status || status.state === "running" || status.state === "queued") && processAlive(status?.pid ?? run.pid));
	const error = result?.error ?? foreground?.error ?? run.error ?? (status && !["running", "queued"].includes(status.state) ? status.error : undefined);
	const executionState: ManagementRunState = error ? "failed" : result ? normalizedState(result.terminalState)
		: durable && !live ? "unknown"
		: live ? "live"
		: children.some((child) => child.state === "failed") ? "failed"
		: children.some((child) => child.state === "blocked") ? "blocked"
		: children.some((child) => child.state === "paused") ? "paused"
		: children.length && children.every((child) => child.state === "completed") ? (foreground?.pausedReason ? "paused" : "completed")
		: status && !["running", "queued"].includes(status.state) ? normalizedState(status.state) : "unknown";
	const pendingInput = options.pendingInput ?? listOwnedRunQuestions(run.ownerSessionId, run.runId).some((question) => question.state === "awaiting_input" || question.state === "answer_pending");
	return {
		...run, state: executionState, children, attention: runAttention(run, executionState, pendingInput),
		canInterrupt: pendingInput || (live && savedStatus?.state === "running" && savedStatus.runId === run.runId),
		updatedAt: result?.timestamp ?? status?.lastUpdate ?? foreground?.updatedAt ?? run.startedAt,
		continuations: options.includeContinuations === false ? [] : [...(state.ownedRuns?.values() ?? [])].filter((candidate) => candidate.rootRunId === run.rootRunId && candidate.predecessorRunId).sort((a, b) => a.startedAt - b.startedAt).map((candidate) => ({ runId: candidate.runId, predecessorRunId: candidate.predecessorRunId!, predecessorIndex: candidate.predecessorIndex })),
		...(result ? { resultPath } : foreground ? { resultPath: path.join(root, "foreground.json") } : {}),
		...(error ? { diagnosis: error } : executionState === "paused" && foreground?.pausedReason ? { diagnosis: foreground.pausedReason } : executionState === "unknown" ? { diagnosis: reconciliation?.message ?? "Completion is unconfirmed. Saved sessions are context, not proof of successful execution." } : {}),
	};
}

function workflowDetails(graph: WorkflowGraphSnapshot | undefined): Pick<Details, "workflowGraph" | "chainAgents" | "totalSteps" | "currentStepIndex"> {
	if (!graph) return {};
	if (graph.mode !== "chain") return { workflowGraph: graph };
	const current = graph.nodes.find((node) => node.id === graph.currentNodeId || node.children?.some((child) => child.id === graph.currentNodeId));
	return { workflowGraph: graph, chainAgents: graph.nodes.map((node) => node.agent ?? node.label), totalSteps: graph.nodes.length,
		...(current?.stepIndex !== undefined ? { currentStepIndex: current.stepIndex } : {}) };
}

export function ownedRunExecutionResult(run: OwnedRun, state: SubagentState, index?: number, includeProgress = false): SubagentExecutionResult {
	const view = ownedRunView(run, state);
	const location = exactAsyncRunLocation(run.runId, ASYNC_DIR, RESULTS_DIR);
	const saved = location.resultPath ? readAsyncResultFile(location.resultPath) : undefined;
	const limits = { ...DEFAULT_MAX_OUTPUT, ...(saved?.maxOutput ?? view.children[0]?.launch?.maxOutput) };
	const children = view.children.filter((child) => index === undefined || child.index === index);
	const projected = view.children.map((child) => {
		if (!child.result) return { ...child, result: undefined };
		const { artifactPaths, ...result } = child.result;
		const finalOutput = getSingleResultOutput(result);
		const truncation = result.outputMode === "file-only" && result.exitCode === 0 && result.outputReference
			? { text: result.outputReference.message, truncated: false } : truncateOutput(finalOutput, limits, artifactPaths?.outputPath);
		const compacted = compactForegroundResult({ ...result, finalOutput: truncation.text,
			...(truncation.truncated ? { truncation } : {}),
			...(result.initialOutput ? { initialOutput: truncateOutput(result.initialOutput, limits, artifactPaths?.outputPath).text } : {}),
		});
		return { ...child, result: { ...compacted, ...(artifactPaths ? { artifactPaths } : {}) } };
	});
	const results: SingleResult[] = projected.filter((child) => index === undefined || child.index === index).flatMap((child) => {
		if (!child.result) return [];
		const { artifactPaths, ...result } = child.result;
		return [{ ...result, ...(artifactPaths?.inputPath && artifactPaths.outputPath && artifactPaths.metadataPath
			? { artifactPaths: { inputPath: artifactPaths.inputPath, outputPath: artifactPaths.outputPath, metadataPath: artifactPaths.metadataPath } } : {}) }];
	});
	let text = (index === undefined ? saved?.summary : undefined) || [...children.map((child) => child.result ? getSingleResultOutput(child.result) || child.result.error : undefined), view.diagnosis].filter(Boolean).join("\n\n");
	const failed = index === undefined ? ["failed", "unknown"].includes(view.state) : children.length === 0 || children.some((child) => ["failed", "unknown"].includes(child.state));
	if (failed && saved?.error && !text.includes(saved.error)) text = `${saved.error}\n\n${text}`;
	const logPath = path.join(location.asyncDir ?? run.asyncDir ?? getRunMetadataDir(run.runId), `subagent-log-${run.runId}.md`);
	const artifactPath = run.mode === "single" ? results[0]?.artifactPaths?.outputPath : fs.existsSync(logPath) ? logPath : undefined;
	const referenceOnly = view.state === "completed" && run.mode === "single" && results.length === 1 && results[0]?.outputMode === "file-only" && results[0].outputReference;
	const truncation = referenceOnly ? { text: referenceOnly.message, truncated: false }
		: view.state === "blocked" ? { text, truncated: false } : truncateOutput(text, limits, artifactPath);
	const files = results.flatMap((result) => result.artifactPaths ? [result.artifactPaths] : []);
	const progressSummary = { toolCount: results.reduce((total, result) => total + (result.progressSummary?.toolCount ?? 0), 0),
		tokens: results.reduce((total, result) => total + (result.progressSummary?.tokens ?? 0), 0),
		durationMs: saved?.durationMs ?? Math.max(0, ...results.map((result) => result.progressSummary?.durationMs ?? 0)) };
	const share = saved?.shareUrl ? `Session: ${saved.shareUrl}` : saved?.shareError ? `Session share error: ${saved.shareError}` : undefined;
	const identity = run.predecessorRunId ? `Run: ${run.runId}\nPredecessor: ${run.predecessorRunId} (child ${run.predecessorIndex ?? 0})` : undefined;
	return { content: [{ type: "text", text: [identity, truncation.text || `Run ${run.runId}: ${view.state}.`, share].filter(Boolean).join("\n\n") }],
		...(failed ? { isError: true } : {}),
		details: { mode: run.mode, runId: run.runId, asyncId: run.runId, asyncDir: location.asyncDir ?? run.asyncDir, results,
			run: { ...view, children: projected }, progressSummary,
			...(includeProgress ? { progress: ownedRunProgressResult(run, state, index).details.progress } : {}),
			...(saved?.shareUrl ? { shareUrl: saved.shareUrl } : {}),
			...(saved?.gistUrl ? { gistUrl: saved.gistUrl } : {}),
			...(saved?.shareError ? { shareError: saved.shareError } : {}),
			...(files.length ? { artifacts: { dir: saved?.artifactsDir ?? path.dirname(files[0]!.outputPath), files } } : {}),
			...(truncation.truncated ? { truncation } : {}),
			...(saved?.outputs ? { outputs: saved.outputs } : {}), ...workflowDetails(saved?.workflowGraph) } };
}

/** Project the run owner's native activity for waiting callers without copying its journal. */
export function ownedRunProgressResult(run: OwnedRun, state: SubagentState, index?: number, view = ownedRunView(run, state, { readConfiguration: false, includeContinuations: false })): SubagentExecutionResult {
	const status = readStatus(run.asyncDir ?? getRunMetadataDir(run.runId));
	const children = view.children.filter((child) => index === undefined || child.index === index);
	const progress: AgentProgress[] = children.map((child) => {
		const step = status?.steps?.[child.index];
		const live = child.state === "live";
		return {
			index: child.index, agent: child.agent, task: child.task ?? run.task,
			status: step?.status ?? (child.state === "live" ? "pending" : child.state === "unknown" ? "failed" : child.state),
			model: step?.model, thinking: step?.thinking, modelStartedAt: step?.modelStartedAt,
			activityState: step?.activityState, lastActivityAt: step?.lastActivityAt, skills: step?.skills,
			...(live ? { currentTool: step?.currentTool, currentToolArgs: step?.currentToolArgs, currentToolStartedAt: step?.currentToolStartedAt,
				currentPath: step?.currentPath, streamingText: step?.streamingText } : {}),
			recentTools: live ? step?.recentTools?.slice(-10) ?? [] : [], recentOutput: live ? step?.recentOutput?.slice(-10) ?? [] : [],
			toolCount: step?.toolCount ?? 0, turnCount: step?.turnCount, tokens: step?.tokens?.total ?? 0,
			durationMs: step?.durationMs ?? Math.max(0, Date.now() - (step?.startedAt ?? run.startedAt)), error: step?.error,
		};
	});
	const results: SingleResult[] = progress.map((item, position) => ({
		agent: item.agent, task: item.task, exitCode: children[position]?.result?.exitCode ?? 0,
		usage: children[position]?.result?.usage ?? { input: status?.steps?.[item.index]?.tokens?.input ?? 0, output: status?.steps?.[item.index]?.tokens?.output ?? 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: item.turnCount ?? 0 },
		progress: item, model: item.model, sessionFile: children[position]?.sessionFile,
		finalOutput: getSingleResultOutput(children[position]?.result ?? {}) || item.streamingText || item.recentOutput.at(-1),
	}));
	return { content: [{ type: "text", text: progress.map((item) => `${item.agent}: ${item.status}${item.currentTool ? ` — ${item.currentTool}${item.currentToolArgs ? ` ${item.currentToolArgs}` : ""}` : ""}`).join("\n") }],
		details: { mode: run.mode, runId: run.runId, asyncId: run.runId, asyncDir: run.asyncDir, results, progress, ...workflowDetails(status?.workflowGraph) } };
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
	if (!cached || cached.stamp !== stamp || cached.foreground !== foreground || cached.summary.state === "live" || cached.summary.state === "unknown") {
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
