import { setTimeout as delay } from "node:timers/promises";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import type { SendResult, SessionInfo } from "./types.ts";
import type { Identity } from "./bridge-config.ts";
import { launchCwd, spawnPolicy, type LaunchPolicy } from "./bridge-launch-policy.ts";
import { Fault, cancelled, log, wait } from "./bridge-protocol.ts";
import { RpcProcess } from "./bridge-rpc-process.ts";
import {
  exactPeer,
  savedView,
  browseSessions,
  type CatalogQuery,
  type SessionCatalog,
} from "./bridge-catalog.ts";
import {
  createLaunchJournal,
  resumeLaunchJournal,
  validateLaunchState,
  type LaunchJournal,
} from "./bridge-launch-journal.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { resolveIntercomPresenceName } from "./identity.ts";

interface Launch {
  readonly identity: Identity;
  readonly name?: string;
  readonly cwd: string;
  readonly controller: Readonly<AbortController>;
  readonly expires: number;
  admitted: boolean;
  journal?: LaunchJournal;
  process?: RpcProcess;
  timer?: NodeJS.Timeout;
}
interface StartContext {
  readonly identity: Identity;
  readonly expires: number;
  readonly signal: AbortSignal;
  readonly peers: (signal: AbortSignal) => Promise<readonly SessionInfo[]>;
  readonly submit: (peer: string, task: string) => Promise<SendResult>;
}
type ControlContext = Pick<StartContext, "signal" | "peers">;
interface SpawnInput {
  readonly name: string;
  readonly cwd?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly task?: string;
}
interface ResumeInput {
  readonly sessionId?: string;
  readonly target?: string;
  readonly name?: string;
  readonly task?: string;
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
    id: entry.journal?.sessionId,
    sessionId: entry.journal?.sessionId,
    peerId: entry.journal?.peerId,
    name: entry.name,
    cwd: entry.cwd,
    sessionFile: entry.journal?.sessionFile,
    pid: entry.process?.pid,
    status: entry.process?.status ?? "starting",
    error: entry.process?.failure?.code,
    saved: entry.journal !== undefined,
    owned: true,
  };
}
export class Launcher {
  private readonly launches = new Set<Launch>();
  private readonly catalog: SessionCatalog;
  private readonly resuming = new Set<string>();
  private stopping = false;

  constructor(catalog: SessionCatalog) {
    this.catalog = catalog;
  }

