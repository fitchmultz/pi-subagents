import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  overseerNotesSchema,
  type CheckpointKind,
  type Escalation,
  type Launch,
  type OverseerNote,
  type OverseerNotes,
  type SkepticFinding,
} from "./contracts.ts";
import {
  captureSnapshot,
  diffSnapshots,
  type TreeDelta,
  type TreeSnapshot,
} from "./overseer-diff.ts";
import {
  clearJudgeUnavailable,
  recordJudgeCheckpoint,
  recordJudgeUnavailable,
  ToolErrorWindow,
} from "./overseer-evidence.ts";
import { checkpointGuidance } from "./overseer-guidance.ts";
import { EscalationPause, type EscalationAnswer, type SteerCommand } from "./overseer-pause.ts";
import {
  evaluateLiveSkeptic,
  isJudgeDisabled,
  type LiveSkepticOutcome,
} from "./overseer-skeptic.ts";
import { activeOverseer } from "./overseer.ts";
import { notifyInventory } from "./inventory-events.ts";
import { read, runDirectory, write } from "./storage.ts";

const MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "replace_text",
  "write_files",
  "apply_patch",
  "bash",
]);
const SKEPTIC_TURN_INTERVAL = 4;
const SKEPTIC_DIFF_DELTA = 120;
const ESCALATION_EXCERPT_CHARS = 3000;

interface RunSentinelState {
  readonly runId: string;
  readonly excludePaths: readonly string[];
  /** Last snapshot the parent saw (or launch). Every checkpoint shows the delta since here. */
  lastSeen: TreeSnapshot;
  hasSeenCheckpoint: boolean;
  shapeChecked: boolean;
  /** Last snapshot the skeptic evaluated, and the line count of the delta it saw. */
  lastSkeptic: { readonly tree: string | undefined; readonly lines: number };
  turnsSinceSkeptic: number;
  readonly toolErrors: ToolErrorWindow;
  readonly admittedCorrections: Map<string, string>;
  readonly failedJudges: Set<string>;
  pauses: number;
  steers: number;
}

interface PausePayload {
  readonly kind: CheckpointKind;
  readonly summary: string;
  readonly model?: string | undefined;
  readonly findings?: readonly SkepticFinding[] | undefined;
  readonly toolErrorTurns?: Escalation["toolErrorTurns"] | undefined;
}

interface SentinelOptions {
  readonly base: string;
  readonly activeLaunch: () => Launch;
  readonly activeRunBaseline: () => ReadonlySet<string> | undefined;
  readonly isStopping: () => boolean;
  readonly admitPending?: () => void;
  readonly admitInlineSteer?: ((command: SteerCommand) => void) | undefined;
  readonly queueCorrections: (commands: readonly SteerCommand[]) => void;
}

export const harnessExcludePaths = (base: string, launch: Launch): string[] => [
  base,
  launch.agentDir,
  path.dirname(launch.sessionFile),
];

export const readOverseerNotes = (base: string, runId: string): OverseerNote[] =>
  read(path.join(runDirectory(base, runId), "overseer-notes.json"), overseerNotesSchema)?.notes ??
  [];

function appendOverseerNote(base: string, note: OverseerNote): void {
  const file = path.join(runDirectory(base, note.runId), "overseer-notes.json");
  const next: OverseerNotes = { version: 1, notes: [...readOverseerNotes(base, note.runId), note] };
  write(file, next);
  notifyInventory(base, note.runId);
}

const shouldTriggerShapeCheck = (state: RunSentinelState, delta: TreeDelta): boolean =>
  !state.shapeChecked && !delta.unreadable && delta.files.length > 0;

function shouldRunSkeptic(
  state: RunSentinelState,
  snapshot: TreeSnapshot,
  delta: TreeDelta,
  finalSettle: boolean,
): boolean {
  if (delta.unreadable || delta.files.length === 0 || delta.diff === "") {
    return false;
  }
  if (snapshot.tree !== undefined && snapshot.tree === state.lastSkeptic.tree) {
    return false;
  }
  return (
    finalSettle ||
    state.turnsSinceSkeptic >= SKEPTIC_TURN_INTERVAL ||
    Math.abs(delta.lineCount - state.lastSkeptic.lines) >= SKEPTIC_DIFF_DELTA
  );
}

