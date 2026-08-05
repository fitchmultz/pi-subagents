import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import { formatControlNoticeMessage } from "../shared/subagent-control.ts";
import {
	type AsyncJobState,
	type AsyncStartedEvent,
	type ControlEvent,
	type SubagentState,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { findNestedRouteForRootId, hasLiveNestedDescendants, updateAsyncJobNestedProjection } from "../shared/nested-events.ts";
import { listAsyncRuns } from "./async-status.ts";
import { isTuiContext } from "../../shared/ui-mode.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	restoreDiscoveryGraceMs?: number;
	resultsDir?: string;
	statSync?: typeof fs.statSync;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	restoreJobs: (sessionId: string, ctx: ExtensionContext) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const restoreDiscoveryGraceMs = options.restoreDiscoveryGraceMs ?? 2000;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	let restoreDiscoverySessionId: string | undefined;
	let restoreDiscoveryDeadline = 0;
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, jobs);
		const uiWithRender: ExtensionContext["ui"] & { requestRender?: () => void } = ctx.ui;
		uiWithRender.requestRender?.();
	};
	const cancelCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (!existingTimer) return;
		clearTimeout(existingTimer);
		state.cleanupTimers.delete(asyncId);
	};
	const scheduleCleanup = (asyncId: string) => {
		cancelCleanup(asyncId);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			if (state.lastUiContext) {
				rerenderWidget(state.lastUiContext);
			}
		}, completionRetentionMs);
		state.cleanupTimers.set(asyncId, timer);
	};
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			if (job.controlEventCursor === undefined) {
				job.controlEventCursor = stat.size;
				return;
			}
			const cursor = stat.size < job.controlEventCursor ? 0 : job.controlEventCursor;
			if (stat.size <= cursor) return;
			const buffer = Buffer.alloc(stat.size - cursor);
			fs.readSync(fd, buffer, 0, buffer.length, cursor);
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			job.controlEventCursor = cursor + lastNewline + 1;
			for (const line of buffer.subarray(0, lastNewline).toString("utf-8").split("\n")) {
				if (!line.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
					continue;
				}
				if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "subagent.control") continue;
				const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
				if (!record.event || record.event.type !== "needs_attention" || !Array.isArray(record.channels)) continue;
				const payload = {
					event: record.event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget: record.childIntercomTarget,
					noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
				};
				if (record.channels.includes("event")) {
					pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
				}
				if (record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
					pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
						...payload,
						to: record.intercom.to,
						message: record.intercom.message,
					});
				}
			}
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			let widgetChanged = false;
			if (restoreDiscoverySessionId) {
				if (Date.now() <= restoreDiscoveryDeadline) {
					try {
						widgetChanged = discoverRestoredJobs(restoreDiscoverySessionId);
					} catch (error) {
						console.error("Failed to discover active async jobs:", error);
					}
				} else {
					restoreDiscoverySessionId = undefined;
					restoreDiscoveryDeadline = 0;
				}
			}
			if (state.asyncJobs.size === 0) {
				if (restoreDiscoverySessionId) return;
				if (state.lastUiContext && isTuiContext(state.lastUiContext)) rerenderWidget(state.lastUiContext, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}
			for (const job of state.asyncJobs.values()) {
				const widgetStateBefore = widgetRenderKey(job);
				let nestedRefreshFailed = false;
				const refreshNestedProjection = () => {
					try {
						updateAsyncJobNestedProjection(job);
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
				};
				const reconcileNestedDescendants = () => {
					try {
						if (job.nestedRoute) reconcileNestedAsyncDescendants(job.nestedRoute, { resultsDir, kill: options.kill, now: options.now });
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
					refreshNestedProjection();
				};
				try {
					emitNewControlEvents(job);
					reconcileNestedDescendants();
					const reconciliation = reconcileAsyncRun(job.asyncDir, {
						resultsDir,
						kill: options.kill,
						now: options.now,
						startedRun: {
							runId: job.asyncId,
							pid: job.pid,
							sessionId: job.sessionId,
							mode: job.mode,
							agents: job.agents,
							chainStepCount: job.chainStepCount,
							parallelGroups: job.parallelGroups,
							startedAt: job.startedAt,
							sessionFile: job.sessionFile,
						},
					});
					const status = reconciliation.status ?? readStatus(job.asyncDir);
					if (status) {
						const previousStatus = job.status;
						job.status = status.state;
						if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused") cancelCleanup(job.asyncId);
						job.sessionId = status.sessionId ?? job.sessionId;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
						job.currentTool = status.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt;
						job.currentPath = status.currentPath;
						job.turnCount = status.turnCount ?? job.turnCount;
						job.toolCount = status.toolCount ?? job.toolCount;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.chainStepCount = status.chainStepCount ?? job.chainStepCount;
						job.startedAt = status.startedAt ?? job.startedAt;
						if (status.lastUpdate !== undefined) job.updatedAt = status.lastUpdate;
						if (status.steps?.length) {
							const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
							job.parallelGroups = groups.length ? groups : job.parallelGroups;
							const activeGroup = status.currentStep !== undefined
								? groups.find((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count)
								: undefined;
							const visibleSteps = activeGroup
								? status.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
								: status.steps.map((step, index) => ({ ...step, index }));
							job.activeParallelGroup = Boolean(activeGroup);
							job.agents = visibleSteps.map((step) => step.agent);
							job.steps = visibleSteps;
							refreshNestedProjection();
							job.stepsTotal = visibleSteps.length;
							job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
							job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
							if (status.state === "complete") job.completedSteps = visibleSteps.length;
						}
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						if ((job.status === "complete" || job.status === "failed" || job.status === "paused") && !nestedRefreshFailed && !hasLiveNestedDescendants(job.nestedChildren) && (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
							scheduleCleanup(job.asyncId);
						}
						if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
						continue;
					}
					if (job.status === "queued") {
						job.status = "running";
						job.updatedAt = Date.now();
					}
				} catch (error) {
					if (job.status !== "failed") {
						console.error(`Failed to read async status for '${job.asyncDir}':`, error);
						job.status = "failed";
						job.updatedAt = Date.now();
					}
					if (!hasLiveNestedDescendants(job.nestedChildren) && !state.cleanupTimers.has(job.asyncId)) {
						scheduleCleanup(job.asyncId);
					}
				}
				if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
			}

			if (widgetChanged && state.lastUiContext && isTuiContext(state.lastUiContext)) rerenderWidget(state.lastUiContext);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const rawAgents = info.agents?.length ? info.agents : info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0
			? rawAgents?.slice(0, firstGroupCount)
			: rawAgents;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			pid: typeof info.pid === "number" ? info.pid : undefined,
			...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
			mode: info.mode ?? (info.chain ? "chain" : "single"),
			agents,
			chainStepCount: info.chainStepCount,
			parallelGroups: validParallelGroups,
			nestedRoute: info.nestedRoute,
			stepsTotal: firstGroupCount ?? agents?.length,
			activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
			controlEventCursor: 0,
			startedAt: now,
			updatedAt: now,
		});
		ensurePoller();
		if (state.lastUiContext && isTuiContext(state.lastUiContext)) {
			rerenderWidget(state.lastUiContext);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; state?: string; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		let nestedRefreshFailed = false;
		if (job) {
			job.status = result.state === "paused" ? "paused" : result.success ? "complete" : "failed";
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
			try {
				updateAsyncJobNestedProjection(job);
			} catch (error) {
				nestedRefreshFailed = true;
				console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
			}
		}
		if (state.lastUiContext && isTuiContext(state.lastUiContext)) {
			rerenderWidget(state.lastUiContext);
		}
		if (!nestedRefreshFailed && !hasLiveNestedDescendants(job?.nestedChildren)) scheduleCleanup(asyncId);
	};

	const discoverRestoredJobs = (sessionId: string): boolean => {
		let changed = false;
		for (const run of listAsyncRuns(asyncDirRoot, {
			states: ["queued", "running"],
			sessionId,
			resultsDir,
			kill: options.kill,
			now: options.now,
			skipInvalid: true,
		})) {
			if (state.asyncJobs.has(run.id)) continue;
			const groups = run.parallelGroups ?? [];
			const activeGroup = run.currentStep !== undefined
				? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
				: undefined;
			const steps = activeGroup
				? run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count)
				: run.steps;
			let controlEventCursor: number | undefined = 0;
			try {
				controlEventCursor = (options.statSync ?? fs.statSync)(path.join(run.asyncDir, "events.jsonl")).size;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					controlEventCursor = undefined;
					console.error(`Failed to inspect async control events for '${run.asyncDir}':`, error);
				}
			}
			let nestedRoute: ReturnType<typeof findNestedRouteForRootId>;
			try {
				nestedRoute = findNestedRouteForRootId(run.id);
			} catch (error) {
				console.error(`Failed to restore nested async descendants for '${run.asyncDir}':`, error);
			}
			state.asyncJobs.set(run.id, {
				asyncId: run.id,
				asyncDir: run.asyncDir,
				status: run.state,
				pid: run.pid,
				sessionId: run.sessionId,
				activityState: run.activityState,
				lastActivityAt: run.lastActivityAt,
				currentTool: run.currentTool,
				currentToolStartedAt: run.currentToolStartedAt,
				currentPath: run.currentPath,
				turnCount: run.turnCount,
				toolCount: run.toolCount,
				mode: run.mode,
				agents: steps.map((step) => step.agent),
				currentStep: run.currentStep,
				chainStepCount: run.chainStepCount,
				parallelGroups: groups,
				steps,
				stepsTotal: steps.length,
				runningSteps: steps.filter((step) => step.status === "running").length,
				completedSteps: steps.filter((step) => step.status === "complete" || step.status === "completed").length,
				activeParallelGroup: Boolean(activeGroup),
				startedAt: run.startedAt,
				updatedAt: run.lastUpdate ?? run.startedAt,
				totalTokens: run.totalTokens,
				sessionFile: run.sessionFile,
				controlEventCursor,
				nestedRoute,
				nestedChildren: run.nestedChildren,
			});
			changed = true;
		}
		return changed;
	};

	const restoreJobs = (sessionId: string, ctx: ExtensionContext) => {
		restoreDiscoverySessionId = sessionId;
		restoreDiscoveryDeadline = Date.now() + restoreDiscoveryGraceMs;
		try {
			discoverRestoredJobs(sessionId);
		} catch (error) {
			console.error("Failed to discover active async jobs:", error);
		}
		if (isTuiContext(ctx)) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx);
		}
		ensurePoller();
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		restoreDiscoverySessionId = undefined;
		restoreDiscoveryDeadline = 0;
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx && isTuiContext(ctx)) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	return { ensurePoller, handleStarted, handleComplete, restoreJobs, resetJobs };
}
