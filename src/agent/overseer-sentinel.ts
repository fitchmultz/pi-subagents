import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../shared/unknown.ts";
import type { Escalation, Launch } from "./contracts.ts";
import { errorText } from "./host.ts";
import {
  acceptedPoint,
  captureRepoSnapshot,
  changesDiff,
  changesDiffCommand,
  changesStat,
  launchPoint,
  ownChanges,
  type OwnChanges,
  type RepoSnapshot,
  type ReviewPoint,
} from "./overseer-git.ts";
import {
  CONSECUTIVE_ERROR_TURN_LIMIT,
  checkDeterministicTripwires,
  clearJudgeUnavailable,
  evaluateDecisionCheckpoint,
  recordJudgeUnavailable,
  type Violation,
} from "./overseer-judge.ts";
import { EscalationPause, type EscalationAnswer } from "./overseer-pause.ts";

const MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "replace_text",
  "write_files",
  "apply_patch",
  "bash",
]);
const JUDGE_TURN_INTERVAL = 4;
const JUDGE_DIFF_DELTA = 120;
const ESCALATION_EXCERPT_CHARS = 3000;

interface RunSentinelState {
  readonly runId: string;
  readonly launch: ReviewPoint;
  /**
   * The last state that passed: approved by the overseer, unchanged, or cleared by the judge.
   * The scope check and the judge see only the work after it.
   */
  reviewPoint: ReviewPoint;
  /** The last state the overseer approved, or launch. A pause shows all the work after it. */
  approved: ReviewPoint;
  /** Base-branch issues the overseer approved. An approved issue is not raised again. */
  readonly approvedBranchIssues: Set<string>;
  readonly excludePaths: readonly string[];
  consecutiveErrors: number;
  turnsSinceJudge: number;
  /** The state the judge last saw, and the size of the new work it saw then. */
  judged: { readonly tree: string | undefined; readonly lines: number };
  /** The classifiers whose request failed in this run. On `auto` the judge asks them last. */
  readonly failedJudges: Set<string>;
  /** Pauses so far, and how many of them the overseer answered with a correction. */
  pauses: number;
  corrections: number;
}

/** The child's own work between an accepted state and `snapshot`. */
interface Work {
  readonly snapshot: RepoSnapshot;
  readonly changes: OwnChanges;
  readonly diff: string;
}

function turnTools(toolResults: unknown): { hadError: boolean; mutated: boolean } {
  if (!Array.isArray(toolResults)) {
    return { hadError: false, mutated: false };
  }
  let hadError = false;
  let mutated = false;
  for (const item of toolResults) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.isError === true) {
      hadError = true;
    }
    if (typeof item.toolName === "string" && MUTATING_TOOLS.has(item.toolName)) {
      mutated = true;
    }
  }
  return { hadError, mutated };
}

function lineCount(diff: string): number {
  return diff === "" ? 0 : diff.split("\n").length;
}

function shouldRunJudgeCheckpoint(
  state: RunSentinelState,
  checkpoint: Work,
  finalSettle: boolean,
): boolean {
  if (finalSettle) {
    return true;
  }
  // The judge was already asked about this exact state.
  if (checkpoint.snapshot.tree === state.judged.tree) {
    return false;
  }
  return (
    state.turnsSinceJudge >= JUDGE_TURN_INTERVAL ||
    Math.abs(lineCount(checkpoint.diff) - state.judged.lines) >= JUDGE_DIFF_DELTA
  );
}

interface SentinelOptions {
  readonly base: string;
  readonly activeLaunch: () => Launch;
  readonly isStopping: () => boolean;
}

/** Rejects when no judge answered. */
async function askJudge(
  launch: Launch,
  ctx: ExtensionContext,
  work: { checkpoint: Work; acceptedFiles: readonly string[]; failed: Set<string> },
): Promise<Violation | undefined> {
  if (launch.contract === undefined) {
    return undefined;
  }
  return evaluateDecisionCheckpoint({
    modelRegistry: ctx.modelRegistry,
    judgeSpec: launch.overseer?.judge,
    prompt: launch.prompt,
    contract: launch.contract,
    changedFiles: work.checkpoint.changes.files,
    acceptedFiles: work.acceptedFiles,
    diff: work.checkpoint.diff,
    failed: work.failed,
    // Cancelling the child's run cancels its judge request.
    signal: ctx.signal,
  });
}

export function harnessExcludePaths(base: string, launch: Launch): string[] {
  return [base, launch.agentDir, path.dirname(launch.sessionFile)];
}

export class OverseerSentinel {
  private state: RunSentinelState | undefined;
  private pause: EscalationPause | undefined;
  private readonly options: SentinelOptions;

  constructor(options: SentinelOptions) {
    this.options = options;
  }