function structuralTurnPayload(
  current: RunSentinelState,
  delta: TreeDelta,
): PausePayload | undefined {
  if (delta.unreadable) {
    return {
      kind: current.shapeChecked ? "final_diff" : "shape_check",
      summary:
        "Working-tree diff is unavailable (git snapshot unreadable or pruned); inspect changes before continuing.",
    };
  }
  if (!shouldTriggerShapeCheck(current, delta)) {
    return undefined;
  }
  const plural = delta.files.length === 1 ? "" : "s";
  return {
    kind: "shape_check",
    summary: `Early shape check: first substantive edits (${delta.files.length} file${plural}, ${delta.lineCount} diff lines).`,
  };
}

export class OverseerSentinel {
  private state: RunSentinelState | undefined;
  private pause: EscalationPause | undefined;
  private readonly options: SentinelOptions;

  constructor(options: SentinelOptions) {
    this.options = options;
  }

  steerPaused(command: SteerCommand): boolean {
    return this.pause?.steer(command) ?? false;
  }

  private primeBaseline(launch: Launch): void {
    if (activeOverseer(this.options.base, launch).enabled) {
      this.ensureState(launch);
    }
  }

  private ensureState(launch: Launch): RunSentinelState {
    if (this.state?.runId === launch.id) {
      return this.state;
    }
    const excludePaths = harnessExcludePaths(this.options.base, launch);
    const start = captureSnapshot(launch.cwd, excludePaths);
    this.state = {
      runId: launch.id,
      excludePaths,
      lastSeen: start,
      hasSeenCheckpoint: false,
      shapeChecked: false,
      lastSkeptic: { tree: start.tree, lines: 0 },
      turnsSinceSkeptic: 0,
      toolErrors: new ToolErrorWindow(),
      admittedCorrections: new Map(),
      failedJudges: new Set(),
      pauses: 0,
      steers: 0,
    };
    return this.state;
  }

  private async pauseForParent(
    launch: Launch,
    payload: PausePayload,
    snapshot: TreeSnapshot,
    delta: TreeDelta,
  ): Promise<EscalationAnswer> {
    const current = this.ensureState(launch);
    current.pauses += 1;
    current.toolErrors.clear();
    const escalation: Escalation = {
      id: randomUUID(),
      runId: launch.id,
      owner: launch.owner,
      at: Date.now(),
      pauseNumber: current.pauses,
      kind: payload.kind,
      summary: payload.summary,
      ...(payload.model !== undefined ? { model: payload.model } : {}),
      ...(payload.findings !== undefined && payload.findings.length > 0
        ? { findings: [...payload.findings] }
        : {}),
      ...(payload.toolErrorTurns !== undefined ? { toolErrorTurns: payload.toolErrorTurns } : {}),
      changedFiles: [...delta.files],
      diffExcerpt: delta.diff.slice(0, ESCALATION_EXCERPT_CHARS),
      diffDigest: snapshot.tree ?? "non-git",
      since: current.hasSeenCheckpoint ? "checkpoint" : "launch",
      ...(delta.stat !== "" ? { stat: delta.stat } : {}),
      ...(delta.diffCommand !== undefined ? { diffCommand: delta.diffCommand } : {}),
      steers: current.steers,
    };
    const pause = new EscalationPause(launch.id);
    this.pause = pause;
    const answer = await pause
      .wait(this.options.base, escalation, this.options.isStopping, {
        admitPending: this.options.admitPending,
        admitInlineSteer: this.options.admitInlineSteer,
        shouldRelease: () => {
          const live = activeOverseer(this.options.base, launch);
          if (!live.enabled) {
            return true;
          }
          return payload.kind === "skeptic" && live.judge === "off";
        },
      })
      .finally(() => {
        this.pause = undefined;
      });
    this.applyAnswer(launch, snapshot, payload.kind, answer);
    return answer;
  }

  private advanceWatermark(launch: Launch, snapshot: TreeSnapshot, kind: CheckpointKind): void {
    const current = this.state;
    if (current === undefined) {
      return;
    }
    const lostGit = current.lastSeen.isGit && !snapshot.isGit;
    const next =
      snapshot.unreadable || lostGit ? captureSnapshot(launch.cwd, current.excludePaths) : snapshot;
    if (!next.unreadable && (!current.lastSeen.isGit || next.isGit)) {
      current.lastSeen = next;
      current.lastSkeptic = { tree: next.tree, lines: 0 };
    }
    current.hasSeenCheckpoint = true;
    if (kind !== "tool_errors") {
      current.shapeChecked = true;
    }
  }

