import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  exitSchema,
  parkedSchema,
  readySchema,
  wakeFailureSchema,
  type Launch,
  type Parked,
} from "./contracts.ts";
import { errorText, loadSDK, type WorkingState } from "./host.ts";
import { conversation, latest, launchAt, list, read, runDirectory, write } from "./storage.ts";
import { actor as claimedActor, alive, shell, shells, wakeActor } from "./process.ts";
import { DirectoryWatch, Wake } from "./wake.ts";
import {
  isHistoryRequest,
  isWakeRequest,
  PARK,
  PARKED_HISTORY,
  WAKE,
  type ParkRequest,
  type WakeResult,
} from "../shared/parking.ts";
import { nativePeerId } from "../pi-intercom/session-targets.ts";
import type { NativeHistory } from "../pi-intercom/last-message.ts";

type SDK = Awaited<ReturnType<typeof loadSDK>>;
type Restore = NonNullable<SDK["readWorkingSession"]>;
export type Runtime = Awaited<ReturnType<SDK["createAgentSessionRuntime"]>>;
type SessionManager = Parameters<SDK["createAgentSessionRuntime"]>[1]["sessionManager"];
interface WorkingHold {
  readonly state: WorkingState;
  readonly sleepReady: boolean;
  readonly blockers: readonly string[];
  readonly assertHeld: () => void;
  readonly release: () => Promise<void>;
}
/** Fork-only native cut and strict final exit; official Pi children stay resident. */
type Parkable = AgentSession & {
  readonly acquireWorkingSession: (options: {
    boundary: "settled";
    signal?: AbortSignal;
  }) => Promise<WorkingHold>;
};
/** The runner's view of its own work; parking never admits or runs commands itself. */
interface Resident {
  readonly pi: ExtensionAPI | undefined;
  readonly busy: boolean;
  /**
   * False once queued commands, work, stopping or a viewer appeared. Never admits: a prompt
   * started under the native hold fails, so the runner admits only after release.
   */
  readonly quiet: () => boolean;
  readonly errors: string[];
  /** Aborts preparation once the owner stops or dies. */
  readonly signal: AbortSignal;
}
interface Finalizing {
  readonly setFinalization: (
    finalization: (session: AgentSession) => Promise<void>,
    options: { strictShutdown: boolean },
  ) => void;
}
function parkable(session: AgentSession): session is Parkable {
  return typeof Reflect.get(session, "acquireWorkingSession") === "function";
}
function finalizing(runtime: Runtime): runtime is Runtime & Finalizing {
  return typeof Reflect.get(runtime, "setFinalization") === "function";
}
function fence(pi: ExtensionAPI, park: boolean): Promise<boolean> {
  let fenced = Promise.resolve(false);
  pi.events.emit(PARK, {
    park,
    reply: (parked) => {
      fenced = parked;
    },
  } satisfies ParkRequest);
  return fenced;
}
async function cut(
  pi: ExtensionAPI,
  session: Parkable,
  { quiet, errors, signal }: Omit<Resident, "pi" | "busy">,
): Promise<WorkingHold | undefined> {
  try {
    // Save handlers may legitimately append entries; only the pre-cut leaf proves idleness.
    if ((await fence(pi, true)) && quiet() && session.isIdle) {
      return await session.acquireWorkingSession({ boundary: "settled", signal });
    }
  } catch (error) {
    errors.push(errorText(error));
  }
  return undefined;
}
const PARK_AFTER_MS = 5 * 60_000;
/** SHA-256 of every state byte through one reused chunk, like the native state reader. */
function digest(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (let count = fs.readSync(fd, chunk); count > 0; count = fs.readSync(fd, chunk)) {
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Parked authority names this session and exactly the saved generation's state bytes. */
function exact(
  restore: Restore,
  parked: Parked,
  state: string,
  launch: Launch,
): WorkingState | undefined {
  if (
    parked.sessionId !== launch.sessionId ||
    parked.state !== state ||
    digest(state) !== parked.digest
  ) {
    return undefined;
  }
  const saved = restore(state);
  return saved.sessionFile === launch.sessionFile &&
    saved.header.id === launch.sessionId &&
    saved.leafId === parked.leafId
    ? saved
    : undefined;
}
/** This child's exact parked generation, if any; mismatched authority restores nothing. */
export function parkedState(
  dir: string,
  launch: Launch,
  restore: Restore | undefined,
): { readonly state: string; readonly saved: WorkingState } | undefined {
  const parked = read(path.join(dir, "parked.json"), parkedSchema);
  if (!parked) {
    return undefined;
  }
  if (!restore) {
    throw new Error("Parked working state needs the Pi fork that saved it; nothing was reopened.");
  }
  // Native working state requires a canonical parent, not a symlinked alias like macOS /var.
  const state = path.join(fs.realpathSync(dir), `working-${parked.token}.json`);
  const saved = exact(restore, parked, state, launch);
  if (!saved) {
    throw new Error(
      "Parked working state is not this child's saved generation; nothing was reopened.",
    );
  }
  return { state, saved };
}
/** One actor generation's idle parking and exact restore; commands stay with the runner. */
export class Parking {
  saved?: WorkingState;
  /** Set before entering either native open, whose effects may outlive an exception. */
  opened = false;
  private restored?: string;
  private since = 0;
  private leaf?: string | null;
  private shell?: string | undefined;
  private readonly base: string;
  private readonly launch: Launch;
  private readonly token: string;
  private readonly sdk: SDK;
  constructor(base: string, launch: Launch, token: string, sdk: SDK) {
    this.base = base;
    this.launch = launch;
    this.token = token;
    this.sdk = sdk;
  }
  private get dir(): string {
    return runDirectory(this.base, this.launch.rootId);
  }
  private get file(): string {
    return path.join(this.dir, "parked.json");
  }
  /** Parked authority is exact state or nothing; never a journal-only reopen. */
  open(): SessionManager {
    const { sdk, launch } = this;
    const { openWorkingSession: restore } = sdk;
    const parked = parkedState(this.dir, launch, restore && sdk.readWorkingSession);
    this.opened = true;
    if (!parked || !restore) {
      return sdk.SessionManager.open(launch.sessionFile, undefined, launch.cwd);
    }
    this.saved = parked.saved;
    this.restored = parked.state;
    return restore(parked.saved);
  }
  /** The ready restored generation owns this state now; a later park writes a new cut. */
  adopt(): void {
    if (this.restored !== undefined) {
      fs.rmSync(this.file);
      fs.rmSync(this.restored, { force: true });
    }
  }
  /** True once this generation has exited its runtime with or without parked authority. */
  async park(runtime: Runtime, actor: Resident): Promise<boolean> {
    if (!actor.pi || !this.due(runtime.session, actor.busy) || this.hasShell()) {
      return false;
    }
    const hold = await this.prepare(runtime, actor.pi, actor);
    if (hold) {
      await this.commit(runtime, hold, actor.errors);
    }
    return hold !== undefined;
  }
  private hasShell(): boolean {
    const witness = this.shell === undefined ? undefined : shell(this.shell, this.token);
    if (!witness || !alive(witness)) {
      this.shell = shells(this.base, this.launch, this.token).find(alive)?.file;
    }
    return this.shell !== undefined;
  }
  /** Final idle: no run, turn, journal change or viewer since the period began. */
  private due(session: AgentSession, busy: boolean): boolean {
    const leaf = session.sessionManager.getLeafId();
    if (busy || !session.isIdle || leaf !== this.leaf) {
      this.leaf = leaf;
      this.since = performance.now();
      return false;
    }
    return performance.now() - this.since >= PARK_AFTER_MS;
  }
  /**
   * Fence broker input, then hold a settled sleep-ready cut of the same quiet idle leaf. Any
   * failure or raced command releases, unfences and keeps this actor resident.
   */
  private async prepare(
    runtime: Runtime,
    pi: ExtensionAPI,
    { quiet, errors, signal }: Resident,
  ): Promise<WorkingHold | undefined> {
    const { session } = runtime;
    this.since = performance.now();
    if (!parkable(session) || !this.sdk.writeWorkingSession || !finalizing(runtime)) {
      return undefined;
    }
    // A launcher that enqueues after this marker waits for exit, then wakes the saved state.
    const marker = path.join(this.dir, "actor.lock", "parking.json");
    write(marker, { at: Date.now() });
    const hold = await cut(pi, session, {
      quiet: () => quiet() && session.sessionManager.getLeafId() === this.leaf,
      errors,
      signal,
    });
    // Revalidate after the awaited fence and save, immediately before the irreversible commit.
    if (hold?.sleepReady === true && quiet()) {
      return hold;
    }
    await hold?.release();
    await fence(pi, false);
    fs.rmSync(marker, { force: true });
    return undefined;
  }
  /** Commit: native strict exit, then capture; failure leaves no parked authority. */
  private async commit(runtime: Runtime, hold: WorkingHold, errors: string[]): Promise<void> {
    const save = this.sdk.writeWorkingSession;
    if (save && finalizing(runtime)) {
      runtime.setFinalization((final) => this.capture(final, save), { strictShutdown: true });
    }
    // No await between release and dispose: native final exit fences new turns in this tick.
    const released = hold.release();
    const disposed = runtime.dispose();
    try {
      await Promise.all([released, disposed]);
    } catch (error) {
      errors.push(errorText(error));
    }
    if (read(this.file, parkedSchema)?.token !== this.token) {
      // Truthful boundary: retained input stays queued and nothing restarts implicitly.
      write(path.join(this.dir, "park-failed.json"), { token: this.token, errors });
    }
  }
  private async capture(
    session: AgentSession,
    save: (file: string, state: WorkingState) => void,
  ): Promise<void> {
    if (!parkable(session)) {
      throw new Error("Native working state is unavailable.");
    }
    const hold = await session.acquireWorkingSession({ boundary: "settled" });
    try {
      if (!hold.sleepReady) {
        throw new Error(`Final working state is not sleep-ready: ${hold.blockers.join("; ")}`);
      }
      const state = path.join(fs.realpathSync(this.dir), `working-${this.token}.json`);
      save(state, hold.state);
      hold.assertHeld();
      write(this.file, {
        token: this.token,
        state,
        digest: digest(state),
        sessionId: this.launch.sessionId,
        leafId: hold.state.leafId,
      });
    } finally {
      await hold.release();
    }
  }
}
interface Runs {
  readonly base: string;
  readonly owner: string;
}

/** The broker names a parked child by native peer ID; only this owner's conversations match. */
function ownedRun(runs: Runs | undefined, peer: unknown): Launch | undefined {
  const launch =
    runs && typeof peer === "string"
      ? list(runs.base)
          .map((id) => launchAt(runs.base, id, runs.owner))
          .find((candidate) => nativePeerId(candidate.sessionId) === peer)
      : undefined;
  return launch && runs && latest(runs.base, launch);
}

/** The captured leaf's root-to-leaf path, as a live session manager reports it. */
function branchOf(state: WorkingState): ReturnType<NativeHistory["getBranch"]> {
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
  const branch = [];
  for (
    let entry = entries.get(state.leafId ?? "");
    entry !== undefined;
    entry = entries.get(entry.parentId ?? "")
  ) {
    branch.unshift(entry);
  }
  return branch;
}
async function history(runs: Runs | undefined, peer: string): Promise<NativeHistory | undefined> {
  const launch = ownedRun(runs, peer);
  const restore = launch && (await loadSDK(launch.sdk)).readWorkingSession;
  const state =
    runs && launch && parkedState(conversation(runs.base, launch), launch, restore)?.saved;
  return state && { getBranch: () => branchOf(state) };
}

function unavailableCwd(cwd: string): string | undefined {
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return `Saved working directory ${cwd} is unavailable: not a directory.`;
    }
    fs.accessSync(cwd, fs.constants.X_OK);
  } catch (error) {
    return `Saved working directory ${cwd} is unavailable: ${errorText(error)}.`;
  }
  return undefined;
}

