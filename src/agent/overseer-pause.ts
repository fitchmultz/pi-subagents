import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { arr, int, num, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema";
import {
  escalationResolutionSchema,
  escalationSchema,
  toolErrorTurnSchema,
  type Command,
  type Escalation,
  type EscalationResolution,
  type Launch,
} from "./contracts.ts";
import { read, runDirectory, write } from "./storage.ts";
import { DirectoryWatch, Wake } from "./wake.ts";
import { OVERSEER_STATE_FILE } from "./overseer.ts";
import { hasErrorCode } from "../shared/unknown.ts";

/** Pre-V2 escalation payload written by children launched before the checkpoint redesign. */
const legacyEscalationSchema = obj(
  {
    id: str(),
    runId: str(),
    owner: str(),
    at: num(),
    strikes: int({ minimum: 1 }),
    kind: oneOf(["scope_violation", "branch_violation", "primitive_violation", "loop_violation"]),
    summary: str(),
    changedFiles: arr(str()),
    diffExcerpt: str(),
    diffDigest: str(),
    since: opt(oneOf(["launch", "approval"])),
    stat: opt(str()),
    diffCommand: opt(str()),
    steers: opt(int({ minimum: 0 })),
    toolErrorTurns: opt(arr(toolErrorTurnSchema)),
    classifierReview: opt(unknown()),
  },
  { open: true },
);

const anyEscalationSchema = union([escalationSchema, legacyEscalationSchema]);

function legacyKind(kind: string, classifierReview: unknown): Escalation["kind"] {
  if (kind === "loop_violation") {
    return "tool_errors";
  }
  return classifierReview !== undefined ? "skeptic" : "final_diff";
}

export function readEscalation(file: string): Escalation | undefined {
  const parsed = read(file, anyEscalationSchema);
  if (parsed === undefined || "pauseNumber" in parsed) {
    return parsed;
  }
  const { strikes, kind, since, classifierReview, ...rest } = parsed;
  return {
    ...rest,
    pauseNumber: strikes,
    kind: legacyKind(kind, classifierReview),
    since: since === "approval" ? "checkpoint" : "launch",
  };
}

export const OVERSEER_CORRECTION = "overseer-correction";
export type SteerCommand = Extract<Command, { action: "steer" }>;

export type EscalationAnswer =
  | { readonly verdict: "stopped" }
  | { readonly verdict: "released" }
  | { readonly verdict: "approved" | "steered"; readonly commands: readonly SteerCommand[] };

export interface EscalationWaitOptions {
  readonly admitPending?: (() => void) | undefined;
  readonly admitInlineSteer?: ((command: SteerCommand) => void) | undefined;
  readonly shouldRelease?: (() => boolean) | undefined;
}

/** Records admission for a steering note embedded in an approval resolution so commands/<id>.json is not replayed. */
export function admitInlineSteer(
  conversationDir: string,
  started: Set<string>,
  command: SteerCommand,
): void {
  if (started.has(command.id)) {
    return;
  }
  const receipt = path.join(conversationDir, "admissions", `${command.id}.json`);
  started.add(command.id);
  if (fs.existsSync(receipt)) {
    return;
  }
  try {
    write(
      receipt,
      { id: command.id, runId: command.runId, action: "steer", state: "accepted", at: Date.now() },
      true,
    );
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
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

function mergeInlineSteer(
  resolution: EscalationResolution | undefined,
  runId: string,
  commands: readonly SteerCommand[],
  onInlineSteer?: (command: SteerCommand) => void,
): readonly SteerCommand[] {
  const steer = resolution?.verdict === "approved" ? resolution.steer : undefined;
  if (steer === undefined || commands.some((command) => command.id === steer.id)) {
    return commands;
  }
  const inline: SteerCommand = {
    id: steer.id,
    runId,
    action: "steer",
    prompt: steer.prompt,
    createdAt: resolution?.at ?? Date.now(),
  };
  onInlineSteer?.(inline);
  return [...commands, inline];
}

function resolveWaitAnswer(input: {
  readonly runId: string;
  readonly resolutionFile: string;
  readonly escalationId: string;
  readonly isStopping: () => boolean;
  readonly shouldRelease?: (() => boolean) | undefined;
  readonly admitInlineSteer?: ((command: SteerCommand) => void) | undefined;
  readonly commands: readonly SteerCommand[];
}): EscalationAnswer {
  const resolution = pauseResolution(input.resolutionFile, input.escalationId);
  const verdict = resolution?.verdict;
  if (input.isStopping() || verdict === "stopped") {
    return { verdict: "stopped" };
  }
  if (verdict === undefined && input.commands.length === 0 && input.shouldRelease?.() === true) {
    return { verdict: "released" };
  }
  const commands = mergeInlineSteer(
    resolution,
    input.runId,
    input.commands,
    input.admitInlineSteer,
  );
  return { verdict: verdict === "approved" ? "approved" : "steered", commands };
}

function pauseResolution(file: string, id: string): EscalationResolution | undefined {
  const resolution = read(file, escalationResolutionSchema);
  if (resolution?.escalationId !== id || resolution.verdict === "steered") {
    return undefined;
  }
  return resolution;
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
    const { admitPending, admitInlineSteer: onInlineSteer, shouldRelease } = options ?? {};
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
      if (!isStopping() && published?.verdict !== "stopped" && shouldRelease?.() !== true) {
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
      runId: this.runId,
      resolutionFile,
      escalationId: escalation.id,
      isStopping,
      shouldRelease,
      admitInlineSteer: onInlineSteer,
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
  steer?: { readonly id: string; readonly prompt: string },
): Escalation | undefined {
  const dir = runDirectory(base, launch.id);
  const active = readEscalation(path.join(dir, "escalation.json"));
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
    ...(verdict === "approved" && steer !== undefined ? { steer } : {}),
    at: Date.now(),
  });
  return active;
}
