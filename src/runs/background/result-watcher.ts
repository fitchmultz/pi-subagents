import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate as yieldToInput } from "node:timers/promises";
import { getRunMetadataDir } from "../shared/supervisor-questions.ts";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import { journalStamp } from "../../shared/journal-reader.ts";
import { resolveOrchestratorIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	type IntercomEventBus,
	type NestedRunSummary,
	type SubagentResultIntercomChild,
	type SubagentState,
} from "../../shared/types.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	compactNestedResultChildren,
	deliverSubagentResultIntercomEvent,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";
import { projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.ts";
import { isDurableRun, readAsyncResultFile } from "./async-result-file.ts";

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;

type ResultWatcherDeps = {
	reconcileDelivery?: (runId: string, completionKey: string, accounting?: boolean) => boolean;
	isCompletionPublished?: (runId: string, completionKey: string) => boolean;
	withReceiptBatch?: (work: () => void) => void;
};

function sanitizeNestedResultChildren(value: unknown, resultPath: string, label: string): NestedRunSummary[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		console.error(`Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`);
		return undefined;
	}
	const children = value.map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child));
	if (children.length !== value.length) {
		console.error(`Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`);
	}
	return children.length ? children : undefined;
}

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

function isNotFoundError(error: unknown): boolean {
	if (getErrorCode(error) === "ENOENT") return true;
	const cause = error instanceof Error ? error.cause : undefined;
	return getErrorCode(cause) === "ENOENT";
}

function shouldFallBackToPolling(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === "EMFILE" || code === "ENOSPC";
}

