import * as fs from "node:fs";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Launch, Waiting } from "./contracts.ts";
import type { loadSDK } from "./host.ts";
import { actor, observeAlive } from "./process.ts";
import { completionReceipts } from "./receipts.ts";
import { readRunState, runStatus, type RunState } from "./run-state.ts";
import { latest, launchAt, list, write } from "./storage.ts";
import { Wake } from "./wake.ts";

/** Unfinished work that will message its session when it ends, as the session lists it. */
export interface BackgroundWork {
  readonly id: string;
  readonly description: string;
  readonly cancel: () => Promise<void>;
  readonly survivesRestart?: boolean;
}
export interface SubagentBackgroundWorkInput {
  readonly base: string;
  readonly owner: string;
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly survivesRestart: boolean;
  readonly stop: (launch: Launch) => void;
}
type PendingCandidate =
  | { readonly kind: "settled"; readonly launch: Launch }
  | {
      readonly kind: "active";
      readonly launch: Launch;
      readonly state: RunState;
      readonly claim: NonNullable<ReturnType<typeof actor>>;
    };
function toBackgroundWorkItem(
  launch: Launch,
  survivesRestart: boolean,
  stop: (launch: Launch) => void,
): BackgroundWork {
  const description =
    launch.name !== undefined && launch.name !== ""
      ? `Subagent ${launch.name} (${launch.id})`
      : `Subagent ${launch.id}`;
  return {
    id: launch.id,
    description,
    survivesRestart,
    cancel: () => Promise.try(() => stop(launch)),
  };
}
function collectPendingCandidates(
  base: string,
  owner: string,
  ids: readonly string[],
  receipts: ReadonlyMap<string, string | undefined>,
): PendingCandidate[] {
  const candidates: PendingCandidate[] = [];
  for (const id of ids) {
    // Skip already-published runs before touching launch.json or result.json on disk.
    if (receipts.get(id) !== undefined) {
      continue;
    }
    let launch: Launch;
    try {
      launch = launchAt(base, id, owner);
    } catch {
      continue;
    }
    const state = readRunState(base, launch);
    if (state.kind === "settled") {
      candidates.push({ kind: "settled", launch });
      continue;
    }
    const claim = actor(base, launch);
    if (claim !== undefined) {
      candidates.push({ kind: "active", launch, state, claim });
    }
  }
  return candidates;
}
/** Reports active or undelivered subagent runs for the fork's `background_work` event. */
export async function subagentBackgroundWork(
  input: SubagentBackgroundWorkInput,
): Promise<BackgroundWork[]> {
  const ids = list(input.base);
  if (ids.length === 0) {
    return [];
  }
  const receipts = completionReceipts(input.sessionManager, input.owner);
  const candidates = collectPendingCandidates(input.base, input.owner, ids, receipts);
  const active = candidates.filter((candidate) => candidate.kind === "active");
  const live =
    active.length === 0 ? [] : await observeAlive(active.map((candidate) => candidate.claim));
  let activeIndex = 0;
  const work: BackgroundWork[] = [];
  for (const candidate of candidates) {
    const include =
      candidate.kind === "settled" ||
      runStatus(input.base, candidate.launch, candidate.state, live[activeIndex++] === true) ===
        "running";
    if (include) {
      work.push(toBackgroundWorkItem(candidate.launch, input.survivesRestart, input.stop));
    }
  }
  return work;
}
/** Registers the fork-only `background_work` query for main-session subagent runs. */
export function registerSubagentBackgroundWork(
  pi: ExtensionAPI,
  current: () => SubagentBackgroundWorkInput | undefined,
): void {
  Reflect.apply(pi.on.bind(pi), undefined, [
    "background_work",
    async () => {
      const input = current();
      if (input === undefined) {
        return;
      }
      return {
        work: await subagentBackgroundWork({
          ...input,
          stop: (launch) => input.stop(latest(input.base, launch)),
        }),
      };
    },
  ]);
}
/**
 * Fork-only: the session lists the work that can still wake it. Official Pi cannot, so its
 * runs end at the first idle and its children get no `background_command`.
 */
