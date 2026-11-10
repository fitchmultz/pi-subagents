import * as fs from "node:fs";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Waiting } from "./contracts.ts";
import type { loadSDK } from "./host.ts";
import { write } from "./storage.ts";
import { Wake } from "./wake.ts";

/** Unfinished work that will message its session when it ends, as the session lists it. */
interface BackgroundWork {
  readonly id: string;
  readonly description: string;
  readonly cancel: () => Promise<void>;
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
/**
 * Keeps one run open while its session can still wake without new input: the run ends at the
 * first moment the session is idle, is not settling and lists no background work.
 */
export class BackgroundWait {
  private readonly pause = new Wake();
  private readonly prompts: Promise<void>[] = [];
  private stopped = false;
  private recorded = "[]";
  private since?: number | undefined;
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
    this.stopped = true;
    this.pause.raise();
  }
  async settled(): Promise<void> {
    try {
      while (!(await this.done())) {
        await this.pause.sleep(POLL_MS);
      }
    } finally {
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
    if (this.stopped || (idle && work.length === 0)) {
      return true;
    }
    this.record(this.session.isIdle ? work : []);
    return false;
  }
  private record(work: readonly BackgroundWork[]): void {
    const waiting = work.map(({ id, description }) => ({ id, description }));
    const key = JSON.stringify(waiting);
    if (key === this.recorded) {
      return;
    }
    this.recorded = key;
    if (waiting.length === 0) {
      this.since = undefined;
      fs.rmSync(this.file, { force: true });
      return;
    }
    this.since ??= Date.now();
    write(this.file, { since: this.since, work: waiting } satisfies Waiting);
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
