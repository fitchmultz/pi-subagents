import * as fs from "node:fs";
import * as path from "node:path";
import { formatAsyncRunList, formatAsyncRunOutputPath, formatAsyncRunProgressLabel, listAsyncRuns } from "./async-status.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { formatModelThinking } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import { ASYNC_DIR, RESULTS_DIR, type AsyncStatus, type Details, type NestedRunSummary, type SubagentState, type SubagentExecutionResult } from "../../shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { resolveAsyncRunLocation } from "./async-resume.ts";
import { resolveSubagentRunId } from "./run-id-resolver.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { attachRootChildrenToSteps, findNestedRouteForRootId, projectNestedRegistryForRoot, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { readAsyncResultFile } from "./async-result-file.ts";

interface RunStatusParams {
	action?: "status";
	id?: string;
	runId?: string;
	dir?: string;
}

interface RunStatusDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	state?: SubagentState;
	nested?: NestedRunResolutionScope;
}

function hasExistingSessionFile(value: unknown): value is string {
	return typeof value === "string" && fs.existsSync(value);
}

function formatResumeGuidance(runId: string | undefined, children: Array<{ agent?: unknown; sessionFile?: unknown }>, fallbackSessionFile?: unknown): string {
	const knownChildren = children
		.map((child, index) => ({ child, index }))
		.filter(({ child }) => typeof child.agent === "string");
	if (!runId || knownChildren.length === 0) return "Resume: unavailable; no child session file was persisted.";
	const singleSessionFile = knownChildren[0]?.child.sessionFile ?? fallbackSessionFile;
	if (children.length === 1 && knownChildren.length === 1 && hasExistingSessionFile(singleSessionFile)) {
		return `Revive: subagent({ action: "resume", id: "${runId}", message: "..." })`;
	}
	const childWithSession = knownChildren.find(({ child }) => hasExistingSessionFile(child.sessionFile));
	if (childWithSession) {
		return `Revive child: subagent({ action: "resume", id: "${runId}", index: ${childWithSession.index}, message: "..." })`;
	}
	return "Resume: unavailable; no child session file was persisted.";
}

function formatAcceptanceFinalizationSummary(finalization: NonNullable<NonNullable<AsyncStatus["steps"]>[number]["acceptance"]>["finalization"] | undefined): string {
	if (!finalization) return "";
	return `, finalization: ${finalization.status} after ${finalization.turns.length}/${finalization.maxTurns} turns`;
}

function formatOutputExcerpt(outputPath: string | undefined, maxBytes = 4096, maxLines = 12): string[] {
	if (!outputPath || !fs.existsSync(outputPath)) return [];
	try {
		const buffer = fs.readFileSync(outputPath);
		const truncatedBytes = buffer.length > maxBytes;
		const text = buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf-8").trim();
		if (!text) return [];
		const allLines = text.split(/\r?\n/);
		const lines = allLines.slice(-maxLines);
		const truncatedLines = allLines.length > maxLines;
		const suffix = truncatedBytes || truncatedLines ? " (tail, truncated)" : "";
		return [`Output excerpt${suffix}:`, ...lines.map((line) => `  ${line}`)];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [`Output excerpt unavailable: ${message}`];
	}
}

function stepLineLabel(status: AsyncStatus, index: number): string {
	const steps = status.steps ?? [];
	if (status.mode === "parallel") return `Agent ${index + 1}/${steps.length || 1}`;
	if (status.mode === "chain") {
		const chainStepCount = status.chainStepCount ?? (steps.length || 1);
		const groups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
		const group = groups.find((candidate) => index >= candidate.start && index < candidate.start + candidate.count);
		if (group) return `Step ${group.stepIndex + 1}/${chainStepCount} Agent ${index - group.start + 1}/${group.count}`;
		return `Step ${flatToLogicalStepIndex(index, chainStepCount, groups) + 1}/${chainStepCount}`;
	}
	return `Step ${index + 1}`;
}

function nestedRunDisplayName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.join(", ");
	return run.id;
}