function exitedWake(
  dir: string,
  identity: NonNullable<ReturnType<typeof claimedActor>>,
  legacy: boolean,
): string | undefined {
  const exit = read(path.join(dir, `exit-${identity.token}.json`), exitSchema);
  if (!exit && alive(identity)) {
    return undefined;
  }
  const failure = read(path.join(dir, `wake-failure-${identity.token}.json`), wakeFailureSchema);
  return (
    failure?.reason ??
    `Actor exited before ${legacy ? "readiness" : "intercom registration"} (code ${exit?.code ?? "unknown"}, signal ${exit?.signal ?? "unknown"}). See ${path.join(dir, "runner.log")}.`
  );
}

/** A spawned actor is only requested until its own readiness or exit is observed. */
async function awaitWake(
  base: string,
  launch: Launch,
  signal: AbortSignal,
  legacy: boolean,
): Promise<void> {
  const dir = conversation(base, launch);
  const identity = claimedActor(base, launch);
  if (!identity) {
    throw new Error("The wake returned without an observable actor claim.");
  }
  const wake = new Wake();
  const watch = new DirectoryWatch(dir, () => true, wake.raise);
  try {
    for (;;) {
      signal.throwIfAborted();
      wake.take();
      watch.ensure();
      if (
        legacy &&
        read(path.join(dir, "ready.json"), readySchema)?.token === identity.token &&
        !fs.existsSync(path.join(dir, "parked.json"))
      ) {
        return;
      }
      const failure = exitedWake(dir, identity, legacy);
      if (failure !== undefined) {
        throw new Error(failure);
      }
      // DirectoryWatch reconciles dropped hints without imposing a deadline on native startup.
      // oxlint-disable-next-line no-await-in-loop
      await wake.sleep(200);
    }
  } finally {
    watch.close();
  }
}

