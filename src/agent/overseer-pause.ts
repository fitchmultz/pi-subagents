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

export const OVERSEER_CORRECTION = "overseer-correction";
export type SteerCommand = Extract<Command, { action: "steer" }>;

export type EscalationAnswer =
  | { readonly verdict: "approved" | "stopped" }
  | { readonly verdict: "steered"; readonly commands: readonly SteerCommand[] };

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
  ): Promise<EscalationAnswer> {
    const runDir = runDirectory(base, this.runId);
    const escalationFile = path.join(runDir, "escalation.json");
    const resolutionFile = path.join(runDir, "escalation-resolution.json");
    write(escalationFile, escalation);
    const watchRun = new DirectoryWatch(runDir, () => true, this.wake.raise);
    try {
      while (!isStopping()) {
        this.wake.take();
        watchRun.ensure();
        if (this.commands.length > 0) {
          return { verdict: "steered", commands: this.commands };
        }
        const resolution = read(resolutionFile, escalationResolutionSchema);
        if (
          resolution?.escalationId === escalation.id &&
          (resolution.verdict === "approved" || resolution.verdict === "stopped")
        ) {
          return { verdict: resolution.verdict };
        }
        await this.wake.sleep(200);
      }
      return { verdict: "stopped" };
    } finally {
      watchRun.close();
      fs.rmSync(escalationFile, { force: true });
    }
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