function formatNestedExactStatus(rootRunId: string, run: NestedRunSummary): string {
	const lines = [
		`Nested run: ${run.id}`,
		`Root: ${rootRunId}`,
		`Parent: ${run.parentRunId}${run.parentStepIndex !== undefined ? ` step ${run.parentStepIndex + 1}` : ""}`,
		`State: ${run.state}`,
		run.activityState || run.lastActivityAt ? `Activity: ${formatActivityLabel(run.lastActivityAt, run.activityState)}` : undefined,
		run.mode ? `Mode: ${run.mode}` : undefined,
		`Agent: ${nestedRunDisplayName(run)}`,
		run.currentStep !== undefined ? `Progress: step ${run.currentStep + 1}/${run.chainStepCount ?? run.steps?.length ?? 1}` : undefined,
		run.asyncDir ? `Dir: ${run.asyncDir}` : undefined,
		run.sessionFile ? `Session: ${run.sessionFile}` : undefined,
		run.error ? `Error: ${run.error}` : undefined,
	].filter((line): line is string => Boolean(line));
	if (run.path.length) {
		lines.push(`Path: ${run.path.map((part) => `${part.runId}${part.stepIndex !== undefined ? `:${part.stepIndex + 1}` : ""}${part.agent ? `:${part.agent}` : ""}`).join(" > ")} > ${run.id}`);
	}
	if (run.steps?.length) {
		lines.push("Steps:");
		for (const [index, step] of run.steps.entries()) {
			const activity = step.status === "running" ? formatActivityLabel(step.lastActivityAt, step.activityState) : undefined;
			lines.push(`  ${index + 1}. ${step.agent} ${step.status}${activity ? `, ${activity}` : ""}${step.error ? `, error: ${step.error}` : ""}`);
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", commandHints: true }));
		}
	}
	lines.push(...formatNestedRunStatusLines(run.children, { indent: "  ", commandHints: true }));
	lines.push("Commands:", `  Status: subagent({ action: "status", id: "${run.id}" })`, `  Interrupt: subagent({ action: "interrupt", id: "${run.id}" })`, `  Resume: subagent({ action: "resume", id: "${run.id}", message: "..." })`, `  Root status: subagent({ action: "status", id: "${rootRunId}" })`);
	return lines.join("\n");
}