  private primeBaseline(launch: Launch): void {
    if (launch.overseer?.enabled === true && launch.contract !== undefined) {
      this.ensureState(launch);
    }
  }

  steerPaused(runId: string, prompt: string): boolean {
    return this.pause?.steer(runId, prompt) ?? false;
  }

  private ensureState(launch: Launch): RunSentinelState {
    if (this.state?.runId === launch.id) {
      return this.state;
    }
    const excludePaths = harnessExcludePaths(this.options.base, launch);
    const point = launchPoint(launch.cwd, {
      baseBranch: launch.contract?.baseBranch,
      excludePaths,
    });
    this.state = {
      runId: launch.id,
      launch: point,
      reviewPoint: point,
      approved: point,
      approvedBranchIssues: new Set(),
      excludePaths,
      consecutiveErrors: 0,
      turnsSinceJudge: 0,
      judged: { tree: point.snapshot.tree, lines: 0 },
      failedJudges: new Set(),
      pauses: 0,
      corrections: 0,
    };
    return this.state;
  }

  private workSince(launch: Launch, point: ReviewPoint, snapshot: RepoSnapshot): Work {
    const { excludePaths } = this.ensureState(launch);
    const changes = ownChanges(launch.cwd, point, snapshot, excludePaths);
    return { snapshot, changes, diff: changesDiff(changes) };
  }

  /** The files the child changed between launch and an accepted state. */
  private changedBefore(launch: Launch, point: ReviewPoint): string[] {
    const { launch: start, excludePaths } = this.ensureState(launch);
    return [...ownChanges(launch.cwd, start, point.snapshot, excludePaths).files];
  }

  /** Moves the review point: later checks and judge verdicts cover only what changes after `snapshot`. */
  private pass(launch: Launch, snapshot: RepoSnapshot): void {
    const current = this.ensureState(launch);
    current.reviewPoint = acceptedPoint(current.reviewPoint, snapshot);
    current.judged = { tree: snapshot.tree, lines: 0 };
    // The passed state has no work that still waits for a judge.
    clearJudgeUnavailable(this.options.base, launch.id);
  }

  /** What a pause shows: all the work the overseer has not approved, not only what failed now. */
  private unapprovedWork(
    launch: Launch,
    checkpoint: Work,
  ): Pick<
    Escalation,
    | "changedFiles"
    | "diffExcerpt"
    | "since"
    | "stat"
    | "diffCommand"
    | "unchecked"
    | "leftBehind"
    | "approved"
  > {
    const current = this.ensureState(launch);
    const unapproved =
      current.approved === current.reviewPoint
        ? checkpoint
        : this.workSince(launch, current.approved, checkpoint.snapshot);
    const everApproved = current.approved !== current.launch;
    const flagged = checkpoint.changes.files;
    const diffCommand =
      unapproved.diff.length > ESCALATION_EXCERPT_CHARS
        ? changesDiffCommand(unapproved.changes)
        : undefined;
    return {
      changedFiles: [...unapproved.changes.files],
      diffExcerpt: unapproved.diff.slice(0, ESCALATION_EXCERPT_CHARS),
      since: everApproved ? "approval" : "launch",
      stat: changesStat(launch.cwd, unapproved.changes),
      ...(diffCommand === undefined ? {} : { diffCommand }),
      // Named only when it narrows the list: where the overseer should look first.
      unchecked: flagged.join("\0") === unapproved.changes.files.join("\0") ? [] : [...flagged],
      leftBehind: [...unapproved.changes.leftBehind],
      approved: everApproved ? this.changedBefore(launch, current.approved) : [],
    };
  }

  private async escalate(
    launch: Launch,
    issue: Violation,
    checkpoint: Work,
  ): Promise<EscalationAnswer> {
    const current = this.ensureState(launch);
    current.pauses += 1;
    current.consecutiveErrors = 0;
    const escalation: Escalation = {
      id: randomUUID(),
      runId: launch.id,
      owner: launch.owner,
      at: Date.now(),
      strikes: current.pauses,
      corrections: current.corrections,
      ...issue,
      ...this.unapprovedWork(launch, checkpoint),
      diffDigest: checkpoint.snapshot.tree ?? "non-git",
    };
    const pause = new EscalationPause(launch.id);
    this.pause = pause;
    const answer = await pause
      .wait(this.options.base, escalation, this.options.isStopping)
      .finally(() => {
        this.pause = undefined;
      });
    if (answer.verdict === "steered") {
      current.corrections += 1;
    }
    if (answer.verdict === "approved") {
      this.pass(launch, checkpoint.snapshot);
      current.approved = current.reviewPoint;
      if (issue.kind === "branch_violation") {
        current.approvedBranchIssues.add(issue.summary);
      }
    }
    return answer;
  }

