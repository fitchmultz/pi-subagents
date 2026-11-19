import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  escalationResolutionSchema,
  escalationSchema,
  type Command,
  type Escalation,
  type Launch,
} from "./contracts.ts";
import { read, runDirectory, write } from "./storage.ts";
import { DirectoryWatch, Wake } from "./wake.ts";
import { OVERSEER_STATE_FILE } from "./overseer.ts";

export const OVERSEER_CORRECTION = "overseer-correction";
export type SteerCommand = Extract<Command, { action: "steer" }>;

export type EscalationAnswer =
  | { readonly verdict: "stopped" }
  | { readonly verdict: "released" }
  | { readonly verdict: "approved" | "steered"; readonly commands: readonly SteerCommand[] };

export interface EscalationWaitOptions {
  readonly admitPending?: (() => void) | undefined;
  readonly shouldRelease?: (() => boolean) | undefined;
}

function watchLiveState(
  base: string,
  shouldRelease: (() => boolean) | undefined,
  raise: () => void,
): DirectoryWatch | undefined {
  return shouldRelease === undefined
    ? undefined
    : new DirectoryWatch(base, (file) => file === null || file === OVERSEER_STATE_FILE, raise);
}

function resolveWaitAnswer(input: {
  readonly resolutionFile: string;
  readonly escalationId: string;
  readonly isStopping: () => boolean;
  readonly shouldRelease?: (() => boolean) | undefined;
  readonly commands: readonly SteerCommand[];
}): EscalationAnswer {
  const verdict = pauseResolution(input.resolutionFile, input.escalationId);
  if (input.isStopping() || verdict === "stopped") {
    return { verdict: "stopped" };
  }
  if (verdict === undefined && input.commands.length === 0 && input.shouldRelease?.() === true) {
    return { verdict: "released" };
  }
  return { verdict: verdict ?? "steered", commands: input.commands };
}

function pauseResolution(file: string, id: string): "approved" | "stopped" | undefined {
  const resolution = read(file, escalationResolutionSchema);
  if (resolution?.escalationId !== id || resolution.verdict === "steered") {
    return undefined;
  }
  return resolution.verdict;
}

export function queueCorrections(session: AgentSession, commands: readonly SteerCommand[]): void {
  const { agent } = session;
  const messages = commands.map(({ id, prompt }) => ({
    role: "custom" as const,
    customType: OVERSEER_CORRECTION,
    content: prompt,
    display: true,
    details: { commandId: id },
    timestamp: Date.now(),
  }));
  const mode = agent.steeringMode;
  const last = messages.at(-1);
  if (mode !== "all" && last !== undefined) {
    // Drain this one batch in FIFO order so older steers cannot follow the correction.
    // Once Pi starts the last message, it has already selected the entire batch.
    agent.steeringMode = "all";
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "agent_settled" ||
        (event.type === "message_start" && event.message === last)
      ) {
        agent.steeringMode = mode;
        unsubscribe();
      }
    });
  }
  for (const message of messages) {
    agent.steer(message);
  }
}

/** A paused native boundary takes corrections from its own actor, not from queued command files. */
export class EscalationPause {
  private readonly wake = new Wake();
  private readonly commands: SteerCommand[] = [];
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  steer(command: SteerCommand): boolean {
    if (command.runId !== this.runId) {
      return false;
    }
    this.commands.push(command);
    this.wake.raise();
    return true;
  }

  async wait(
    base: string,
    escalation: Escalation,
    isStopping: () => boolean,
    options?: EscalationWaitOptions,
  ): Promise<EscalationAnswer> {
    const runDir = runDirectory(base, this.runId);
    const escalationFile = path.join(runDir, "escalation.json");
    const resolutionFile = path.join(runDir, "escalation-resolution.json");
    const { admitPending, shouldRelease } = options ?? {};
    write(escalationFile, escalation);
    const watchRun = new DirectoryWatch(runDir, () => true, this.wake.raise);
    const watchBase = watchLiveState(base, shouldRelease, this.wake.raise);
    try {
      const published = await this.waitForSignal({
        watchRun,
        watchBase,
        resolutionFile,
        escalationId: escalation.id,
        isStopping,
        shouldRelease,
      });
      if (!isStopping() && published !== "stopped" && shouldRelease?.() !== true) {
        // The approval watcher can wake before the command watcher.
        admitPending?.();
      }
    } finally {
      watchRun.close();
      watchBase?.close();
      fs.rmSync(escalationFile, { force: true });
    }
    // Include an approval published while the pause was still open.
    return resolveWaitAnswer({
      resolutionFile,
      escalationId: escalation.id,
      isStopping,
      shouldRelease,
      commands: this.commands,
    });
  }

  private async waitForSignal(input: {
    readonly watchRun: DirectoryWatch;
    readonly watchBase: DirectoryWatch | undefined;
    readonly resolutionFile: string;
    readonly escalationId: string;
    readonly isStopping: () => boolean;
    readonly shouldRelease: (() => boolean) | undefined;
  }): Promise<ReturnType<typeof pauseResolution>> {
    while (!input.isStopping()) {
      this.wake.take();
      input.watchRun.ensure();
      input.watchBase?.ensure();
      const published = pauseResolution(input.resolutionFile, input.escalationId);
      if (published !== undefined || this.commands.length > 0 || input.shouldRelease?.() === true) {
        return published;
      }
      await this.wake.sleep(200);
    }
    return undefined;
  }
}

export function resolveActiveEscalation(
  base: string,
  launch: Launch,
  verdict: "approved" | "stopped",
): Escalation | undefined {
  const dir = runDirectory(base, launch.id);
  const active = read(path.join(dir, "escalation.json"), escalationSchema);
  if (active === undefined) {
    return undefined;
  }
  const resolutionFile = path.join(dir, "escalation-resolution.json");
  const previous = read(resolutionFile, escalationResolutionSchema);
  if (previous?.escalationId === active.id) {
    return undefined;
  }
  write(resolutionFile, {
    escalationId: active.id,
    verdict,
    ...(verdict === "approved" ? { diffDigest: active.diffDigest } : {}),
    at: Date.now(),
  });
  return active;
}