type Reporting = AgentSession & {
  readonly isSettling: boolean;
  readonly getBackgroundWork: () => Promise<BackgroundWork[]>;
};
export function reporting(session: AgentSession): session is Reporting {
  return typeof Reflect.get(session, "getBackgroundWork") === "function";
}
/** The host's `background_command`, only where a run can wait for the jobs it starts. */
export function backgroundCommands(
  sdk: Awaited<ReturnType<typeof loadSDK>>,
): ExtensionFactory | undefined {
  return typeof Reflect.get(sdk.AgentSession.prototype, "getBackgroundWork") === "function"
    ? sdk.createBackgroundCommandExtension?.({ hostWaits: true })
    : undefined;
}
// The background_command monitor delivers once a second; a shorter wait learns nothing sooner.
const POLL_MS = 1000;
type WaitPhase = "waiting" | "ended" | "finished";
/**
 * Keeps one run open while its session can still wake without new input: the run ends at the
 * first moment the session is idle, is not settling and lists no background work.
 */
export class BackgroundWait {
  private readonly pause = new Wake();
  private readonly prompts: Promise<void>[] = [];
  private phase: WaitPhase = "waiting";
  /** The durable record, or undefined when the run waits on nothing. */
  private recorded?: Waiting | undefined;
  private readonly session: Reporting;
  private readonly file: string;
  /** `file` states what the run waits on while it waits; inventory and inspection read it. */
  constructor(session: Reporting, file: string) {
    this.session = session;
    this.file = file;
  }
  /**
   * Guidance for the waiting session. It enters as a prompt of this run: a message queued on
   * an idle session would hold job notices back. A wake that starts first takes it as steering.
   */
  guide(prompt: string): void {
    const prompted = this.session.prompt(prompt, {
      expandPromptTemplates: false,
      streamingBehavior: "steer",
    });
    prompted.catch(() => {
      // settled() observes this failure.
    });
    this.prompts.push(prompted);
    this.record([]);
    this.pause.raise();
  }
  /** Stop ends the wait; the stopping owner cancels the work and aborts the session. */
  end(): void {
    if (this.phase === "waiting") {
      this.phase = "ended";
    }
    this.pause.raise();
  }
  async settled(): Promise<void> {
    try {
      while (!(await this.done())) {
        await this.pause.sleep(POLL_MS);
      }
    } finally {
      this.phase = "finished";
      this.record([]);
    }
  }
  private async done(): Promise<boolean> {
    this.pause.take();
    if (!this.session.isIdle) {
      this.record([]);
    }
    await this.session.waitForIdle();
    // A prompt is not a run until its input handlers and auth check have finished.
    for (let prompt = this.prompts.shift(); prompt; prompt = this.prompts.shift()) {
      await prompt;
    }
    const work = await this.session.getBackgroundWork();
    // No await between the list and these reads: the session marks a run active in the same
    // call that delivers a completion, so a wake cannot hide between them.
    const idle = this.session.isIdle && !this.session.isSettling && this.prompts.length === 0;
    if (this.phase !== "waiting" || (idle && work.length === 0)) {
      return true;
    }
    this.record(this.session.isIdle ? work : []);
    return false;
  }
  private record(work: readonly BackgroundWork[]): void {
    const waiting = work.map(({ id, description }) => ({ id, description }));
    if (JSON.stringify(waiting) === JSON.stringify(this.recorded?.work ?? [])) {
      return;
    }
    if (waiting.length === 0) {
      this.recorded = undefined;
      fs.rmSync(this.file, { force: true });
      return;
    }
    this.recorded = { since: this.recorded?.since ?? Date.now(), work: waiting };
    write(this.file, this.recorded satisfies Waiting);
  }
}
/**
 * Stop: requests cancellation of every listed item, then aborts the session. An abort alone
 * leaves `background_command` jobs running, and they outlive this actor. No cancellation is
 * awaited before the abort, so work that is slow to stop cannot delay it.
 */
export async function endSession(
  session: AgentSession,
  failed: (error: unknown) => void,
): Promise<void> {
  let work: BackgroundWork[] = [];
  try {
    work = reporting(session) ? await session.getBackgroundWork() : [];
  } catch (error) {
    failed(error);
  }
  const ended = await Promise.allSettled([
    ...work.map(async (item) => item.cancel()),
    session.abort(),
  ]);
  for (const outcome of ended) {
    if (outcome.status === "rejected") {
      failed(outcome.reason);
    }
  }
}