  private applyAnswer(
    launch: Launch,
    snapshot: TreeSnapshot,
    kind: CheckpointKind,
    answer: EscalationAnswer,
  ): void {
    const current = this.state;
    if (current === undefined || answer.verdict === "stopped") {
      return;
    }
    if (answer.verdict === "released") {
      if (isJudgeDisabled(this.options.base, launch)) {
        clearJudgeUnavailable(this.options.base, launch.id);
      }
      current.lastSkeptic = { tree: undefined, lines: 0 };
      return;
    }
    // Parent reviewed this state: advance watermark to a readable snapshot without poisoning lastSeen.
    this.advanceWatermark(launch, snapshot, kind);
    clearJudgeUnavailable(this.options.base, launch.id);
    if (answer.commands.length > 0) {
      current.steers += 1;
      for (const { id, prompt } of answer.commands) {
        current.admittedCorrections.set(id, prompt);
      }
      this.options.queueCorrections(answer.commands);
    }
  }

  private async runSkeptic(
    launch: Launch,
    ctx: ExtensionContext,
    snapshot: TreeSnapshot,
    delta: TreeDelta,
  ): Promise<LiveSkepticOutcome> {
    const live = activeOverseer(this.options.base, launch);
    if (!live.enabled || live.judge === "off") {
      clearJudgeUnavailable(this.options.base, launch.id);
      return { kind: "disabled" };
    }
    const current = this.ensureState(launch);
    const guidance = checkpointGuidance(ctx.sessionManager, launch, {
      baseline: this.options.activeRunBaseline(),
      admittedCorrections: current.admittedCorrections,
    });
    const outcome = await evaluateLiveSkeptic(this.options.base, launch, {
      modelRegistry: ctx.modelRegistry,
      judgeSpec: live.judge,
      ownerContext: launch.ownerContext,
      taskPrompt: launch.prompt,
      guidance,
      changedFiles: delta.files,
      diff: delta.diff,
      failed: current.failedJudges,
      signal: ctx.signal,
    });
    this.recordSkepticOutcome(launch, snapshot, delta, outcome);
    return outcome;
  }

  private recordSkepticOutcome(
    launch: Launch,
    snapshot: TreeSnapshot,
    delta: TreeDelta,
    outcome: LiveSkepticOutcome,
  ): void {
    if (outcome.kind === "disabled") {
      clearJudgeUnavailable(this.options.base, launch.id);
      return;
    }
    if (outcome.kind === "aborted") {
      return;
    }
    const current = this.ensureState(launch);
    current.turnsSinceSkeptic = 0;
    current.lastSkeptic = { tree: snapshot.tree, lines: delta.lineCount };
    if (outcome.kind === "skipped") {
      clearJudgeUnavailable(this.options.base, launch.id);
      return;
    }
    recordJudgeCheckpoint(this.options.base, launch.id, outcome.checkpoint);
    if (outcome.kind === "unavailable") {
      recordJudgeUnavailable(this.options.base, launch.id, outcome.error);
      return;
    }
    clearJudgeUnavailable(this.options.base, launch.id);
    if (outcome.verdict.blocking.length === 0 && outcome.verdict.notes.length > 0) {
      appendOverseerNote(this.options.base, {
        id: randomUUID(),
        runId: launch.id,
        owner: launch.owner,
        at: Date.now(),
        model: outcome.verdict.model,
        findings: [...outcome.verdict.notes],
      });
    }
  }

  private async checkTurnDelta(
    launch: Launch,
    ctx: ExtensionContext,
    snapshot: TreeSnapshot,
    delta: TreeDelta,
  ): Promise<void> {
    if (launch.readOnly === true || delta.files.length === 0) {
      return;
    }
    const current = this.ensureState(launch);
    const structural = structuralTurnPayload(current, delta);
    if (structural !== undefined) {
      await this.pauseForParent(launch, structural, snapshot, delta);
      return;
    }
    if (!shouldRunSkeptic(current, snapshot, delta, false)) {
      return;
    }
    const outcome = await this.runSkeptic(launch, ctx, snapshot, delta);
    if (
      outcome.kind === "verdict" &&
      outcome.verdict.blocking.length > 0 &&
      !this.options.isStopping()
    ) {
      const count = outcome.verdict.blocking.length;
      await this.pauseForParent(
        launch,
        {
          kind: "skeptic",
          model: outcome.verdict.model,
          summary: `${outcome.verdict.model} flagged ${count} grounded concern${count === 1 ? "" : "s"}.`,
          findings: outcome.verdict.blocking,
        },
        snapshot,
        delta,
      );
    }
  }