  list(identity: Identity): UnknownRecord {
    return {
      sessions: [...this.launches]
        .filter((entry) => entry.identity.fingerprint256 === identity.fingerprint256)
        .map(view),
    };
  }
  async browse(query: CatalogQuery, context: StartContext): Promise<UnknownRecord> {
    return browseSessions(this.catalog, query, {
      policy: context.identity.launch,
      signal: context.signal,
      peers: context.peers,
      activeState: (id) => {
        const entry = this.active(id) ?? this.activePeer(id);
        return entry?.identity.fingerprint256 === context.identity.fingerprint256
          ? (entry.process?.status ?? "starting")
          : undefined;
      },
    });
  }
  private active(sessionId: string): Launch | undefined {
    return [...this.launches].find(
      (entry) => entry.journal?.sessionId === sessionId && entry.process?.status !== "exited",
    );
  }
  private activePeer(peerId: string): Launch | undefined {
    return [...this.launches].find(
      (entry) => entry.journal?.peerId === peerId && entry.process?.status !== "exited",
    );
  }
  private async owned(identity: Identity, id: string, context: ControlContext): Promise<Launch> {
    const candidates = [...this.launches].filter(
      (candidate) => candidate.identity.fingerprint256 === identity.fingerprint256,
    );
    const byId = candidates.findLast(
      (candidate) => candidate.journal?.sessionId === id || candidate.journal?.peerId === id,
    );
    const named = candidates.filter(
      (candidate) =>
        candidate.process?.status !== "exited" &&
        (candidate.name === id || candidate.name === `remote:${identity.name}:${id}`),
    );
    if (!byId && named.length > 1) {
      throw new Fault(
        409,
        "ambiguous_session",
        "Multiple owned live processes match this name; use their native IDs.",
      );
    }
    const entry = byId ?? named.at(0);
    if (!entry?.process) {
      throw new Fault(
        404,
        "unknown_session",
        "Control is available only for this identity's helper-owned subprocesses, not unrelated live peers or saved history.",
      );
    }
    if (entry.process.status === "exited") {
      const peers = await context.peers(context.signal);
      if (peers.some((peer) => peer.id === entry.journal?.peerId)) {
        throw new Fault(
          404,
          "unknown_session",
          "This journal has a newer live owner; the historical process is not current ownership.",
        );
      }
    }
    return entry;
  }
  async stop(
    identity: Identity,
    sessionId: string,
    context: ControlContext,
  ): Promise<UnknownRecord> {
    const entry = await this.owned(identity, sessionId, context);
    await this.retire(entry, new Fault(410, "session_stopped", "Session stopped by its owner."));
    return { session: view(entry) };
  }
  async cancel(
    identity: Identity,
    sessionId: string,
    context: ControlContext,
  ): Promise<UnknownRecord> {
    const entry = await this.owned(identity, sessionId, context);
    if (!entry.admitted || entry.process?.status === "exited" || !entry.process) {
      throw new Fault(
        409,
        "session_not_ready",
        "Only an admitted live owned session can be cancelled.",
      );
    }
    const state = await entry.process.cancel(context.signal);
    return { session: view(entry), cancelled: true, state, queuesPreserved: true };
  }
  async start(name: string, context: StartContext): Promise<UnknownRecord> {
    return this.spawn({ name }, context, true);
  }
  async spawn(input: SpawnInput, context: StartContext, legacy = false): Promise<UnknownRecord> {
    const policy = spawnPolicy(this.policy(context), input);
    const cwd = legacy
      ? context.identity.cwd
      : launchCwd(policy, input.cwd ?? context.identity.cwd);
    const name = `remote:${context.identity.name}:${input.name}`;
    const existing = [...this.launches].find(
      (entry) =>
        entry.identity.fingerprint256 === context.identity.fingerprint256 &&
        entry.name === name &&
        entry.process?.status !== "exited",
    );
    const result = existing
      ? this.reuseSpawn(existing, input, policy, cwd)
      : await this.launch({ name, cwd }, context, policy);
    return this.task(result, input.task, context);
  }
  private reuseSpawn(
    entry: Readonly<Launch>,
    input: SpawnInput,
    policy: LaunchPolicy,
    cwd: string,
  ): UnknownRecord {
    if (entry.cwd !== cwd) {
      throw new Fault(
        409,
        "cwd_conflict",
        "This live name already belongs to a different workspace.",
      );
    }
    if (
      input.model !== undefined &&
      (entry.journal?.model?.provider !== policy.provider ||
        entry.journal?.model?.modelId !== policy.model)
    ) {
      throw new Fault(
        409,
        "model_conflict",
        "This live name already belongs to a different model selection; resume it without overriding history.",
      );
    }
    return this.reuse(entry);
  }
  async resume(input: ResumeInput, context: StartContext): Promise<UnknownRecord> {
    const policy = this.policy(context);
    const selector = input.sessionId ?? input.target ?? `name:${input.name ?? ""}`;
    if (this.resuming.has(selector)) {
      throw new Fault(409, "launch_in_progress", "This resume selector is already starting.");
    }
    this.resuming.add(selector);
    try {
      const saved = await this.catalog.resolve(policy, input, context.signal);
      launchCwd(policy, saved.cwd);
      const owned = this.active(saved.sessionId);
      if (owned) {
        const result = this.reuse(owned);
        const reused =
          owned.identity.fingerprint256 === context.identity.fingerprint256
            ? result
            : {
                ...result,
                session: {
                  ...savedView(saved),
                  peerId: saved.peerId,
                  status: owned.process?.status,
                },
              };
        return await this.task(reused, input.task, context);
      }
      await wait(spawnBrokerIfNeeded(process.execPath, []), context.signal);
      const peer = exactPeer(saved, await context.peers(context.signal));
      if (peer) {
        return await this.task(
          { session: savedView(saved, peer), id: saved.sessionId, reused: true },
          input.task,
          context,
        );
      }
      // A different selector/identity may have completed catalog resolution during the peer lookup.
      if (this.active(saved.sessionId)) {
        throw new Fault(409, "launch_in_progress", "This native session is already starting.");
      }
      const result = await this.launch(saved, context, policy);
      return await this.task(result, input.task, context);
    } finally {
      this.resuming.delete(selector);
    }
  }
  private policy(context: StartContext): LaunchPolicy {
    cancelled(context.signal);
    const policy = context.identity.launch;
    if (!policy || this.stopping) {
      throw new Fault(403, "launch_disabled", "Session launching is not enabled by local policy.");
    }
    return policy;
  }
  private async task(
    result: UnknownRecord,
    task: string | undefined,
    context: StartContext,
  ): Promise<UnknownRecord> {
    const session = result.session;
    if (task === undefined || !isRecord(session) || typeof session.peerId !== "string") {
      return result;
    }
    try {
      const receipt = await context.submit(session.peerId, task);
      return { ...result, id: session.sessionId, task: { ...receipt, completed: false } };
    } catch (error) {
      const fault =
        error instanceof Fault
          ? error
          : new Fault(
              503,
              "task_unconfirmed",
              "Task acceptance is unknown; inspect the session before retrying.",
            );
      throw new Fault(fault.status, fault.code, fault.message, {
        ...fault.details,
        session,
        reused: result.reused,
      });
    }
  }
  private async launch(
    target: {
      readonly name?: string;
      readonly cwd: string;
      readonly sessionFile?: string;
      readonly sessionId?: string;
      readonly peerId?: string;
    },
    context: StartContext,
    policy: LaunchPolicy,
  ): Promise<UnknownRecord> {
    this.capacity(context.identity, policy);
    const entry: Launch = {
      identity: context.identity,
      name: target.name,
      cwd: target.cwd,
      controller: new AbortController(),
      expires: context.expires,
      admitted: false,
    };
    if (
      target.sessionId !== undefined &&
      target.peerId !== undefined &&
      target.sessionFile !== undefined
    ) {
      entry.journal = {
        ...target,
        sessionId: target.sessionId,
        peerId: target.peerId,
        sessionFile: target.sessionFile,
      };
    }
    this.launches.add(entry);
    try {
      return await this.establish(entry, policy, context);
    } catch (error) {
      await this.retire(entry, new Fault(503, "launch_failed", "Pi startup failed.")).catch(() =>
        log("launch_cleanup", { pid: entry.process?.pid, result: "failed" }),
      );
      if (!entry.process) {
        this.launches.delete(entry);
      }
      throw error instanceof Fault
        ? error
        : new Fault(503, "launch_failed", "Pi startup failed; inspect local policy and resources.");
    }
  }
  private reuse(entry: Readonly<Launch>): UnknownRecord {
    if (
      entry.admitted &&
      (entry.process?.status === "idle" || entry.process?.status === "running")
    ) {
      return { session: view(entry), id: entry.journal?.sessionId, reused: true };
    }
    throw new Fault(
      409,
      "launch_in_progress",
      "This session is starting or stopping; inspect sessions before retrying.",
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
      const resuming = entry.journal !== undefined;
      entry.journal = entry.journal
        ? await resumeLaunchJournal(policy, entry.journal, signal)
        : await createLaunchJournal(policy, { cwd: entry.cwd, name: entry.name ?? "" }, signal);
      cancelled(signal);
      entry.process = new RpcProcess(policy, entry.cwd, entry.journal.sessionFile, resuming);
      this.expiry(entry);
      validateLaunchState(entry.journal, await entry.process.state(signal));
      await wait(spawnBrokerIfNeeded(process.execPath, []), signal);
      await this.peerReady(entry, context.peers, signal);
      cancelled(signal);
      entry.process.ready();
      entry.admitted = true;
      log("launch_ready", {
        fingerprint: entry.identity.fingerprint256,
        name: entry.name,
        peer: entry.journal.peerId,
        pid: entry.process.pid,
        result: "ready",
      });
      return { session: view(entry), id: entry.journal.sessionId, reused: false };
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
    }
  }
  private async peerReady(
    entry: Readonly<Launch>,
    peers: StartContext["peers"],
    signal: AbortSignal,
  ): Promise<void> {
    while (!entry.process?.failure) {
      cancelled(signal);
      // Native startup alone is insufficient: observe the exact Intercom publication.
      // oxlint-disable-next-line no-await-in-loop
      const rows = await peers(signal);
      if (
        rows.some(
          (peer) =>
            peer.id === entry.journal?.peerId &&
            peer.name === resolveIntercomPresenceName(entry.name, entry.journal.sessionId) &&
            peer.cwd === entry.cwd,
        )
      ) {
        return;
      }
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