  private async inspectCheckpoint(
    launch: Launch,
    ctx: ExtensionContext,
    finalSettle: boolean,
  ): Promise<EscalationAnswer | undefined> {
    if (
      launch.overseer?.enabled !== true ||
      launch.contract === undefined ||
      this.options.isStopping()
    ) {
      return undefined;
    }
    const current = this.ensureState(launch);
    const snapshot = captureRepoSnapshot(launch.cwd, {
      baseBranch: launch.contract.baseBranch,
      excludePaths: current.excludePaths,
    });
    const checkpoint = this.workSince(launch, current.reviewPoint, snapshot);
    const issue = checkDeterministicTripwires({
      cwd: launch.cwd,
      contract: launch.contract,
      launch: current.launch.snapshot,
      current: snapshot,
      changes: checkpoint.changes,
      consecutiveErrors: current.consecutiveErrors,
    });
    if (issue !== undefined && !current.approvedBranchIssues.has(issue.summary)) {
      return this.escalate(launch, issue, checkpoint);
    }
    return this.judge(launch, ctx, checkpoint, finalSettle);
  }

  /** Asks the judge about the new work when a trigger holds; a clean answer moves the review point. */
  private async judge(
    launch: Launch,
    ctx: ExtensionContext,
    checkpoint: Work,
    finalSettle: boolean,
  ): Promise<EscalationAnswer | undefined> {
    const current = this.ensureState(launch);
    const { snapshot } = checkpoint;
    if (checkpoint.changes.files.length === 0) {
      this.pass(launch, snapshot);
      return undefined;
    }
    if (!shouldRunJudgeCheckpoint(current, checkpoint, finalSettle)) {
      return undefined;
    }
    current.turnsSinceJudge = 0;
    current.judged = { tree: snapshot.tree, lines: lineCount(checkpoint.diff) };
    const acceptedFiles = this.changedBefore(launch, current.reviewPoint);
    // The signal of the run that is active now. `ctx.signal` is gone when that run ends.
    const { signal } = ctx;
    let verdict: Violation | undefined;
    try {
      const failed = current.failedJudges;
      verdict = await askJudge(launch, ctx, { checkpoint, acceptedFiles, failed });
    } catch (error) {
      if (signal?.aborted === true) {
        // Neither a verdict nor a fault of the judge: the work waits for the next checkpoint.
        return undefined;
      }
      // No judge answered. That is no finding about the work, so the child is not paused. The
      // review point stays: a later checkpoint asks again about all the work since then, and
      // the completion notice reports a run that ends with work no judge answered for.
      recordJudgeUnavailable(this.options.base, launch.id, errorText(error));
      return undefined;
    }
    // A classifier answered: the work is judged, whatever the verdict.
    clearJudgeUnavailable(this.options.base, launch.id);
    if (verdict === undefined) {
      this.pass(launch, snapshot);
      return undefined;
    }
    return this.options.isStopping() ? undefined : this.escalate(launch, verdict, checkpoint);
  }

  private async onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext) {
    const launch = this.options.activeLaunch();
    if (launch.overseer?.enabled !== true || launch.contract === undefined) {
      return;
    }
    const current = this.ensureState(launch);
    const toolResults = isRecord(event) ? event.toolResults : undefined;
    const { hadError, mutated } = turnTools(toolResults);
    current.consecutiveErrors = hadError ? current.consecutiveErrors + 1 : 0;
    if (mutated) {
      current.turnsSinceJudge += 1;
    }
    if (!mutated && current.consecutiveErrors < CONSECUTIVE_ERROR_TURN_LIMIT) {
      return;
    }
    return correctionDrafts(event, await this.inspectCheckpoint(launch, ctx, false));
  }

  attach(pi: ExtensionAPI): void {
    pi.on("session_start", () => {
      this.primeBaseline(this.options.activeLaunch());
    });
    pi.on("before_agent_start", () => {
      this.primeBaseline(this.options.activeLaunch());
    });
    pi.on("turn_end", (event, ctx) => this.onTurnEnd(event, ctx));
    pi.on("agent_before_settle", async (event, ctx) => {
      if (event.outcome !== "completed") {
        return;
      }
      return correctionDrafts(
        event,
        await this.inspectCheckpoint(this.options.activeLaunch(), ctx, true),
      );
    });
  }
}

function correctionDrafts(
  event: TurnEndEvent | AgentBeforeSettleEvent,
  answer: EscalationAnswer | undefined,
) {
  if (answer?.verdict !== "steered") {
    return;
  }
  // Pi commits these drafts before the next request. Ordinary steers stay in its native queue.
  return {
    entries: [
      ...event.entries,
      ...answer.prompts.map((prompt) => ({
        type: "custom_message" as const,
        customType: "overseer-correction",
        display: true,
        content: prompt,
      })),
    ],
    continue: true,
  };
}
