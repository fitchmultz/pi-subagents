import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { HistoryIndexError } from "./types.ts";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";
import type { ForegroundResumeRun, HistoryEntry, HistoryEntryInput, HistoryIndexStatus, HistoryOwner, HistoryPage, HistoryPageInput, HistoryRunOptions, HistoryRunPage, HistoryResult, HistorySearchInput, HistorySearchPage, OwnedRun, Request, Response } from "./types.ts";
export * from "./types.ts";

/** A disposable browse index. Authoritative owner/control/receipt checks remain outside this engine. */
export class SubagentHistoryIndex {
	private process?: ChildProcess;
	private children = new Map<ChildProcess, Promise<void>>();
	private owner?: HistoryOwner;
	private ready?: Promise<void>;
	private unavailable?: Error;
	private closed = false;
	private closing?: Promise<void>;
	private sequence = 0;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }>();
	private listeners = new Set<() => void>();
	private agentDir: string;
	constructor(agentDir: string) { this.agentDir = path.resolve(agentDir); }
	get failure(): Error | undefined { return this.unavailable; }

	private spawn(): void {
		const child = fork(fileURLToPath(new URL(`worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url)), [this.agentDir], {
			execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
			env: { ...process.env, PI_PACKAGE_DIR: requirePiPackageRoot(), PI_CODING_AGENT_DIR: this.agentDir },
		});
		this.unavailable = undefined;
		this.process = child;
		this.children.set(child, new Promise<void>((resolve) => {
			const exited = () => {
				child.removeListener("exit", exited); child.removeListener("close", exited);
				this.children.delete(child); resolve();
			};
			// Disconnected IPC children can exit without Node emitting close. Exit already
			// releases their database and watch handles; failed spawns report close instead.
			child.once("exit", exited); child.once("close", exited);
		}));
		child.on("message", (message: Response) => {
			if (child !== this.process) return;
			if ("changed" in message) {
				for (const listener of this.listeners) { try { listener(); } catch { /* Consumer failures must not strand IPC requests. */ } }
				return;
			}
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id); pending.cleanup();
			if (message.error) pending.reject(new HistoryIndexError(message.error.code, message.error.message));
			else pending.resolve(message.value);
		});
		child.on("error", () => this.stop(new HistoryIndexError("UNAVAILABLE", "History process could not start."), child));
		child.on("exit", () => this.stop(new HistoryIndexError("UNAVAILABLE", "History process exited; retry to reopen the disposable index."), child));
	}
	private stop(error: Error, child = this.process, kill = true): void {
		if (!child || child !== this.process) return;
		this.unavailable = error;
		this.process = undefined; this.ready = undefined;
		for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
		this.pending.clear();
		if (kill && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	private send<T>(method: string, input?: any, signal?: AbortSignal, timeout = 3000): Promise<T> {
		if (this.closed) return Promise.reject(new HistoryIndexError("CLOSED", "History index is closed."));
		if (signal?.aborted) return Promise.reject(new HistoryIndexError("CANCELLED", "History request cancelled."));
		const child = this.process;
		if (!child?.connected) return Promise.reject(new HistoryIndexError("UNAVAILABLE", "History process is unavailable."));
		return new Promise<T>((resolve, reject) => {
			const id = ++this.sequence;
			const cancel = () => this.stop(new HistoryIndexError("CANCELLED", "History request cancelled; the process was stopped and can be reopened."), child);
			const timer = setTimeout(() => this.stop(new HistoryIndexError("DEADLINE", "History request exceeded its process deadline; retry or narrow the query."), child), timeout);
			timer.unref();
			this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } });
			signal?.addEventListener("abort", cancel, { once: true });
			child.send({ id, method, input } satisfies Request, (error) => { if (error) this.stop(new HistoryIndexError("UNAVAILABLE", "History IPC failed."), child); });
		});
	}
	private async ensure(): Promise<void> {
		if (this.closed) throw new HistoryIndexError("CLOSED", "History index is closed.");
		if (this.unavailable) throw this.unavailable;
		if (!this.owner) throw new HistoryIndexError("NO_OWNER", "Set genuine restored ownership before querying history.");
		if (!this.process) {
			await Promise.all(this.children.values());
			if (this.closed) throw new HistoryIndexError("CLOSED", "History index is closed.");
			if (!this.process) { this.spawn(); this.ready = this.send<void>("setOwner", this.owner, undefined, 15_000); }
		}
		await this.ready;
	}
	/** Arms an ordinary deadline only in the continuation that saw the current admission and worker settle, never behind a replacement admission. */
	private async admitted<T>(method: string, input?: any, signal?: AbortSignal, timeout?: number): Promise<T> {
		await this.ensure();
		const ready = this.ready, child = this.process;
		await ready;
		// setOwner() or a restart may have replaced readiness during either await; wait for the replacement.
		if (!child || ready !== this.ready || child !== this.process) return this.admitted<T>(method, input, signal, timeout);
		return this.send<T>(method, input, signal, timeout);
	}
	async setOwner(input: HistoryOwner): Promise<void> {
		if (this.closed) throw new HistoryIndexError("CLOSED", "History index is closed.");
		if (!this.process) await Promise.all(this.children.values());
		if (this.closed) throw new HistoryIndexError("CLOSED", "History index is closed.");
		// Snapshot inputs so later caller mutation cannot silently change admission or replay.
		const snapshot = structuredClone(input);
		if (!snapshot.ownerSessionId || snapshot.runs.some((run) => run.ownerSessionId !== snapshot.ownerSessionId)) throw new HistoryIndexError("OWNERSHIP", "Every run must belong to the current owner session.");
		if (new Set(snapshot.runs.map((run) => run.runId)).size !== snapshot.runs.length) throw new HistoryIndexError("INVALID", "Duplicate owned run IDs.");
		this.owner = snapshot;
		if (!this.process) this.spawn();
		this.ready = this.send<void>("setOwner", snapshot, undefined, 15_000);
		await this.ready;
	}
	async updateRun(run: OwnedRun, foreground?: ForegroundResumeRun): Promise<void> {
		await this.ensure();
		if (run.ownerSessionId !== this.owner!.ownerSessionId || foreground && foreground.runId !== run.runId) throw new HistoryIndexError("OWNERSHIP", "Run does not belong to the current owner.");
		const copy = structuredClone(run), fg = foreground && structuredClone(foreground);
		await this.admitted<void>("updateRun", { run: copy, foreground: fg });
		this.owner!.runs = [...this.owner!.runs.filter((entry) => entry.runId !== run.runId), copy];
		if (fg) this.owner!.foregroundRuns = [...(this.owner!.foregroundRuns ?? []).filter((entry) => entry.runId !== run.runId), fg];
	}
	private async query<T>(method: string, input: { signal?: AbortSignal }): Promise<T> {
		const { signal, ...wire } = input;
		return this.admitted<T>(method, wire, signal);
	}
	/** Tool discovery waits for run metadata only, not transcript backfill. */
	needsControls(): Promise<boolean> { return this.admitted("needsControls", undefined, undefined, 15_000); }
	listRuns(options: HistoryRunOptions = {}): Promise<HistoryRunPage> { return this.query("listRuns", options); }
	historyPage(input: HistoryPageInput): Promise<HistoryPage> { return this.query("historyPage", input); }
	search(input: HistorySearchInput): Promise<HistorySearchPage> { return this.query("search", input); }
	status(): Promise<HistoryIndexStatus> { return this.query("status", {}); }
	/** Validated bounded preview, including paired tools outside the current page. */
	entry(input: HistoryEntryInput): Promise<HistoryEntry | null> { return this.query("entry", input); }
	/** Explicit selected detail only; records over 16 MiB fail with RECORD_TOO_LARGE. */
	record(input: HistoryEntryInput): Promise<Record<string, any> | null> { return this.query("record", input); }
	/** Selected canonical output, never a transcript scan or a truncated-preview match. */
	result(input: Pick<HistoryEntryInput, "runId" | "index" | "signal">): Promise<HistoryResult | null> { return this.query("result", input); }
	async refresh(runId?: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		if (!this.closed) this.unavailable = undefined;
		return this.admitted("refresh", { runId }, options.signal, 120_000);
	}
	onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	/** Hard cancellation affects this instance's outstanding work, not native sessions or other indexers. */
	cancel(): void { this.stop(new HistoryIndexError("CANCELLED", "History process cancelled; explicitly refresh or retry to reopen it.")); }
	close(): Promise<void> {
		if (this.closing) return this.closing;
		const child = this.process;
		this.closed = true; this.listeners.clear();
		this.unavailable ??= new HistoryIndexError("CLOSED", "History index closed.");
		const timers = [...this.children.keys()].map((owned) => { const timer = setTimeout(() => owned.kill("SIGKILL"), 1000); timer.unref(); return timer; });
		this.closing = Promise.all(this.children.values()).then(() => { for (const timer of timers) clearTimeout(timer); });
		if (child) {
			this.stop(new HistoryIndexError("CLOSED", "History index closed."), child, false);
			if (child.connected) child.disconnect(); else child.kill("SIGKILL");
		}
		return this.closing;
	}
}
