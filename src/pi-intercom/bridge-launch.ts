import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { loadNativeSession } from "../shared/native-session-loader.ts";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import type { SessionInfo } from "./types.ts";
import type { Identity } from "./bridge-config.ts";
import type { LaunchPolicy } from "./bridge-launch-policy.ts";
import { Fault, cancelled, log, wait } from "./bridge-protocol.ts";
import { RpcProcess } from "./bridge-rpc-process.ts";

interface Launch {
  readonly identity: Identity;
  readonly name: string;
  readonly controller: Readonly<AbortController>;
  readonly expires: number;
  admitted: boolean;
  sessionId?: string;
  peerId?: string;
  sessionFile?: string;
  process?: RpcProcess;
  timer?: NodeJS.Timeout;
  settled?: Promise<UnknownRecord>;
}
interface StartContext {
  readonly identity: Identity;
  readonly expires: number;
  readonly signal: AbortSignal;
  readonly peers: (
    signal: AbortSignal,
  ) => Promise<readonly Readonly<Pick<SessionInfo, "id" | "name" | "cwd">>[]>;
}

export function sameIdentity(left: Identity, right: Identity | undefined): boolean {
  return (
    left.name === right?.name &&
    left.cwd === right.cwd &&
    JSON.stringify(left.launch) === JSON.stringify(right.launch)
  );
}
function view(entry: Readonly<Launch>): UnknownRecord {
  return {
    sessionId: entry.sessionId,
    peerId: entry.peerId,
    name: entry.name,
    sessionFile: entry.sessionFile,
    pid: entry.process?.pid,
    status: entry.process?.status ?? "starting",
    error: entry.process?.failure?.code,
  };
}

export class Launcher {
  private readonly launches = new Set<Launch>();
  private stopping = false;

