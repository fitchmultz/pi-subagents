import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parkedSchema, type Launch, type Parked } from "./contracts.ts";
import { errorText, type loadSDK, type WorkingState } from "./host.ts";
import { read, runDirectory, write } from "./storage.ts";
import { alive, shells } from "./process.ts";
import { PARK, type ParkRequest } from "../shared/parking.ts";

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
  readonly acquireWorkingSession: (options: { boundary: "settled" }) => Promise<WorkingHold>;
};
/** The runner's view of its own work; parking never admits or runs commands itself. */
interface Resident {
  readonly pi: ExtensionAPI | undefined;
  readonly busy: boolean;
  /** Admits commands that raced the marker; false once work, stopping or a viewer began. */
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
    // Save handlers may legitimately append entries; only the pre-cut leaf proves idleness.
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
const digest = (file: string): string =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

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
    const { openWorkingSession: restore } = sdk;
    const parked = parkedState(this.dir, launch, restore && sdk.readWorkingSession);
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
    const hold = await cut(
      pi,
      session,
      () => admit() && session.sessionManager.getLeafId() === this.leaf,
      errors,
    );
    // Revalidate after the awaited fence and save, immediately before the irreversible commit.
    if (hold?.sleepReady === true && admit()) {
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
