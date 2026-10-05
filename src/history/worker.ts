import * as fs from "node:fs";
import * as path from "node:path";
import { ownedRunView } from "../runs/shared/run-records.ts";
import { acceptanceHumanAction } from "../runs/shared/acceptance-evaluation.ts";
import { getRunMetadataDir, listRunQuestions } from "../runs/shared/supervisor-questions.ts";
import { HistoryIndexError } from "./types.ts";
import type { ForegroundResumeRun, HistoryOwner, HistoryRunRow, OwnedRun, Request, Response } from "./types.ts";
import type { SubagentState } from "../shared/types.ts";
import { exactTextDigest, HistoryStore, safeText } from "./store.ts";
import { readCanonicalOutput, readSavedOutput } from "./canonical-result.ts";
import { SourceIngest, identity, stamp } from "./ingest.ts";
import { HistoryQueries } from "./queries.ts";

const agentDir = process.argv[2];
process.umask(0o077);
let store: HistoryStore | undefined, queries: HistoryQueries | undefined, owner: HistoryOwner | undefined;
const runs = new Map<string, OwnedRun>(), foreground = new Map<string, ForegroundResumeRun>();
const dirtyRuns = new Set<string>(), dirtySources = new Map<string, boolean>();
const watchers = new Map<string, fs.FSWatcher>();
const sourceWatchers = new Map<string, fs.FSWatcher>();
const watchIdentities = new WeakMap<fs.FSWatcher, string>();
const watchedSources = new Map<string, Map<string, string>>();
let job: SourceIngest | undefined, scheduled = false, closed = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let runErrors = new Set<string>();
const barriers: Array<{ id: number; runId?: string }> = [];
const controlQueries: number[] = [];
function replyControls(id: number): void {
	send({ id, value: Boolean(store!.get("SELECT id FROM runs WHERE attention<4 OR state='live' LIMIT 1")) });
}
function send(response: Response): void { if (process.connected) process.send!(response); }
function changed(): void { send({ changed: true }); }
function errorReply(id: number, error: unknown): void {
	const code = error instanceof HistoryIndexError ? error.code : "UNAVAILABLE";
	// Parser errors can include fragments from the malformed body. IPC/logs must never carry them.
	send({ id, error: { code, message: error instanceof HistoryIndexError ? error.message : "History index operation failed; authoritative files were not substituted for query results." } });
}
function unknown(run: OwnedRun, diagnosis = "Run summary is awaiting background canonical projection."): HistoryRunRow {
	return { ...run, state: "unknown", updatedAt: run.startedAt, attention: ["unknown"], canInterrupt: false, continuations: [],
		children: run.children.map((child) => ({ ...child, state: "unknown", configuration: "legacy-partial" })), diagnosis };
}
function compactView(view: HistoryRunRow): HistoryRunRow {
	return {
		...view, task: safeText(view.task, 2048), error: view.error && safeText(view.error), diagnosis: view.diagnosis && safeText(view.diagnosis), recoveryError: view.recoveryError && safeText(view.recoveryError),
		review: view.review && { ...view.review, message: view.review.message && safeText(view.review.message) }, continuations: [],
		questions: view.questions?.map((question) => ({ questionId: question.questionId, runId: question.runId, ownerSessionId: question.ownerSessionId, ownerTarget: question.ownerTarget,
			agent: question.agent, index: question.index, childSessionId: question.childSessionId, childTarget: question.childTarget, sessionFile: question.sessionFile,
			cwd: question.cwd, pid: question.pid, processIdentity: question.processIdentity, createdAt: question.createdAt, reason: question.reason, message: safeText(question.message, 2048), state: question.state,
			answer: question.answer && { ...question.answer, message: safeText(question.answer.message, 2048) }, delivery: question.delivery, revival: question.revival })),
		children: view.children.map((child) => ({
			agent: child.agent, index: child.index, workflowNodeId: child.workflowNodeId, sessionFile: child.sessionFile, task: child.task && safeText(child.task), label: child.label && safeText(child.label, 256),
			state: child.state, configuration: child.configuration, missingSession: child.missingSession, identityUnavailable: child.identityUnavailable, modelSelection: child.modelSelection,
			savedConfiguration: child.launch && { model: child.launch.model, thinking: child.launch.thinking, modelRecordedAt: child.launch.modelRecordedAt },
			humanAction: child.result?.acceptance && safeText(acceptanceHumanAction(child.result.acceptance), 2048), acceptanceStatus: child.result?.acceptance?.status,
			activity: child.activity && { status: child.activity.status, currentTool: child.activity.currentTool, currentToolArgs: child.activity.currentToolArgs && safeText(child.activity.currentToolArgs, 256), currentPath: child.activity.currentPath,
				streamingText: child.activity.streamingText && safeText(child.activity.streamingText.slice(-2048), 2048), lastActivityAt: child.activity.lastActivityAt, recentOutput: child.activity.recentOutput?.slice(-4).map((line) => safeText(line, 256)) },
			result: child.result && { agent: child.result.agent, task: safeText(child.result.task), exitCode: child.result.exitCode,
				usage: child.result.usage && { input: child.result.usage.input, output: child.result.usage.output, cacheRead: child.result.usage.cacheRead, cacheWrite: child.result.usage.cacheWrite, cost: child.result.usage.cost, turns: child.result.usage.turns },
				finalOutput: safeText(child.result.finalOutput, 1024), error: child.result.error && safeText(child.result.error), sessionFile: child.result.sessionFile, terminalEntryId: child.result.terminalEntryId, terminalLeafId: child.result.terminalLeafId,
				detached: child.result.detached, interrupted: child.result.interrupted, timedOut: child.result.timedOut, nativeSessionId: child.result.nativeSessionId, accounting: child.result.accounting,
				agentProcessExit: child.result.agentProcessExit, model: child.result.model, fullOutputPath: child.result.fullOutputPath },
		})), summary: safeText(view.children.map((child) => child.result?.finalOutput ?? child.result?.error ?? "").filter(Boolean).join(" | "), 1024),
	};
}
function projection(run: OwnedRun): HistoryRunRow {
	const state: SubagentState = {
		baseCwd: run.cwd, currentSessionId: owner!.ownerSessionId, ownedRuns: runs, foregroundRuns: foreground,
		asyncJobs: new Map(), cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear() {} },
	};
	const questions = listRunQuestions(getRunMetadataDir(run.runId)).filter((question) => question.ownerSessionId === owner!.ownerSessionId && ["awaiting_input", "answer_pending"].includes(question.state));
	const options = { pendingInput: questions.length > 0, includeContinuations: false, readConfiguration: false as const, reconcile: false };
	return { ...ownedRunView(run, state, options), questions };
}
function watch(directory: string, recursive: boolean, listener: (name: string | null) => void, handles = watchers): void {
	const existing = handles.get(directory);
	try {
		const physical = identity(fs.statSync(directory, { bigint: true }));
		if (existing && watchIdentities.get(existing) === physical) return;
		const watcher = fs.watch(directory, { recursive }, (event, name) => {
			const filename = name?.toString() ?? null;
			if (event === "rename" && filename === path.basename(directory) && handles.get(directory) === watcher) {
				watchIdentities.delete(watcher);
				watch(directory, recursive, listener, handles);
				listener(null);
			} else listener(filename);
			schedule();
		});
		watchIdentities.set(watcher, physical);
		watcher.on("error", () => { watcher.close(); if (handles.get(directory) === watcher) handles.delete(directory); });
		watcher.on("close", () => { if (handles.get(directory) === watcher) handles.delete(directory); });
		handles.set(directory, watcher);
		// Native close fences macOS stream re-registration; admit the replacement first.
		existing?.close();
	} catch {
		if (existing && handles.get(directory) === existing) watchIdentities.delete(existing);
		/* Known-handle background census recovers absent directories and dropped watches. */
	}
}
function resetDirectoryWatch(directory: string): void {
	for (const handles of [watchers, sourceWatchers]) {
		const watcher = handles.get(directory);
		if (watcher) watchIdentities.delete(watcher);
	}
	for (const id of watchedSources.get(directory)?.keys() ?? []) dirtySources.set(id, dirtySources.get(id) ?? false);
}
function watchSources(directory: string): void {
	if (!watchedSources.has(directory)) return;
	watch(directory, false, (name) => {
		for (const [id, filename] of watchedSources.get(directory) ?? []) if (!name || filename === name) {
			if (!dirtySources.has(id) && job?.id !== id) {
				try {
					const source = store?.source(id);
					if (source?.stamp && ["current", "partial", "degraded"].includes(source.state)
						&& source.stamp === stamp(fs.statSync(source.path, { bigint: true }))) continue;
				} catch { /* Missing or unreadable sources still need reconciliation. */ }
			}
			dirtySources.set(id, dirtySources.get(id) ?? false);
		}
	}, sourceWatchers);
}
function installWatches(runId?: string): void {
	if (!owner || !store) return;
	const root = path.join(agentDir, "sessions", "subagent-runs");
	// Linux emulates recursive watching by scanning directories on creation.
	// Only admitted run trees may incur that work, never the global foreign tree.
	watch(root, false, (name) => {
		const runId = name;
		for (const id of runId ? runs.has(runId) ? [runId] : [] : runs.keys()) {
			const directory = path.join(root, id);
			resetDirectoryWatch(directory);
			dirtyRuns.add(id);
		}
	});
	for (const id of runId ? [runId] : runs.keys()) {
		const directory = path.join(root, id);
		watch(directory, true, (name) => {
			if (!name) resetDirectoryWatch(directory);
			dirtyRuns.add(id);
		});
		watchSources(directory);
	}
	for (const source of store.all(`SELECT id,path FROM sources WHERE id IN (SELECT source_id FROM children${runId ? " WHERE run_id=?" : ""})`, ...(runId ? [runId] : []))) {
		const directory = path.dirname(source.path);
		let linked = watchedSources.get(directory);
		if (!linked) watchedSources.set(directory, linked = new Map());
		linked.set(source.id, path.basename(source.path));
		watchSources(directory);
	}
}
function prune(previousSources?: string[]): void {
	if (!store) return;
	if (previousSources && !previousSources.length) return;
	store.transaction(() => {
		let removed = false;
		if (!previousSources) for (const row of store!.all("SELECT id FROM runs")) if (!runs.has(row.id)) { store!.run("DELETE FROM runs WHERE id=?", row.id); removed = true; }
		for (const source of store!.all(`SELECT id,path FROM sources WHERE id NOT IN (SELECT source_id FROM children WHERE source_id IS NOT NULL)${previousSources ? ` AND id IN (${previousSources.map(() => "?").join(",")})` : ""}`, ...(previousSources ?? []))) {
			if (job && job.id === source.id) { job.close(); job = undefined; }
			dirtySources.delete(source.id);
			watchedSources.get(path.dirname(source.path))?.delete(source.id);
			store!.deleteDocuments(source.id);
			store!.run("DELETE FROM entries WHERE source_id=?", source.id); store!.run("DELETE FROM sources WHERE id=?", source.id); removed = true;
		}
		if (removed) store!.bump();
	});
}
function admit(run: OwnedRun): void {
	if (!owner || run.ownerSessionId !== owner.ownerSessionId) throw new HistoryIndexError("OWNERSHIP", "Run is not owned by this session.");
	if (!/^[a-zA-Z0-9_-]+$/.test(run.runId) || !Array.isArray(run.children) || run.children.some((child) => !Number.isSafeInteger(child.index) || child.index < 0) || new Set(run.children.map((child) => child.index)).size !== run.children.length) throw new HistoryIndexError("INVALID", "Invalid run or child identity.");
	if (!Number.isSafeInteger(run.startedAt) || run.startedAt < 0) throw new HistoryIndexError("INVALID", "Invalid run timestamp.");
	runs.set(run.runId, run); dirtyRuns.add(run.runId);
	if (!store!.get("SELECT id FROM runs WHERE id=?", run.runId)) { const view = unknown(run); store!.putView(compactView(view), view); }
}
function hasPending(runId?: string): boolean {
	if (!runId) return Boolean(dirtyRuns.size || dirtySources.size || job);
	if (dirtyRuns.has(runId)) return true;
	const ids = store!.all("SELECT source_id FROM children WHERE run_id=?", runId).map((row) => row.source_id);
	return ids.some((id) => dirtySources.has(id) || job?.id === id);
}
function finishBarriers(): void {
	if (!dirtyRuns.size) for (const id of controlQueries.splice(0)) replyControls(id);
	for (let index = barriers.length - 1; index >= 0; index--) {
		const barrier = barriers[index];
		if (hasPending(barrier.runId)) continue;
		barriers.splice(index, 1);
		const failures = barrier.runId ? store!.get("SELECT COUNT(*) AS count FROM sources s JOIN children c ON c.source_id=s.id WHERE c.run_id=? AND s.state IN ('error','missing','degraded')", barrier.runId).count : store!.get("SELECT COUNT(*) AS count FROM sources WHERE state IN ('error','missing','degraded')").count;
		if (failures || (barrier.runId ? runErrors.has(barrier.runId) : runErrors.size)) errorReply(barrier.id, new HistoryIndexError("DEGRADED", "Refresh completed with missing, malformed, or unavailable owned sources; inspect page freshness."));
		else send({ id: barrier.id });
	}
}
function schedule(): void {
	if (scheduled || closed || retryTimer) return;
	scheduled = true; setImmediate(pump);
}
function pump(): void {
	scheduled = false;
	if (closed || !store) return;
	try {
		if (dirtyRuns.size) {
			const id = dirtyRuns.values().next().value!; dirtyRuns.delete(id);
			installWatches(id);
			const previousSources = store.all("SELECT source_id FROM children WHERE run_id=? AND source_id IS NOT NULL", id).map((child) => child.source_id);
			try { store.operations.runProjections++; const view = projection(runs.get(id)!); store.putView(compactView(view), view); runErrors.delete(id); }
			catch { const view = unknown(runs.get(id)!, "Canonical owner summary is unavailable. Completion remains unconfirmed."); store.putView(compactView(view), view); runErrors.add(id); }
			prune(previousSources);
			for (const child of store.all("SELECT source_id FROM children WHERE run_id=? AND source_id IS NOT NULL", id)) if (child.source_id !== job?.id) dirtySources.set(child.source_id, dirtySources.get(child.source_id) ?? false);
			installWatches(id); changed();
		} else if (job) {
			if (job.step()) {
				const source = store.source(job.id);
				if (source) watchSources(path.dirname(source.path));
				job = undefined; changed();
			}
		} else if (dirtySources.size) {
			const [id, force] = dirtySources.entries().next().value!; dirtySources.delete(id);
			const source = store.source(id);
			if (source) { activeSource = id; job = new SourceIngest(store, source, force); }
		}
	} catch (error) {
		const id = job?.id ?? activeSource;
		job?.close(); job = undefined;
		if (id && store.source(id)) {
			if (error instanceof HistoryIndexError && error.code === "INDEX_BUSY") {
				dirtySources.set(id, true);
				retryTimer = setTimeout(() => { retryTimer = undefined; schedule(); }, 50);
			} else if (error instanceof HistoryIndexError && error.code === "SOURCE_CHANGED") dirtySources.set(id, true);
			else if ((error as NodeJS.ErrnoException).code === "ENOENT") store.resetSource(id, "missing", "Linked native conversation is missing.");
			else store.run("UPDATE sources SET state='error',error=?,checked_at=? WHERE id=?", "Linked native conversation could not be indexed.", Date.now(), id);
		}
		if (!(error instanceof HistoryIndexError && error.code === "INDEX_BUSY")) changed();
	}
	activeSource = undefined;
	finishBarriers();
	if (hasPending()) schedule();
}
let activeSource: string | undefined;
function census(): void {
	if (!owner || !store) return;
	for (const id of runs.keys()) dirtyRuns.add(id);
	for (const source of store.all("SELECT id FROM sources WHERE id IN (SELECT source_id FROM children)")) dirtySources.set(source.id, false);
	installWatches(); schedule();
}
const timer = setInterval(census, 30_000); timer.unref();
function clear(): void {
	clearTimeout(retryTimer); retryTimer = undefined;
	job?.close(); job = undefined;
	for (const watcher of watchers.values()) watcher.close(); watchers.clear(); watchedSources.clear();
	for (const watcher of sourceWatchers.values()) watcher.close(); sourceWatchers.clear();
	dirtyRuns.clear(); dirtySources.clear(); runs.clear(); foreground.clear(); runErrors = new Set();
	for (const id of controlQueries.splice(0)) errorReply(id, new HistoryIndexError("OWNER_CHANGED", "History owner changed during control discovery."));
	for (const barrier of barriers.splice(0)) errorReply(barrier.id, new HistoryIndexError("OWNER_CHANGED", "History owner changed during refresh."));
	store?.close(); store = undefined; queries = undefined;
}
async function handle(request: Request): Promise<void> {
	try {
		const input = request.input;
		if (request.method === "setOwner") {
			if (!input?.ownerSessionId || input.runs?.some((run: OwnedRun) => run.ownerSessionId !== input.ownerSessionId)) throw new HistoryIndexError("OWNERSHIP", "Invalid ownership snapshot.");
			clear(); owner = input;
			fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
			store = new HistoryStore(agentDir, owner!.ownerSessionId);
			for (const run of owner!.runs) admit(run);
			for (const fg of owner!.foregroundRuns ?? []) { if (!runs.has(fg.runId)) throw new HistoryIndexError("OWNERSHIP", "Foreground snapshot is not an admitted owned run."); foreground.set(fg.runId, fg); }
			prune();
			queries = new HistoryQueries(store, () => {
				const info = store!.info(dirtyRuns.size + dirtySources.size + (job ? 1 : 0));
				info.freshness.errors += runErrors.size;
				if (info.freshness.errors && !info.freshness.pending) info.freshness.state = "degraded";
				return info;
			});
			for (const source of store.all("SELECT id FROM sources WHERE id IN (SELECT source_id FROM children)")) dirtySources.set(source.id, true);
			installWatches(); schedule(); send({ id: request.id }); return;
		}
		if (!store || !queries) throw new HistoryIndexError("NO_OWNER", "Set genuine restored ownership first.");
		switch (request.method) {
			case "updateRun":
				admit(input.run);
				if (input.foreground) foreground.set(input.run.runId, input.foreground);
				schedule(); send({ id: request.id }); break;
			case "refresh": {
				if (input.runId && !runs.has(input.runId)) throw new HistoryIndexError("OWNERSHIP", "Run is not admitted by this owner.");
				for (const id of input.runId ? [input.runId] : runs.keys()) dirtyRuns.add(id);
				for (const child of store.all(`SELECT DISTINCT source_id FROM children WHERE source_id IS NOT NULL${input.runId ? " AND run_id=?" : ""}`, ...(input.runId ? [input.runId] : []))) dirtySources.set(child.source_id, true);
				barriers.push({ id: request.id, runId: input.runId }); schedule(); break;
			}
			case "status": send({ id: request.id, value: { ...store.info(dirtyRuns.size + dirtySources.size + (job ? 1 : 0)), databaseFile: store.file,
				physicalSources: Number(store.get("SELECT COUNT(*) AS count FROM sources").count), publishedEntries: Number(store.get("SELECT COUNT(*) AS count FROM entries WHERE published=1").count), operations: { ...store.operations } } }); break;
			case "needsControls":
				if (dirtyRuns.size) { controlQueries.push(request.id); schedule(); }
				else replyControls(request.id);
				break;
			case "listRuns": store.operations.queries++; send({ id: request.id, value: queries.listRuns(input) }); break;
			case "historyPage": store.operations.queries++; send({ id: request.id, value: queries.historyPage(input) }); break;
			case "search": store.operations.queries++; send({ id: request.id, value: queries.search(input) }); break;
			case "result": {
				const run = runs.get(input.runId);
				if (!run) throw new HistoryIndexError("OWNERSHIP", "Run is not admitted by this owner.");
				if (!Number.isSafeInteger(input.index) || input.index < 0) throw new HistoryIndexError("INVALID", "Invalid child index.");
				const view = projection(run), child = view.children.find((candidate) => candidate.index === input.index);
				if (!child) throw new HistoryIndexError("OWNERSHIP", "Child is not admitted by this owner.");
				if (!child.result) { send({ id: request.id, value: null }); break; }
				const file = view.resultPath ?? path.join(getRunMetadataDir(run.runId), "contracts", `${input.index}.json`);
				const text = child.result.fullOutputPath ? readSavedOutput(child.result.fullOutputPath)
					: fs.existsSync(file) ? readCanonicalOutput(file, input.index) ?? child.result.finalOutput ?? "" : child.result.finalOutput ?? "";
				if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new HistoryIndexError("RECORD_TOO_LARGE", "Selected canonical output exceeds the 16 MiB detail budget.");
				const boundary = child.state === "live" ? {} : { terminalEntryId: child.result.terminalEntryId, endedAt: child.result.terminalEntryId ? undefined : view.updatedAt };
				const finalResultId = queries.finalResultId({ runId: run.runId, index: input.index, ...boundary }, exactTextDigest(text));
				send({ id: request.id, value: { text, timestamp: view.updatedAt, finalResultId } }); break;
			}
			case "entry": send({ id: request.id, value: queries.selected(input, false) }); break;
			case "record": send({ id: request.id, value: queries.selected(input, true) }); break;
			default: throw new HistoryIndexError("INVALID", "Unknown history operation.");
		}
	} catch (error) { errorReply(request.id, error); }
}
process.on("message", (request: Request) => { void handle(request); });
process.on("disconnect", () => { closed = true; clearInterval(timer); clear(); process.exit(0); });