export function inspectSubagentStatus(params: RunStatusParams, deps: RunStatusDeps = {}): SubagentExecutionResult {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	if (!params.id && !params.runId && !params.dir) {
		if (deps.nested) {
			return {
				content: [{ type: "text", text: "Child-safe subagent status requires an id when no foreground run is active." }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		try {
			const runs = listAsyncRuns(asyncDirRoot, { states: ["queued", "running"], resultsDir, kill: deps.kill, now: deps.now });
			return {
				content: [{ type: "text", text: formatAsyncRunList(runs) }],
				details: { mode: "single", results: [] },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	let location;
	try {
		const requestedId = params.id ?? params.runId;
		if (!params.dir && requestedId) {
			const resolved = resolveSubagentRunId(requestedId, { asyncDirRoot, resultsDir, state: deps.state, nested: deps.nested });
			if (resolved?.kind === "nested") {
				reconcileNestedAsyncDescendants(resolved.match.route, { resultsDir, kill: deps.kill, now: deps.now });
				const refreshed = resolveSubagentRunId(requestedId, { asyncDirRoot, resultsDir, state: deps.state, nested: deps.nested });
				const nested = refreshed?.kind === "nested" ? refreshed : resolved;
				return { content: [{ type: "text", text: formatNestedExactStatus(nested.match.rootRunId, nested.match.run) }], details: { mode: "single", results: [] } };
			}
			if (resolved?.kind === "async") location = resolved.location;
			else location = { asyncDir: null, resultPath: null, resolvedId: requestedId };
		} else {
			location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const { asyncDir, resultPath, resolvedId } = location;

	if (!asyncDir && !resultPath) {
		return {
			content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	if (asyncDir) {
		let reconciliation;
		try {
			reconciliation = reconcileAsyncRun(asyncDir, { resultsDir, kill: deps.kill, now: deps.now });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		const status = reconciliation.status;
		const effectiveRunId = status?.runId ?? resolvedId ?? "unknown";
		const logPath = path.join(asyncDir, `subagent-log-${effectiveRunId}.md`);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		if (status) {
			let nestedChildren: NestedRunSummary[] = [];
			let nestedWarning: string | undefined;
			try {
				const nestedRoute = findNestedRouteForRootId(status.runId);
				if (nestedRoute) reconcileNestedAsyncDescendants(nestedRoute, { resultsDir, kill: deps.kill, now: deps.now });
				nestedChildren = projectNestedRegistryForRoot(status.runId)?.children ?? [];
				attachRootChildrenToSteps(status.runId, status.steps, nestedChildren);
			} catch (error) {
				nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}
			const outputPath = formatAsyncRunOutputPath({ asyncDir, outputFile: status.outputFile });
			const progressLabel = formatAsyncRunProgressLabel({
				mode: status.mode,
				state: status.state,
				currentStep: status.currentStep,
				chainStepCount: status.chainStepCount,
				parallelGroups: status.parallelGroups,
				steps: (status.steps ?? []).map((step, index) => ({ index, agent: step.agent, status: step.status })),
			});
			const started = new Date(status.startedAt).toISOString();
			const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";
			const statusActivityText = status.state === "running" ? formatActivityLabel(status.lastActivityAt, status.activityState) : undefined;

			const lines = [
				`Run: ${status.runId}`,
				`State: ${status.state}`,
				statusActivityText ? `Activity: ${statusActivityText}` : undefined,
				`Mode: ${status.mode}`,
				`Progress: ${progressLabel}`,
				`Started: ${started}`,
				`Updated: ${updated}`,
				`Dir: ${asyncDir}`,
				outputPath ? `Output: ${outputPath}` : undefined,
				reconciliation.message ? `Diagnosis: ${reconciliation.message}` : undefined,
				reconciliation.resultPath && fs.existsSync(reconciliation.resultPath) ? `Result: ${reconciliation.resultPath}` : undefined,
			].filter((line): line is string => Boolean(line));
			if (status.state !== "running") lines.push(...formatOutputExcerpt(outputPath));

			for (const [index, step] of (status.steps ?? []).entries()) {
				const stepActivityText = step.status === "running" ? formatActivityLabel(step.lastActivityAt, step.activityState) : undefined;
				const modelThinking = formatModelThinking(step.model, step.thinking);
				const modelText = modelThinking ? ` (${modelThinking})` : "";
				const errorText = step.error ? `, error: ${step.error}` : "";
				const finalizationText = formatAcceptanceFinalizationSummary(step.acceptance?.finalization);
				const acceptanceText = step.acceptance?.status ? `, acceptance: ${step.acceptance.status}${finalizationText}` : "";
				const display = step.label ? `${step.label} (${step.agent})` : step.agent;
				const phase = step.phase ? `[${step.phase}] ` : "";
				lines.push(`${stepLineLabel(status, index)}: ${phase}${display} ${step.status}${modelText}${stepActivityText ? `, ${stepActivityText}` : ""}${acceptanceText}${errorText}`);
				lines.push(...formatNestedRunStatusLines(step.children, { indent: "  ", commandHints: true, maxLines: 20 }));
				const stepOutputPath = path.join(asyncDir, `output-${index}.log`);
				if (stepOutputPath !== outputPath && fs.existsSync(stepOutputPath)) lines.push(`  Output: ${stepOutputPath}`);
				if (step.status === "running") {
					lines.push(`  Intercom target: ${resolveSubagentIntercomTarget(status.runId, step.agent, index)} (if registered)`);
				}
			}
			const attached = new Set((status.steps ?? []).flatMap((step) => step.children?.map((child) => child.id) ?? []));
			const unattached = nestedChildren.filter((child) => !attached.has(child.id));
			lines.push(...formatNestedRunStatusLines(unattached, { indent: "", commandHints: true, maxLines: 20 }));
			if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
			if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
			if (status.state !== "running") {
				lines.push(formatResumeGuidance(status.runId, status.steps ?? [], status.sessionFile));
			}
			if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
			if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		}
	}

	if (resultPath) {
		try {
			const data = readAsyncResultFile(resultPath);
			const status = data.terminalState;
			const runId = data.runId ?? data.id ?? resolvedId;
			const lines = [`Run: ${runId}`, `State: ${status}`, `Result: ${resultPath}`];
			const children = Array.isArray(data.results) ? data.results : data.agent ? [{ agent: data.agent, sessionFile: data.sessionFile }] : [];
			lines.push(formatResumeGuidance(runId, children, data.sessionFile));
			if (data.summary) lines.push("", data.summary);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Failed to read async result file: ${message}` }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	return {
		content: [{ type: "text", text: "Status file not found." }],
		isError: true,
		details: { mode: "single", results: [] },
	};
}
