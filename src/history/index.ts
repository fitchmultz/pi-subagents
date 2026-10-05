import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import {
  HistoryIndexError,
  type ReadonlyForegroundResumeRun,
  type HistoryEntry,
  type HistoryEntryInput,
  type HistoryIndexStatus,
  type HistoryOwner,
  type HistoryPage,
  type HistoryPageInput,
  type HistoryRunOptions,
  type HistoryRunPage,
  type HistoryResult,
  type HistorySearchInput,
  type HistorySearchPage,
  type OwnedRun,
  type Request,
} from "./types.ts";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";
import { isObject } from "./values.ts";
import {
  parseRunPage,
  parsePage,
  parseSearchPage,
  parseStatus,
  parseEntry,
  parseResult,
  parseNothing,
  parseBoolean,
  parseResponse,
} from "./wire-models.ts";
export * from "./types.ts";

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Readonly<Error>) => void;
  readonly cleanup: () => void;
}
interface SendOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}
/** Disposable browse process. Authoritative ownership/control/receipt checks stay outside this engine. */
export class SubagentHistoryIndex {
  private process?: ChildProcess;
  private readonly children = new Map<ChildProcess, Promise<void>>();
  private owner?: HistoryOwner;
  private ready?: Promise<void>;
  private unavailable?: Error;
  private closed = false;
  private closing?: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<() => void>();
  private readonly agentDir: string;
  constructor(agentDir: string) {
    this.agentDir = path.resolve(agentDir);
  }
  get failure(): Error | undefined {
    return this.unavailable;
  }
  private track(child: ChildProcess): void {
    const completed: Promise<void> = new Promise((resolve) => {
      const exited = () => {
        child.removeListener("exit", exited);
        child.removeListener("close", exited);
        this.children.delete(child);
        resolve();
      };
      // Disconnected IPC can exit without close; failed spawn instead reports close.
      child.once("exit", exited);
      child.once("close", exited);
    });
    this.children.set(child, completed);
  }
  private message(child: ChildProcess, value: unknown): void {
    if (child !== this.process) {
      return;
    }
    try {
      const response = parseResponse(value);
      if ("changed" in response) {
        this.notify();
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }
      this.pending.delete(response.id);
      pending.cleanup();
      if (response.error) {
        pending.reject(new HistoryIndexError(response.error.code, response.error.message));
      } else {
        pending.resolve(response.value);
      }
    } catch {
      this.stop(new HistoryIndexError("INVALID", "Invalid history IPC response."), child);
    }
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Consumer failure cannot strand IPC requests.
      }
    }
  }
  private spawn(): void {
    const child = fork(
      fileURLToPath(
        new URL(`worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url),
      ),
      [this.agentDir],
      {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
        env: {
          ...process.env,
          PI_PACKAGE_DIR: requirePiPackageRoot(),
          PI_CODING_AGENT_DIR: this.agentDir,
        },
      },
    );
    this.unavailable = undefined;
    this.process = child;
    this.track(child);
    child.on("message", (message: unknown) => {
      this.message(child, message);
    });
    child.on("error", () => {
      this.stop(new HistoryIndexError("UNAVAILABLE", "History process could not start."), child);
    });
    child.on("exit", () => {
      this.stop(
        new HistoryIndexError(
          "UNAVAILABLE",
          "History process exited; retry to reopen the disposable index.",
        ),
        child,
      );
    });
  }
  private stop(error: Readonly<Error>, child = this.process, kill = true): void {
    if (!child || child !== this.process) {
      return;
    }
    this.unavailable = error;
    this.process = undefined;
    this.ready = undefined;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    if (kill && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  private send<T>(
    method: string,
    input: unknown,
    decode: (value: unknown) => T,
    options: SendOptions = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new HistoryIndexError("CLOSED", "History index is closed."));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new HistoryIndexError("CANCELLED", "History request cancelled."));
    }
    const child = this.process;
    if (!child || !child.connected) {
      return Promise.reject(
        new HistoryIndexError("UNAVAILABLE", "History process is unavailable."),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const cancel = () => {
        this.stop(
          new HistoryIndexError(
            "CANCELLED",
            "History request cancelled; the process was stopped and can be reopened.",
          ),
          child,
        );
      };
      const timer = setTimeout(() => {
        this.stop(
          new HistoryIndexError(
            "DEADLINE",
            "History request exceeded its process deadline; retry or narrow the query.",
          ),
          child,
        );
      }, options.timeout ?? 3000);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          try {
            resolve(decode(value));
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new HistoryIndexError("INVALID", "History IPC decoding failed."),
            );
          }
        },
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
        },
      });
      options.signal?.addEventListener("abort", cancel, { once: true });
      child.send({ id, method, input } satisfies Request, (error) => {
        if (error) {
          this.stop(new HistoryIndexError("UNAVAILABLE", "History IPC failed."), child);
        }
      });
    });
  }
  private async ensure(): Promise<void> {
    if (this.closed) {
      throw new HistoryIndexError("CLOSED", "History index is closed.");
    }
    if (this.unavailable) {
      throw this.unavailable;
    }
    if (!this.owner) {
      throw new HistoryIndexError(
        "NO_OWNER",
        "Set genuine restored ownership before querying history.",
      );
    }
    if (!this.process) {
      await Promise.all(this.children.values());
      // close() and setOwner() can change lifecycle state while old children exit.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (this.closed) {
        throw new HistoryIndexError("CLOSED", "History index is closed.");
      }
      // setOwner() may install a replacement while this ensure() waits for child exit.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (this.process === undefined) {
        this.spawn();
        this.ready = this.send("setOwner", this.owner, parseNothing, { timeout: 15_000 });
      }
    }
    await this.ready;
  }
  async setOwner(input: HistoryOwner): Promise<void> {
    if (this.closed) {
      throw new HistoryIndexError("CLOSED", "History index is closed.");
    }
    if (!this.process) {
      await Promise.all(this.children.values());
    }
    // close() may run while the previous child is exiting.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (this.closed) {
      throw new HistoryIndexError("CLOSED", "History index is closed.");
    }
    const snapshot = structuredClone(input);
    if (
      snapshot.ownerSessionId.length === 0 ||
      snapshot.runs.some((run) => run.ownerSessionId !== snapshot.ownerSessionId)
    ) {
      throw new HistoryIndexError(
        "OWNERSHIP",
        "Every run must belong to the current owner session.",
      );
    }
    if (new Set(snapshot.runs.map((run) => run.runId)).size !== snapshot.runs.length) {
      throw new HistoryIndexError("INVALID", "Duplicate owned run IDs.");
    }
    this.owner = snapshot;
    if (!this.process) {
      this.spawn();
    }
    this.ready = this.send("setOwner", snapshot, parseNothing, { timeout: 15_000 });
    await this.ready;
  }
  async updateRun(run: OwnedRun, foreground?: ReadonlyForegroundResumeRun): Promise<void> {
    await this.ensure();
    const owner = this.owner;
    if (
      !owner ||
      run.ownerSessionId !== owner.ownerSessionId ||
      (foreground && foreground.runId !== run.runId)
    ) {
      throw new HistoryIndexError("OWNERSHIP", "Run does not belong to the current owner.");
    }
    const copy = structuredClone(run);
    const fg = foreground === undefined ? undefined : structuredClone(foreground);
    await this.send("updateRun", { run: copy, foreground: fg }, parseNothing);
    const current = this.owner;
    if (!current || current.ownerSessionId !== owner.ownerSessionId) {
      throw new HistoryIndexError("OWNER_CHANGED", "History owner changed during run update.");
    }
    this.owner = {
      ...current,
      runs: [...current.runs.filter((entry) => entry.runId !== run.runId), copy],
      ...(fg
        ? {
            foregroundRuns: [
              ...(current.foregroundRuns ?? []).filter((entry) => entry.runId !== run.runId),
              fg,
            ],
          }
        : {}),
    };
  }
  private async query<T>(
    method: string,
    input: { readonly signal?: AbortSignal },
    decode: (value: unknown) => T,
  ): Promise<T> {
    await this.ensure();
    const { signal, ...wire } = input;
    return this.send(method, wire, decode, { signal });
  }
  async needsControls(): Promise<boolean> {
    await this.ensure();
    return this.send("needsControls", undefined, parseBoolean, { timeout: 15_000 });
  }
  listRuns(options: HistoryRunOptions = {}): Promise<HistoryRunPage> {
    return this.query("listRuns", options, parseRunPage);
  }
  historyPage(input: HistoryPageInput): Promise<HistoryPage> {
    return this.query("historyPage", input, parsePage);
  }
  search(input: HistorySearchInput): Promise<HistorySearchPage> {
    return this.query("search", input, parseSearchPage);
  }
  status(): Promise<HistoryIndexStatus> {
    return this.query("status", {}, parseStatus);
  }
  entry(input: HistoryEntryInput): Promise<HistoryEntry | null> {
    return this.query("entry", input, parseEntry);
  }
  record(input: HistoryEntryInput): Promise<Readonly<Record<string, unknown>> | null> {
    return this.query("record", input, (value) => {
      if (value === null) {
        return null;
      }
      if (!isObject(value)) {
        throw new HistoryIndexError("INVALID", "Invalid history detail response.");
      }
      return value;
    });
  }
  result(
    input: Pick<HistoryEntryInput, "runId" | "index" | "signal">,
  ): Promise<HistoryResult | null> {
    return this.query("result", input, parseResult);
  }
  async refresh(runId?: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (!this.closed) {
      this.unavailable = undefined;
    }
    await this.ensure();
    return this.send("refresh", { runId }, parseNothing, {
      signal: options.signal,
      timeout: 120_000,
    });
  }
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  cancel(): void {
    this.stop(
      new HistoryIndexError(
        "CANCELLED",
        "History process cancelled; explicitly refresh or retry to reopen it.",
      ),
    );
  }
  private async waitForChildren(timers: readonly NodeJS.Timeout[]): Promise<void> {
    await Promise.all(this.children.values());
    for (const timer of timers) {
      clearTimeout(timer);
    }
  }
  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    const child = this.process;
    this.closed = true;
    this.listeners.clear();
    this.unavailable ??= new HistoryIndexError("CLOSED", "History index closed.");
    const timers = [...this.children.keys()].map((owned) => {
      const timer = setTimeout(() => {
        owned.kill("SIGKILL");
      }, 1000);
      timer.unref();
      return timer;
    });
    this.closing = this.waitForChildren(timers);
    if (child) {
      this.stop(new HistoryIndexError("CLOSED", "History index closed."), child, false);
      if (child.connected) {
        child.disconnect();
      } else {
        child.kill("SIGKILL");
      }
    }
    return this.closing;
  }
}