function wakeFailed(
  current: Runs | undefined,
  launch: Launch | undefined,
  error: unknown,
): WakeResult {
  let reason = errorText(error);
  const unavailable = launch && unavailableCwd(launch.cwd);
  if (unavailable !== undefined) {
    reason += ` ${unavailable}`;
  }
  if (current && launch) {
    try {
      write(path.join(conversation(current.base, launch), "wake-failure.json"), {
        at: Date.now(),
        reason,
      });
    } catch (recordError) {
      reason += ` Wake failure could not be recorded: ${errorText(recordError)}.`;
    }
  }
  return { status: "failed", reason };
}

/**
 * Wakes this owner's parked children for broker input and reads their saved history.
 * `runs` is undefined while this session owns no children.
 */
export function serveParked(
  pi: ExtensionAPI,
  runs: () => Runs | undefined,
  signal: AbortSignal,
): void {
  const pending = new Map<string, Promise<WakeResult>>();
  const attempt = async (peer: string, registered?: AbortSignal): Promise<WakeResult> => {
    let current: Runs | undefined;
    let launch: Launch | undefined;
    const cancelled = registered ? AbortSignal.any([signal, registered]) : signal;
    try {
      current = runs();
      launch = ownedRun(current, peer);
      if (!current || !launch) {
        throw new Error("No active agent runtime owns this parked child.");
      }
      await wakeActor(current.base, launch, cancelled);
      await awaitWake(current.base, launch, cancelled, registered === undefined);
      return { status: "requested" };
    } catch (error) {
      if (registered?.aborted === true) {
        return { status: "requested" };
      }
      return wakeFailed(current, launch, error);
    }
  };
  pi.events.on(WAKE, (request) => {
    const peer = isWakeRequest(request) ? request.peer : request;
    if (typeof peer !== "string") {
      return;
    }
    // Serialize wake requests; a successful in-flight wake already serves queued requests.
    const previous = pending.get(peer);
    const registered = isWakeRequest(request) ? request.signal : undefined;
    const result = previous
      ? previous.then((outcome) =>
          outcome.status === "requested" ? outcome : attempt(peer, registered),
        )
      : attempt(peer, registered);
    pending.set(peer, result);
    const clear = () => {
      if (pending.get(peer) === result) {
        pending.delete(peer);
      }
    };
    void result.then(clear, clear);
    if (isWakeRequest(request)) {
      request.reply(result);
    }
  });
  pi.events.on(PARKED_HISTORY, (request) => {
    if (isHistoryRequest(request)) {
      request.reply(history(runs(), request.peer));
    }
  });
}
