import * as fs from "node:fs";
import * as path from "node:path";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { formatActivityLabel, formatParallelOutcome } from "../../shared/status-format.ts";
import { type ActivityState, type AsyncJobStep, type AsyncParallelGroupStatus, type AsyncStatus, type NestedRunSummary, type SubagentRunMode, type TokenUsage } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { attachRootChildrenToSteps, findNestedRouteForRootId, projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";

interface AsyncRunStepSummary {
	index: number;
	agent: string;
	label?: string;
	phase?: string;
	outputName?: string;
	structured?: boolean;
	status: AsyncJobStep["status"];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput?: string[];
	turnCount?: number;
	toolCount?: number;
	durationMs?: number;
	tokens?: TokenUsage;
	skills?: string[];
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	error?: string;
	children?: NestedRunSummary[];
}

export interface AsyncRunSummary {
	id: string;
	asyncDir: string;
	pid?: number;
	sessionId?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused";
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	mode: SubagentRunMode;
	cwd?: string;
	startedAt: number;
	lastUpdate?: number;
	endedAt?: number;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps: AsyncRunStepSummary[];
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	nestedChildren?: NestedRunSummary[];
	nestedWarnings?: string[];
}

interface AsyncRunListOptions {
	states?: Array<AsyncRunSummary["state"]>;
	sessionId?: string;
	limit?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	reconcile?: boolean;
	skipInvalid?: boolean;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAsyncRunDir(root: string, entry: string): boolean {
	const entryPath = path.join(root, entry);
	try {
		return fs.statSync(entryPath).isDirectory();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw new Error(`Failed to inspect async run path '${entryPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function outputFileMtime(outputFile: string | undefined): number | undefined {
	if (!outputFile) return undefined;
	try {
		return fs.statSync(outputFile).mtimeMs;
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to inspect async output file '${outputFile}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function deriveAsyncActivityState(asyncDir: string, status: AsyncStatus): { activityState?: ActivityState; lastActivityAt?: number } {
	if (status.state !== "running") return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile ? (path.isAbsolute(status.outputFile) ? status.outputFile : path.join(asyncDir, status.outputFile)) : undefined;
	const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
	return {
		activityState: status.activityState,
		lastActivityAt: status.lastActivityAt ?? outputFileMtime(outputPath) ?? currentStep?.lastActivityAt ?? currentStep?.startedAt ?? status.startedAt,
	};
}

function assertOptionalFields(record: Record<string, unknown>, fields: string[], valid: (value: unknown) => boolean, expected: string, source: string): void {
	for (const field of fields) {
		if (record[field] !== undefined && !valid(record[field])) {
			throw new Error(`Invalid async status '${source}': ${field} must be ${expected}.`);
		}
	}
}

function validateTokenUsage(value: unknown, field: string, source: string): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid async status '${source}': ${field} must be an object.`);
	}
	const tokens = value as Record<string, unknown>;
	if (![tokens.input, tokens.output, tokens.total].every((part) => typeof part === "number" && Number.isFinite(part))) {
		throw new Error(`Invalid async status '${source}': ${field} must contain finite input, output, and total numbers.`);
	}
}

function validateStatusForSummary(status: AsyncStatus, source: string): void {
	if (!status || typeof status !== "object" || Array.isArray(status)) {
		throw new Error(`Invalid async status '${source}': status must be an object.`);
	}
	const record = status as unknown as Record<string, unknown>;
	assertOptionalFields(record, ["runId", "sessionId", "currentTool", "currentPath", "cwd", "sessionDir", "outputFile", "sessionFile"], (value) => typeof value === "string", "a string", source);
	assertOptionalFields(record, ["lastActivityAt", "currentToolStartedAt", "turnCount", "toolCount", "startedAt", "endedAt", "lastUpdate", "pid", "currentStep", "chainStepCount"], (value) => typeof value === "number" && Number.isFinite(value), "a finite number", source);
	if (typeof record.runId !== "string") throw new Error(`Invalid async status '${source}': runId must be a string.`);
	if (typeof record.startedAt !== "number") throw new Error(`Invalid async status '${source}': startedAt must be a number.`);
	if (!(["single", "parallel", "chain"] as unknown[]).includes(record.mode)) throw new Error(`Invalid async status '${source}': mode is invalid.`);
	if (!(["queued", "running", "complete", "failed", "paused"] as unknown[]).includes(record.state)) throw new Error(`Invalid async status '${source}': state is invalid.`);
	if (record.activityState !== undefined && record.activityState !== "needs_attention") throw new Error(`Invalid async status '${source}': activityState is invalid.`);
	validateTokenUsage(record.totalTokens, "totalTokens", source);
	if (record.steps !== undefined && !Array.isArray(record.steps)) throw new Error(`Invalid async status '${source}': steps must be an array.`);
	const steps = Array.isArray(record.steps) ? record.steps : [];
	if (record.currentStep !== undefined && (typeof record.currentStep !== "number" || !Number.isSafeInteger(record.currentStep) || record.currentStep < 0 || record.currentStep >= steps.length)) {
		throw new Error(`Invalid async status '${source}': currentStep must index a persisted step.`);
	}
	if (record.chainStepCount !== undefined && (typeof record.chainStepCount !== "number" || !Number.isSafeInteger(record.chainStepCount) || record.chainStepCount < 1)) {
		throw new Error(`Invalid async status '${source}': chainStepCount must be a positive integer.`);
	}
	for (const [index, value] of steps.entries()) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
		const step = value as Record<string, unknown>;
		const stepSource = `${source} (steps[${index}])`;
		assertOptionalFields(step, ["agent", "phase", "label", "outputName", "sessionFile", "currentTool", "currentToolArgs", "currentPath", "model", "thinking", "error"], (field) => typeof field === "string", "a string", stepSource);
		assertOptionalFields(step, ["lastActivityAt", "currentToolStartedAt", "turnCount", "toolCount", "startedAt", "endedAt", "durationMs"], (field) => typeof field === "number" && Number.isFinite(field), "a finite number", stepSource);
		if (typeof step.agent !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
		if (!(["pending", "running", "complete", "completed", "failed", "paused", "timed-out"] as unknown[]).includes(step.status)) throw new Error(`Invalid async status '${source}': steps[${index}].status is invalid.`);
		if (step.activityState !== undefined && step.activityState !== "needs_attention") throw new Error(`Invalid async status '${source}': steps[${index}].activityState is invalid.`);
		if (step.structured !== undefined && typeof step.structured !== "boolean") throw new Error(`Invalid async status '${source}': steps[${index}].structured must be a boolean.`);
		for (const field of ["recentOutput", "skills", "attemptedModels"]) {
			if (step[field] !== undefined && (!Array.isArray(step[field]) || !(step[field] as unknown[]).every((item) => typeof item === "string"))) {
				throw new Error(`Invalid async status '${source}': steps[${index}].${field} must be an array of strings.`);
			}
		}
		if (step.recentTools !== undefined) {
			const validRecentTools = Array.isArray(step.recentTools) && step.recentTools.every((tool) => tool
				&& typeof tool === "object"
				&& !Array.isArray(tool)
				&& typeof (tool as Record<string, unknown>).tool === "string"
				&& typeof (tool as Record<string, unknown>).args === "string"
				&& typeof (tool as Record<string, unknown>).endMs === "number"
				&& Number.isFinite((tool as Record<string, unknown>).endMs));
			if (!validRecentTools) throw new Error(`Invalid async status '${source}': steps[${index}].recentTools is invalid.`);
		}
		if (step.children !== undefined && !Array.isArray(step.children)) throw new Error(`Invalid async status '${source}': steps[${index}].children must be an array.`);
		validateTokenUsage(step.tokens, `steps[${index}].tokens`, source);
	}
}

export function asyncStatusToSummary(asyncDir: string, status: AsyncStatus & { cwd?: string }, nestedWarnings: string[] = []): AsyncRunSummary {
	validateStatusForSummary(status, path.join(asyncDir, "status.json"));
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	const steps = status.steps ?? [];
	const chainStepCount = status.chainStepCount ?? steps.length;
	const parallelGroups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
	let nestedChildren: NestedRunSummary[] = [];
	if (nestedWarnings.length === 0) {
		try {
			nestedChildren = projectNestedRegistryForRoot(status.runId || path.basename(asyncDir))?.children ?? [];
		} catch (error) {
			nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
		}
	}
	const summarizedSteps = steps.map((step, index) => {
		const stepActivityState = step.activityState;
		const stepLastActivityAt = step.lastActivityAt;
		const stepChildren = (step.children ?? []).map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child));
		return {
			index,
			agent: step.agent,
			...(step.label ? { label: step.label } : {}),
			...(step.phase ? { phase: step.phase } : {}),
			...(step.outputName ? { outputName: step.outputName } : {}),
			...(step.structured ? { structured: step.structured } : {}),
			status: step.status,
			...(stepActivityState ? { activityState: stepActivityState } : {}),
			...(stepLastActivityAt ? { lastActivityAt: stepLastActivityAt } : {}),
			...(step.currentTool ? { currentTool: step.currentTool } : {}),
			...(step.currentToolArgs ? { currentToolArgs: step.currentToolArgs } : {}),
			...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
			...(step.currentPath ? { currentPath: step.currentPath } : {}),
			...(step.recentTools ? { recentTools: step.recentTools.map((tool) => ({ ...tool })) } : {}),
			...(step.recentOutput ? { recentOutput: [...step.recentOutput] } : {}),
			...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
			...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
			...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
			...(step.tokens ? { tokens: step.tokens } : {}),
			...(step.skills ? { skills: step.skills } : {}),
			...(step.model ? { model: step.model } : {}),
			...(step.thinking ? { thinking: step.thinking } : {}),
			...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
			...(step.error ? { error: step.error } : {}),
			...(stepChildren.length ? { children: stepChildren } : {}),
		};
	});
	attachRootChildrenToSteps(status.runId || path.basename(asyncDir), summarizedSteps, nestedChildren);
	return {
		id: status.runId || path.basename(asyncDir),
		asyncDir,
		...(typeof status.pid === "number" ? { pid: status.pid } : {}),
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		state: status.state,
		activityState,
		lastActivityAt,
		currentTool: status.currentTool,
		currentToolStartedAt: status.currentToolStartedAt,
		currentPath: status.currentPath,
		turnCount: status.turnCount,
		toolCount: status.toolCount,
		mode: status.mode,
		cwd: status.cwd,
		startedAt: status.startedAt,
		lastUpdate: status.lastUpdate,
		endedAt: status.endedAt,
		currentStep: status.currentStep,
		...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: summarizedSteps,
		...(nestedChildren.length ? { nestedChildren } : {}),
		...(nestedWarnings.length ? { nestedWarnings } : {}),
		...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
		...(status.outputFile ? { outputFile: status.outputFile } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
	};
}

function sortRuns(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const rank = (state: AsyncRunSummary["state"]): number => {
		switch (state) {
			case "running": return 0;
			case "queued": return 1;
			case "failed": return 2;
			case "paused": return 2;
			case "complete": return 3;
		}
	};
	return [...runs].sort((a, b) => {
		const byState = rank(a.state) - rank(b.state);
		if (byState !== 0) return byState;
		const aTime = a.lastUpdate ?? a.endedAt ?? a.startedAt;
		const bTime = b.lastUpdate ?? b.endedAt ?? b.startedAt;
		return bTime - aTime;
	});
}

export function listAsyncRuns(asyncDirRoot: string, options: AsyncRunListOptions = {}): AsyncRunSummary[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(asyncDirRoot).filter((entry) => {
			try {
				return isAsyncRunDir(asyncDirRoot, entry);
			} catch (error) {
				if (!options.skipInvalid) throw error;
				console.error(`Skipping invalid async run '${path.join(asyncDirRoot, entry)}':`, error);
				return false;
			}
		});
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw new Error(`Failed to list async runs in '${asyncDirRoot}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	for (const entry of entries) {
		const asyncDir = path.join(asyncDirRoot, entry);
		try {
			const reconciliation = options.reconcile === false
				? undefined
				: reconcileAsyncRun(asyncDir, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
			const status = (reconciliation?.status ?? readStatus(asyncDir)) as (AsyncStatus & { cwd?: string }) | null;
			if (!status) continue;
			const nestedWarnings: string[] = [];
			try {
				const nestedRoute = findNestedRouteForRootId(status.runId || path.basename(asyncDir));
				if (nestedRoute) reconcileNestedAsyncDescendants(nestedRoute, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
			} catch (error) {
				nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
			}
			const summary = asyncStatusToSummary(asyncDir, status, nestedWarnings);
			if (allowedStates && !allowedStates.has(summary.state)) continue;
			if (options.sessionId && summary.sessionId !== options.sessionId) continue;
			runs.push(summary);
		} catch (error) {
			if (!options.skipInvalid) throw error;
			console.error(`Skipping invalid async run '${asyncDir}':`, error);
		}
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

function formatActivityFacts(input: { activityState?: ActivityState; lastActivityAt?: number; currentTool?: string; currentToolStartedAt?: number; currentPath?: string; turnCount?: number; toolCount?: number }): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

function formatStepLine(step: AsyncRunStepSummary): string {
	const display = step.label ? `${step.label} (${step.agent})` : step.agent;
	const phase = step.phase ? `[${step.phase}] ` : "";
	const parts = [`${step.index + 1}. ${phase}${display}`, step.status];
	const activity = formatActivityFacts(step);
	if (activity) parts.push(activity);
	const modelThinking = formatModelThinking(step.model, step.thinking);
	if (modelThinking) parts.push(modelThinking);
	if (step.durationMs !== undefined) parts.push(formatDuration(step.durationMs));
	if (step.tokens) parts.push(`${formatTokens(step.tokens.total)} tok`);
	return parts.join(" | ");
}

export function formatAsyncRunOutputPath(run: Pick<AsyncRunSummary, "asyncDir" | "outputFile">): string | undefined {
	if (!run.outputFile) return undefined;
	return path.isAbsolute(run.outputFile) ? run.outputFile : path.join(run.asyncDir, run.outputFile);
}

export function formatAsyncRunProgressLabel(run: Pick<AsyncRunSummary, "mode" | "state" | "currentStep" | "chainStepCount" | "parallelGroups" | "steps">): string {
	const stepCount = run.steps.length || 1;
	const chainStepCount = run.chainStepCount ?? stepCount;
	const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, chainStepCount);
	const activeGroup = run.currentStep !== undefined
		? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
		: undefined;
	if (activeGroup) {
		const groupSteps = run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count);
		const groupLabel = formatParallelOutcome(groupSteps, activeGroup.count, { showRunning: run.state === "running" });
		if (run.mode === "parallel") return groupLabel;
		return `step ${activeGroup.stepIndex + 1}/${chainStepCount} · parallel group: ${groupLabel}`;
	}
	if (run.mode === "parallel") return formatParallelOutcome(run.steps, stepCount, { showRunning: run.state === "running" });
	if (run.mode === "chain" && run.currentStep !== undefined && groups.length > 0) {
		const logicalStep = flatToLogicalStepIndex(run.currentStep, chainStepCount, groups);
		return `step ${logicalStep + 1}/${chainStepCount}`;
	}
	return run.currentStep !== undefined ? `step ${run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
}

function formatRunHeader(run: AsyncRunSummary): string {
	const stepLabel = formatAsyncRunProgressLabel(run);
	const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
	const activity = formatActivityFacts(run);
	return `${run.id} | ${run.state}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${stepLabel} | ${cwd}`;
}

export function formatAsyncRunList(runs: AsyncRunSummary[], heading = "Active async runs"): string {
	if (runs.length === 0) return `No ${heading.toLowerCase()}.`;

	const lines = [`${heading}: ${runs.length}`, ""];
	for (const run of runs) {
		lines.push(`- ${formatRunHeader(run)}`);
		for (const step of run.steps) {
			lines.push(`  ${formatStepLine(step)}`);
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", maxLines: 12 }));
		}
		const attached = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
		const unattached = run.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
		lines.push(...formatNestedRunStatusLines(unattached, { indent: "  ", maxLines: 12 }));
		for (const warning of run.nestedWarnings ?? []) lines.push(`  Warning: ${warning}`);
		const outputPath = formatAsyncRunOutputPath(run);
		if (outputPath) lines.push(`  output: ${shortenPath(outputPath)}`);
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