  private async onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<void> {
    const launch = this.options.activeLaunch();
    if (!activeOverseer(this.options.base, launch).enabled || this.options.isStopping()) {
      return;
    }
    const current = this.ensureState(launch);
    const toolErrorTurns = current.toolErrors.record(event);
    const mutated = event.toolResults.some((result) => MUTATING_TOOLS.has(result.toolName));
    if (mutated) {
      current.turnsSinceSkeptic += 1;
    }
    if (!mutated && toolErrorTurns === undefined) {
      return;
    }
    const snapshot = captureSnapshot(launch.cwd, current.excludePaths);
    const delta = diffSnapshots(launch.cwd, current.lastSeen, snapshot, ESCALATION_EXCERPT_CHARS);
    if (toolErrorTurns !== undefined) {
      await this.pauseForParent(
        launch,
        {
          kind: "tool_errors",
          summary: `${toolErrorTurns.length} consecutive turns reported tool errors.`,
          toolErrorTurns,
        },
        snapshot,
        delta,
      );
      return;
    }
    await this.checkTurnDelta(launch, ctx, snapshot, delta);
  }

  private buildFinalPayload(
    delta: TreeDelta,
    skeptic: { readonly model: string; readonly findings: readonly SkepticFinding[] } | undefined,
  ): PausePayload {
    if (skeptic !== undefined) {
      const count = skeptic.findings.length;
      return {
        kind: "skeptic",
        model: skeptic.model,
        findings: skeptic.findings,
        summary: `Pre-ship check: ${skeptic.model} flagged ${count} grounded concern${count === 1 ? "" : "s"} before completion.`,
      };
    }
    if (delta.unreadable) {
      return {
        kind: "final_diff",
        summary:
          "Final diff check: working-tree diff is unavailable (git snapshot unreadable or pruned); inspect changes before completion.",
      };
    }
    const plural = delta.files.length === 1 ? "" : "s";
    return {
      kind: "final_diff",
      summary: `Final diff check: ${delta.files.length} file${plural} (${delta.lineCount} diff lines) changed since last look.`,
    };
  }

  private async evaluateFinalSkeptic(
    launch: Launch,
    ctx: ExtensionContext,
    snapshot: TreeSnapshot,
    delta: TreeDelta,
  ): Promise<{ readonly model: string; readonly findings: readonly SkepticFinding[] } | undefined> {
    const current = this.ensureState(launch);
    if (!shouldRunSkeptic(current, snapshot, delta, true)) {
      return undefined;
    }
    const outcome = await this.runSkeptic(launch, ctx, snapshot, delta);
    return outcome.kind === "verdict" && outcome.verdict.blocking.length > 0
      ? { model: outcome.verdict.model, findings: outcome.verdict.blocking }
      : undefined;
  }

  private async onBeforeSettle(
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
  ): Promise<BoundaryResult | undefined> {
    const launch = this.options.activeLaunch();
    const skip =
      event.outcome !== "completed" ||
      !activeOverseer(this.options.base, launch).enabled ||
      launch.readOnly === true ||
      this.options.isStopping();
    if (skip) {
      return undefined;
    }
    const current = this.ensureState(launch);
    const snapshot = captureSnapshot(launch.cwd, current.excludePaths);
    const delta = diffSnapshots(launch.cwd, current.lastSeen, snapshot, ESCALATION_EXCERPT_CHARS);
    if (delta.files.length === 0) {
      return undefined;
    }
    const skeptic = await this.evaluateFinalSkeptic(launch, ctx, snapshot, delta);
    if (this.options.isStopping()) {
      return undefined;
    }
    const answer = await this.pauseForParent(
      launch,
      this.buildFinalPayload(delta, skeptic),
      snapshot,
      delta,
    );
    return answer.verdict !== "stopped" &&
      answer.verdict !== "released" &&
      answer.commands.length > 0
      ? { continue: true }
      : undefined;
  }

  attach(pi: ExtensionAPI): void {
    const prime = () => this.primeBaseline(this.options.activeLaunch());
    pi.on("session_start", prime);
    pi.on("before_agent_start", prime);
    pi.on("turn_end", (event, ctx) => this.onTurnEnd(event, ctx));
    pi.on("agent_before_settle", (event, ctx) => this.onBeforeSettle(event, ctx));
  }
}
