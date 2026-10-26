import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parkedSchema, type Launch } from "./contracts.ts";
import { errorText, type loadSDK, type WorkingState } from "./host.ts";
import { read, runDirectory, write } from "./storage.ts";
import { alive, shells } from "./process.ts";
import { PARK, type ParkRequest } from "../shared/parking.ts";

type SDK = Awaited<ReturnType<typeof loadSDK>>;
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
  readonly acquireWorkingSession: (options: { boundary: "settled" }) => Promise<WorkingHold>;
};
/** The runner's view of its own work; parking never admits or runs commands itself. */
interface Resident {
  readonly pi: ExtensionAPI | undefined;
  readonly busy: boolean;
  /** Admits commands that raced the parking marker; false when work or stopping began. */
  readonly admit: () => boolean;
  readonly errors: string[];
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
  admit: () => boolean,
  errors: string[],
): Promise<WorkingHold | undefined> {
  try {
    if ((await fence(pi, true)) && admit() && session.isIdle) {
      return await session.acquireWorkingSession({ boundary: "settled" });
    }
  } catch (error) {
    errors.push(errorText(error));
  }
  return undefined;
}
// Wake costs one cold actor start (measured p50 1.2 s, p90 4.8 s); parking frees the whole
// process (measured median 73 MB). Most completed actors stay idle far longer than this.
const PARK_AFTER_MS = 5 * 60_000;

/** One actor generation's idle parking and exact restore; commands stay with the runner. */
export class Parking {
  saved?: WorkingState;
  private restored?: string;
  private since = 0;
  private leaf?: string | null;
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
    const parked = read(this.file, parkedSchema);
    if (!parked) {
      return sdk.SessionManager.open(launch.sessionFile, undefined, launch.cwd);
    }
    if (!sdk.readWorkingSession || !sdk.openWorkingSession) {
      throw new Error(
        "Parked working state needs the Pi fork that saved it; nothing was reopened.",
      );
    }
    this.saved = sdk.readWorkingSession(parked.state);
    this.restored = parked.state;
    if (this.saved.sessionFile !== launch.sessionFile) {
      throw new Error("Parked working state names another session.");
    }
    return sdk.openWorkingSession(this.saved);
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
    if (
      !actor.pi ||
      !this.due(runtime.session, actor.busy) ||
      shells(this.base, this.launch, this.token).some(alive)
    ) {
      return false;
    }
    const hold = await this.prepare(runtime, actor.pi, actor.admit, actor.errors);
    if (hold) {
      await this.commit(runtime, hold, actor.errors);
    }
    return hold !== undefined;
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
   * Fence broker input, let `admit` take commands that raced the marker, then hold a settled
   * sleep-ready cut of the same idle leaf. Any failure unfences and keeps this actor resident.
   */
  private async prepare(
    runtime: Runtime,
    pi: ExtensionAPI,
    admit: () => boolean,
    errors: string[],
  ): Promise<WorkingHold | undefined> {
    const { session } = runtime;
    this.since = performance.now();
    if (!parkable(session) || !this.sdk.writeWorkingSession || !finalizing(runtime)) {
      return undefined;
    }
    // A launcher that enqueues after this marker waits for exit, then wakes the saved state.
    const marker = path.join(this.dir, "actor.lock", "parking.json");
    write(marker, { at: Date.now() });
    const hold = await cut(pi, session, admit, errors);
    if (hold?.sleepReady === true && hold.state.leafId === this.leaf) {
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
      const state = path.join(this.dir, `working-${this.token}.json`);
      save(state, hold.state);
      hold.assertHeld();
      write(this.file, { token: this.token, state });
    } finally {
      await hold.release();
    }
  }
}