export function createResultWatcher(
	pi: { events: IntercomEventBus },
	state: SubagentState,
	resultsDir: string,
	deps: ResultWatcherDeps = {},
): {
	startResultWatcher: () => void;
	primeExistingResults: () => void;
	stopResultWatcher: (options?: { preservePending?: boolean; joinInFlight?: boolean }) => void;
	joinInFlight: () => Promise<void>;
} {
	let periodicScanTimer: ReturnType<typeof setInterval> | null = null;
	const processingCompletionKeys = new Set<string>();
	const inFlight = new Set<Promise<void>>();
	let startTail = Promise.resolve(), generation = 0, preserveBeforeGeneration = 0;
	let joiningGeneration: number | undefined;
	const foreignResults = new Map<string, { stamp: string; sessionId: string | null; runId: string; ownerSessionId?: string; canonicalPath?: string; canonicalStamp?: string }>();

	const pendingResultFiles = () => {
		const files = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter((name) => name.endsWith(".json")) : [];
		const notified = new Map(files.map((file, index) => [file, index]));
		for (const run of state.ownedRuns?.values() ?? []) {
			if (run.source !== "async" || run.accounting?.state !== "incomplete" && run.delivery?.entryId) continue;
			const file = path.join(getRunMetadataDir(run.runId), "result.json");
			if (!fs.existsSync(file)) continue;
			// Disposable hints cannot veto canonical recovery, including corrupt hints.
			const notification = notified.get(`${run.runId}.json`);
			if (notification === undefined) files.push(file);
			else files[notification] = file;
		}
		const present = new Set(files.map((file) => path.isAbsolute(file) ? file : path.join(resultsDir, file)));
		for (const file of foreignResults.keys()) if (!present.has(file)) foreignResults.delete(file);
		return files.filter((file) => {
			const resultPath = path.isAbsolute(file) ? file : path.join(resultsDir, file);
			try { return !isForeignUnchanged(resultPath); }
			catch (error) { if (isNotFoundError(error)) { foreignResults.delete(resultPath); return false; } return true; }
		});
	};

	const isForeignUnchanged = (resultPath: string): boolean => {
		const cached = foreignResults.get(resultPath);
		if (!cached || cached.sessionId !== state.currentSessionId || cached.ownerSessionId !== state.ownedRuns?.get(cached.runId)?.ownerSessionId) return false;
		return cached.stamp === journalStamp(fs.statSync(resultPath, { bigint: true }))
			&& (!cached.canonicalPath || cached.canonicalStamp === journalStamp(fs.statSync(cached.canonicalPath, { bigint: true })));
	};

	const handleResult = async (file: string) => {
		const startedGeneration = generation, ownerSessionId = state.currentSessionId;
		let claimedCompletionKey: string | undefined;
		let completionEmitted = false;
		const durableFile = path.isAbsolute(file);
		const resultPath = durableFile ? file : path.join(resultsDir, file);
		if (!fs.existsSync(resultPath)) return;
		try {
			if (isForeignUnchanged(resultPath)) return;
			const stamp = journalStamp(fs.statSync(resultPath, { bigint: true }));
			const notification = readAsyncResultFile(resultPath);
			const runId = notification.runId ?? notification.id ?? path.basename(file, ".json");
			const run = state.ownedRuns?.get(runId);
			const canonicalPath = isDurableRun(notification) && !durableFile ? path.join(getRunMetadataDir(runId), "result.json") : undefined;
			const canonicalStamp = canonicalPath ? journalStamp(fs.statSync(canonicalPath, { bigint: true })) : undefined;
			const data = canonicalPath ? readAsyncResultFile(canonicalPath) : notification;
			if ((data.runId ?? data.id ?? runId) !== runId) throw new Error(`Result identity does not match notification '${runId}'.`);
			if (durableFile && resultPath !== path.join(getRunMetadataDir(runId), "result.json")) throw new Error(`Canonical result identity does not match path '${resultPath}'.`);
			if (data.sessionId ? data.sessionId !== state.currentSessionId && run?.ownerSessionId !== state.currentSessionId : !run) {
				if (stamp) foreignResults.set(resultPath, { stamp, sessionId: state.currentSessionId, runId, ownerSessionId: run?.ownerSessionId, canonicalPath, canonicalStamp });
				return;
			}
			foreignResults.delete(resultPath);
			const consumeNotification = () => {
				// A legacy hint can be the only saved result. Native queue admission
				// is not publication; retain it until the verified parent receipt exists.
				if (!durableFile && !canonicalPath && deps.isCompletionPublished && !deps.isCompletionPublished(runId, completionKey)) return;
				const hint = durableFile ? path.join(resultsDir, `${runId}.json`) : resultPath;
				if (fs.existsSync(hint)) fs.unlinkSync(hint);
			};
			data.completionId ??= `legacy:${runId}:${data.timestamp ?? "unknown"}`;
			const completionKey = buildCompletionKey({ ...data, id: runId }, "result");
			if (deps.reconcileDelivery ? deps.reconcileDelivery(runId, completionKey) : state.isRunResultConsumed?.(runId)) { consumeNotification(); return; }
			if (state.waitingRuns?.has(runId)) {
				pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { ...data, runId, suppressNotification: true, intercomResultDelivered: false });
				return;
			}
			const hasExplicitNestedChildren = data.nestedChildren !== undefined;
			let nestedChildren = compactNestedResultChildren(sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"));
			if (!nestedChildren?.length && !hasExplicitNestedChildren) {
				try {
					nestedChildren = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
				} catch (error) {
					console.error(`Failed to enrich subagent result file '${resultPath}' with nested registry children; will retry later:`, error);
					return;
				}
			}
			const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
			const resultChildren = hasResultChildren
				? data.results!
				: [{
					agent: data.agent,
					output: data.summary,
					success: data.success,
				}];
			const normalizedChildren = attachNestedChildrenToResultChildren(runId, resultChildren.map((result = {}, index): SubagentResultIntercomChild => {
				const baseOutput = result.output ?? result.finalOutput ?? data.summary;
				const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
				const output = hasRealOutput ? baseOutput : "(no output)";
				const summary = result.success === false && result.error
					? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
					: output;
				const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
				const childNestedChildren = sanitizeNestedResultChildren(result.children, resultPath, `results[${index}].children`);
				return {
					agent: result.agent ?? data.agent ?? `step-${index + 1}`,
					status: resolveSubagentResultStatus({
						success: result.success,
						exitCode: result.exitCode ?? undefined,
						acceptance: result.acceptance,
						interrupted: result.interrupted,
						state: result.interrupted || typeof result.success !== "boolean" ? data.state : undefined,
					}),
					summary,
					index,
					artifactPath: result.artifactPaths?.outputPath,
					metadataPath: result.artifactPaths?.metadataPath,
					...(typeof sessionPath === "string" && fs.existsSync(sessionPath) ? { sessionPath } : {}),
					...(result.intercomTarget ? { intercomTarget: result.intercomTarget } : {}),
					...(childNestedChildren ? { children: childNestedChildren } : {}),
				};
			}), nestedChildren);

			if (processingCompletionKeys.has(completionKey)) return;
			// Owned queue/receipt reconciliation above remains authoritative after TTL expiry.
			if (markSeenWithTtl(state.completionSeen, completionKey, Date.now(), 10 * 60 * 1000)) {
				consumeNotification();
				return;
			}
			processingCompletionKeys.add(completionKey);
			claimedCompletionKey = completionKey;

			// Saved ownership is stable; the owner's live intercom identity can change on restart.
			const intercomTarget = resolveOrchestratorIntercomTarget(pi.events, data.intercomTarget?.trim() ?? "");
			let intercomResultDelivered = false;
			if (intercomTarget) {
				const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain"
					? data.mode
					: resultChildren.length > 1 ? "chain" : "single";
				const savedResultPath = path.join(getRunMetadataDir(runId), "result.json");
				const payload = buildSubagentResultIntercomPayload({
					to: intercomTarget,
					runId,
					completionId: data.completionId,
					mode,
					source: "async",
					...(fs.existsSync(savedResultPath) ? { resultPath: savedResultPath } : {}),
					status: resolveSubagentResultStatus({ state: data.terminalState }),
					error: data.workflowGraph?.nodes.find((node) => node.error)?.error,
					children: normalizedChildren,
					asyncId: data.id,
					asyncDir: data.asyncDir,
				});
				intercomResultDelivered = await deliverSubagentResultIntercomEvent(pi.events, payload);
			}
			if (startedGeneration !== generation && startedGeneration !== joiningGeneration || ownerSessionId !== state.currentSessionId) {
				state.completionSeen.delete(completionKey);
				return;
			}

			// Shutdown closes native turn ingress. Retain failed deliveries for the
			// next startup, while still recording acknowledgements already accepted.
			if (!intercomResultDelivered && startedGeneration < preserveBeforeGeneration) return;

			const { terminalState: _terminalState, ...eventData } = data;
			pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				...eventData,
				agent: data.agent ?? normalizedChildren.map((child) => child.agent).join(", "),
				summary: data.summary?.trim() ? data.summary : normalizedChildren.map((child) => child.summary).join("\n\n"),
				runId,
				completionKey,
				intercomResultDelivered,
				...(nestedChildren?.length ? { nestedChildren } : {}),
				...(Array.isArray(data.results) ? {
					results: hasResultChildren
						? normalizedChildren.map((child, index) => ({
							...data.results![index],
							agent: child.agent,
							status: child.status,
							summary: child.summary,
							index: child.index,
							artifactPath: child.artifactPath,
							sessionPath: child.sessionPath,
							children: child.children,
						}))
						: [],
				} : {}),
			});
			completionEmitted = true;
			consumeNotification();
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to process subagent result file '${resultPath}':`, error);
		} finally {
			if (claimedCompletionKey) {
				processingCompletionKeys.delete(claimedCompletionKey);
				if (!completionEmitted) state.completionSeen.delete(claimedCompletionKey);
			}
		}
	};

	const scheduled = new Set<string>();
	let drainGeneration: number | undefined;
	const scheduleResult = (file: string) => {
		scheduled.add(file);
		if (drainGeneration === generation) return;
		drainGeneration = generation;
		const scheduledGeneration = generation;
		startTail = startTail.then(async () => {
			try {
				while (scheduled.size) {
					await yieldToInput();
					if (scheduledGeneration !== generation) return;
					const files = [...scheduled].slice(0, 4);
					for (const file of files) scheduled.delete(file);
					// Only synchronous starts share publication proof. Async delivery
					// resumes outside this scope; yield between batches for native input.
					const start = () => {
						for (const file of files) {
							if (scheduledGeneration !== generation) return;
							const tail = handleResult(file);
							inFlight.add(tail);
							void tail.finally(() => inFlight.delete(tail));
						}
					};
					if (deps.withReceiptBatch) deps.withReceiptBatch(start); else start();
				}
			} finally { if (drainGeneration === scheduledGeneration) drainGeneration = undefined; }
		});
	};
	state.resultFileCoalescer = createFileCoalescer(scheduleResult, 50);

	const primeExistingResults = () => {
		try {
			// Admit one recovery scan synchronously; separate zero-delay file timers
			// can split the same scan into additional verification batches.
			pendingResultFiles().forEach(scheduleResult);
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
		}
	};

	const ensurePeriodicScan = () => {
		if (periodicScanTimer) return;
		periodicScanTimer = setInterval(primeExistingResults, POLL_INTERVAL_MS);
		periodicScanTimer.unref?.();
	};

	const clearPeriodicScan = () => {
		if (!periodicScanTimer) return;
		clearInterval(periodicScanTimer);
		periodicScanTimer = null;
	};

	const startPollingFallback = (reason: unknown) => {
		state.watcher?.close();
		state.watcher = null;
		clearPeriodicScan();
		if (state.watcherRestartTimer) return;

		console.error(
			`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`,
		);
		primeExistingResults();
		state.watcherRestartTimer = setInterval(primeExistingResults, POLL_INTERVAL_MS);
		state.watcherRestartTimer.unref?.();
	};

	const scheduleRestart = () => {
		if (state.watcherRestartTimer) return;
		state.watcherRestartTimer = setTimeout(() => {
			state.watcherRestartTimer = null;
			try {
				fs.mkdirSync(resultsDir, { recursive: true });
				startResultWatcher();
			} catch (error) {
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
				scheduleRestart();
			}
		}, WATCHER_RESTART_DELAY_MS);
		state.watcherRestartTimer.unref?.();
	};

	const startResultWatcher = () => {
		if (state.watcher) {
			ensurePeriodicScan();
			return;
		}
		if (state.watcherRestartTimer) {
			clearTimeout(state.watcherRestartTimer);
			clearInterval(state.watcherRestartTimer);
			state.watcherRestartTimer = null;
		}
		try {
			state.watcher = fs.watch(resultsDir, (ev, file) => {
				if (ev !== "rename" || !file) return;
				const fileName = file.toString();
				if (!fileName.endsWith(".json")) return;
				if (!fs.existsSync(path.join(resultsDir, fileName))) return;
				state.resultFileCoalescer.schedule(fileName);
			});
			state.watcher.on("error", (error) => {
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
				state.watcher?.close();
				state.watcher = null;
				scheduleRestart();
			});
			state.watcher.unref?.();
			ensurePeriodicScan();
		} catch (error) {
			if (shouldFallBackToPolling(error)) {
				startPollingFallback(error);
				return;
			}
			console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
			state.watcher = null;
			scheduleRestart();
		}
	};

	const stopResultWatcher = (options: { preservePending?: boolean; joinInFlight?: boolean } = {}) => {
		joiningGeneration = options.joinInFlight ? generation : undefined;
		generation++;
		if (options.preservePending) preserveBeforeGeneration = generation;
		state.watcher?.close();
		state.watcher = null;
		clearPeriodicScan();
		if (state.watcherRestartTimer) {
			clearTimeout(state.watcherRestartTimer);
			clearInterval(state.watcherRestartTimer);
		}
		state.watcherRestartTimer = null;
		state.resultFileCoalescer.clear();
		scheduled.clear();
		foreignResults.clear();
	};

	const joinInFlight = async () => {
		await Promise.all([...inFlight]);
		joiningGeneration = undefined;
	};

	return { startResultWatcher, primeExistingResults, stopResultWatcher, joinInFlight };
}