  list(identity: Identity): UnknownRecord {
    return {
      sessions: [...this.launches]
        .filter((entry) => entry.identity.fingerprint256 === identity.fingerprint256)
        .map(view),
    };
  }
  async stop(identity: Identity, sessionId: string): Promise<UnknownRecord> {
    const entry = [...this.launches].find(
      (candidate) =>
        candidate.identity.fingerprint256 === identity.fingerprint256 &&
        candidate.sessionId === sessionId,
    );
    if (!entry) {
      throw new Fault(404, "unknown_session", "Session is not owned by this identity and helper.");
    }
    await this.retire(entry, new Fault(410, "session_stopped", "Session stopped by its owner."));
    return { session: view(entry) };
  }
  async start(name: string, context: StartContext): Promise<UnknownRecord> {
    cancelled(context.signal);
    const policy = context.identity.launch;
    if (!policy || this.stopping) {
      throw new Fault(403, "launch_disabled", "Session launching is not enabled by local policy.");
    }
    const fullName = `remote:${context.identity.name}:${name}`;
    const existing = [...this.launches].find(
      (entry) =>
        entry.identity.fingerprint256 === context.identity.fingerprint256 &&
        entry.name === fullName &&
        entry.process?.status !== "exited",
    );
    if (existing) {
      return this.reuse(existing);
    }
    this.capacity(context.identity, policy);
    const entry: Launch = {
      identity: context.identity,
      name: fullName,
      controller: new AbortController(),
      expires: context.expires,
      admitted: false,
    };
    this.launches.add(entry);
    entry.settled = this.establish(entry, policy, context);
    try {
      return await entry.settled;
    } catch (error) {
      await this.retire(entry, new Fault(503, "launch_failed", "Pi startup failed."));
      if (!entry.process) {
        this.launches.delete(entry);
      }
      throw error instanceof Fault
        ? error
        : new Fault(
            503,
            "launch_failed",
            "Pi startup failed; inspect the pinned local policy and resources.",
          );
    }
  }
  private reuse(entry: Readonly<Launch>): UnknownRecord {
    if (
      entry.admitted &&
      (entry.process?.status === "idle" || entry.process?.status === "running")
    ) {
      return { session: view(entry), reused: true };
    }
    throw new Fault(
      409,
      "launch_in_progress",
      "This named session is starting or stopping; inspect sessions before retrying.",
    );
  }
  private capacity(identity: Identity, policy: LaunchPolicy): void {
    const active = [...this.launches].filter((entry) => entry.process?.status !== "exited");
    if (
      active.length >= 32 ||
      active.filter((entry) => entry.identity.fingerprint256 === identity.fingerprint256).length >=
        policy.maxSessions
    ) {
      throw new Fault(
        429,
        "session_limit",
        "Local launched-session capacity reached; stop an owned session first.",
      );
    }
    for (const entry of this.launches) {
      if (this.launches.size >= 64 && entry.process?.status === "exited") {
        this.launches.delete(entry);
      }
    }
  }
  private async journal(entry: Launch, policy: LaunchPolicy): Promise<void> {
    const { SessionManager } = await wait(
      loadNativeSession(policy.packageRoot),
      entry.controller.signal,
    );
    cancelled(entry.controller.signal);
    const storage = statSync(policy.sessionDir);
    if (
      !storage.isDirectory() ||
      storage.uid !== process.getuid?.() ||
      (storage.mode & 0o777) !== 0o700
    ) {
      throw new Fault(503, "storage_invalid", "Private launch storage is no longer valid.");
    }
    const previous = process.umask(0o077);
    try {
      const manager = SessionManager.create(entry.identity.cwd, policy.sessionDir);
      manager.appendSessionInfo(entry.name);
      manager.appendMessage({ role: "user", content: policy.context, timestamp: Date.now() });
      entry.sessionId = manager.getSessionId();
      entry.sessionFile = manager.getSessionFile();
      entry.peerId = `pi-${createHash("sha256").update(entry.sessionId).digest("hex").slice(0, 32)}`;
      if (entry.sessionFile === undefined || (statSync(entry.sessionFile).mode & 0o777) !== 0o600) {
        throw new Fault(503, "journal_invalid", "Native journal was not privately persisted.");
      }
      const saved = SessionManager.open(entry.sessionFile, policy.sessionDir);
      if (
        saved.getSessionId() !== entry.sessionId ||
        saved.getSessionName() !== entry.name ||
        saved.getCwd() !== entry.identity.cwd
      ) {
        throw new Fault(503, "journal_invalid", "Native journal identity did not persist.");
      }
    } finally {
      process.umask(previous);
    }
  }
  private async establish(
    entry: Launch,
    policy: LaunchPolicy,
    context: StartContext,
  ): Promise<UnknownRecord> {
    const signal = AbortSignal.any([context.signal, entry.controller.signal]);
    const deadline = setTimeout(
      () =>
        entry.controller.abort(
          new Fault(504, "launch_timeout", "Pi startup readiness deadline exceeded."),
        ),
      policy.startupTimeoutMs,
    );
    const abort = () =>
      entry.controller.abort(
        new Fault(499, "launch_cancelled", "Session startup cancelled or exceeded its deadline."),
      );
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.journal(entry, policy);
      cancelled(signal);
      if (entry.sessionFile === undefined) {
        throw new Fault(503, "journal_invalid", "Native journal path unavailable.");
      }
      entry.process = new RpcProcess(policy, entry.identity.cwd, entry.sessionFile);
      this.expiry(entry);
      const state = await entry.process.state(signal);
      this.validateState(entry, policy, state);
      await this.peerReady(entry, context.peers, signal);
      cancelled(signal);
      entry.process.ready();
      entry.admitted = true;
      log("launch_ready", {
        fingerprint: entry.identity.fingerprint256,
        name: entry.name,
        peer: entry.peerId,
        pid: entry.process.pid,
        result: "ready",
      });
      return { session: view(entry), reused: false };
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
    }
  }
  private validateState(entry: Readonly<Launch>, policy: LaunchPolicy, state: UnknownRecord): void {
    if (
      state.sessionId !== entry.sessionId ||
      state.sessionFile !== entry.sessionFile ||
      state.sessionName !== entry.name ||
      state.isStreaming !== false ||
      state.pendingMessageCount !== 0 ||
      !isRecord(state.model) ||
      state.model.provider !== policy.provider ||
      state.model.id !== policy.model
    ) {
      throw new Fault(
        503,
        "readiness_failed",
        "Pi did not start idle with the exact saved session and configured model.",
      );
    }
  }
  private async peerReady(
    entry: Readonly<Launch>,
    peers: StartContext["peers"],
    signal: AbortSignal,
  ): Promise<void> {
    while (!entry.process?.failure) {
      cancelled(signal);
      // Registration is asynchronous after native session_start; observe real broker publication.
      // oxlint-disable-next-line no-await-in-loop
      const rows = await peers(signal);
      if (
        rows.some(
          (peer) =>
            peer.id === entry.peerId && peer.name === entry.name && peer.cwd === entry.identity.cwd,
        )
      ) {
        return;
      }
      // Bounded readiness polling is not an acknowledgement substitute; only the row above succeeds.
      // oxlint-disable-next-line no-await-in-loop
      await delay(100, undefined, { signal });
    }
    throw entry.process.failure;
  }
  private expiry(entry: Launch): void {
    const expire = () => {
      if (entry.expires <= Date.now()) {
        this.retire(
          entry,
          new Fault(403, "certificate_expired", "Launch owner's certificate expired."),
        ).catch(() => log("launch_cleanup", { result: "failed" }));
      } else {
        entry.timer = setTimeout(expire, Math.min(entry.expires - Date.now(), 0x7fffffff));
      }
    };
    expire();
    entry.process?.exited
      .then(() => clearTimeout(entry.timer))
      .catch(() => log("launch_cleanup", { result: "failed" }));
  }
  private async retire(entry: Launch, fault: Readonly<Fault>): Promise<void> {
    entry.controller.abort(fault);
    clearTimeout(entry.timer);
    await entry.process?.stop();
  }
  async revoke(clients: Readonly<ReadonlyMap<string, Identity>>): Promise<void> {
    await Promise.all(
      [...this.launches]
        .filter(
          (entry) => !sameIdentity(entry.identity, clients.get(entry.identity.fingerprint256)),
        )
        .map((entry) =>
          this.retire(
            entry,
            new Fault(403, "revoked", "Launch owner's identity or policy was revoked."),
          ),
        ),
    );
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      [...this.launches].map((entry) =>
        this.retire(entry, new Fault(503, "shutting_down", "Bridge is shutting down.")),
      ),
    );
  }
}
