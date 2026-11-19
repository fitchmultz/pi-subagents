import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { DelegationContract, Escalation, Launch } from "./contracts.ts";
import { activeContract } from "./overseer-contract.ts";
import { ToolErrorWindow } from "./overseer-evidence.ts";
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
  checkDeterministicTripwires,
  clearJudgeUnavailable,
  evaluateLiveDecisionCheckpoint,
  isEscalationReleased,
  isJudgeDisabled,
  recordJudgeUnavailable,
  type Violation,
} from "./overseer-judge.ts";
import { EscalationPause, type EscalationAnswer, type SteerCommand } from "./overseer-pause.ts";
import { checkpointGuidance } from "./overseer-guidance.ts";
import { activeOverseer } from "./overseer.ts";

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
  launch: ReviewPoint;
  baseBranch: string | undefined;
  /**
   * The last state that passed: approved by the overseer, unchanged, or cleared by the judge.
   * The scope check and the judge see only the work after it.
   */
  reviewPoint: ReviewPoint;
  /** The last state the overseer approved, or launch. A pause shows all the work after it. */
  approved: ReviewPoint;
  /** True only after an overseer approval verdict; survives launch-snapshot baseBranch refreshes. */
  hasApproval: boolean;
  /** Base-branch issues the overseer approved. An approved issue is not raised again. */
  readonly approvedBranchIssues: Set<string>;
  readonly excludePaths: readonly string[];
  readonly toolErrors: ToolErrorWindow;
  readonly admittedCorrections: Map<string, string>;
  turnsSinceJudge: number;
  /** The state the judge last saw, and the size of the new work it saw then. */
  judged: { readonly tree: string | undefined; readonly lines: number };
  /** The classifiers whose request failed in this run. On `auto` the judge asks them last. */
  readonly failedJudges: Set<string>;
  /** Pauses so far, and how many of them the overseer answered with a steer. */
  pauses: number;
  steers: number;
}

/** The child's own work between an accepted state and `snapshot`. */
interface Work {
  readonly snapshot: RepoSnapshot;
  readonly changes: OwnChanges;
  readonly diff: string;
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
  /** Entries that predate this run, including any inherited fork conversation. */
  readonly activeRunBaseline: () => ReadonlySet<string> | undefined;
  readonly isStopping: () => boolean;
  readonly admitPending?: () => void;
  readonly queueCorrections: (commands: readonly SteerCommand[]) => void;
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
    const contract = activeContract(this.options.base, launch);
    if (contract !== undefined) {
      this.ensureState(launch, contract);
    }
  }

  steerPaused(command: SteerCommand): boolean {
    return this.pause?.steer(command) ?? false;
  }

  private ensureState(launch: Launch, contract?: DelegationContract): RunSentinelState {
    if (this.state?.runId === launch.id) {
      return this.state;
    }
    const baseBranch = (contract ?? activeContract(this.options.base, launch))?.baseBranch;
    const excludePaths = harnessExcludePaths(this.options.base, launch);
    const point = launchPoint(launch.cwd, {
      baseBranch,
      excludePaths,
    });
    this.state = {
      runId: launch.id,
      launch: point,
      baseBranch,
      reviewPoint: point,
      approved: point,
      hasApproval: false,
      approvedBranchIssues: new Set(),
      excludePaths,
      toolErrors: new ToolErrorWindow(),
      admittedCorrections: new Map(),
      turnsSinceJudge: 0,
      judged: { tree: point.snapshot.tree, lines: 0 },
      failedJudges: new Set(),
      pauses: 0,
      steers: 0,
    };
    return this.state;
  }

  /** Refreshes the launch snapshot's base-branch refs when baseBranch is amended mid-run. */
  private syncBaseBranch(launch: Launch, baseBranch: string | undefined): void {
    const state = this.state;
    if (state === undefined || state.baseBranch === baseBranch) {
      return;
    }
    state.baseBranch = baseBranch;
    state.approvedBranchIssues.clear();
    const refreshed = captureRepoSnapshot(launch.cwd, {
      baseBranch,
      excludePaths: state.excludePaths,
    });
    state.launch = {
      ...state.launch,
      snapshot: {
        ...state.launch.snapshot,
        baseBranch: refreshed.baseBranch,
        localBaseHead: refreshed.localBaseHead,
        upstreamHead: refreshed.upstreamHead,
        resolvedBaseHead: refreshed.resolvedBaseHead,
        baseBranchUnborn: refreshed.baseBranchUnborn,
      },
    };
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
    const everApproved = current.hasApproval;
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
    toolErrorTurns?: Escalation["toolErrorTurns"],
  ): Promise<void> {
    const current = this.ensureState(launch);
    current.pauses += 1;
    current.toolErrors.clear();
    const escalation: Escalation = {
      id: randomUUID(),
      runId: launch.id,
      owner: launch.owner,
      at: Date.now(),
      strikes: current.pauses,
      steers: current.steers,
      ...issue,
      ...(toolErrorTurns === undefined ? {} : { toolErrorTurns }),
      ...this.unapprovedWork(launch, checkpoint),
      diffDigest: checkpoint.snapshot.tree ?? "non-git",
    };
    const pause = new EscalationPause(launch.id);
    this.pause = pause;
    const answer = await pause
      .wait(this.options.base, escalation, this.options.isStopping, {
        admitPending: this.options.admitPending,
        shouldRelease: () => isEscalationReleased(this.options.base, launch, escalation),
      })
      .finally(() => {
        this.pause = undefined;
      });
    this.applyEscalationAnswer({ launch, issue, checkpoint, answer });
  }

  private applyEscalationAnswer(input: {
    readonly launch: Launch;
    readonly issue: Violation;
    readonly checkpoint: Work;
    readonly answer: EscalationAnswer;
  }): void {
    const { launch, issue, checkpoint, answer } = input;
    if (answer.verdict === "released") {
      if (isJudgeDisabled(this.options.base, launch)) {
        clearJudgeUnavailable(this.options.base, launch.id);
      }
      if (this.state !== undefined) {
        this.state.judged = { tree: "", lines: 0 };
      }
      return;
    }
    const current = this.state;
    if (answer.verdict === "stopped" || current === undefined) {
      return;
    }
    if (answer.verdict === "approved") {
      this.pass(launch, checkpoint.snapshot);
      current.approved = current.reviewPoint;
      current.hasApproval = true;
      if (issue.kind === "branch_violation") {
        current.approvedBranchIssues.add(issue.summary);
      }
    }
    if (answer.commands.length > 0) {
      current.steers += 1;
      for (const { id, prompt } of answer.commands) {
        current.admittedCorrections.set(id, prompt);
      }
      this.options.queueCorrections(answer.commands);
    }
  }

  private async inspectCheckpoint(
    launch: Launch,
    ctx: ExtensionContext,
    finalSettle: boolean,
    toolErrorTurns?: Escalation["toolErrorTurns"],
  ): Promise<void> {
    const contract = activeContract(this.options.base, launch);
    if (
      !activeOverseer(this.options.base, launch).enabled ||
      contract === undefined ||
      this.options.isStopping()
    ) {
      return;
    }
    const current = this.ensureState(launch, contract);
    this.syncBaseBranch(launch, contract.baseBranch);
    const snapshot = captureRepoSnapshot(launch.cwd, {
      baseBranch: contract.baseBranch,
      excludePaths: current.excludePaths,
    });
    const checkpoint = this.workSince(launch, current.reviewPoint, snapshot);
    if (toolErrorTurns !== undefined) {
      return this.escalate(
        launch,
        {
          kind: "loop_violation",
          summary: `${toolErrorTurns.length} consecutive turns reported tool errors.`,
        },
        checkpoint,
        toolErrorTurns,
      );
    }
    const issue = checkDeterministicTripwires({
      cwd: launch.cwd,
      contract,
      launch: current.launch.snapshot,
      current: snapshot,
      changes: checkpoint.changes,
    });
    if (issue !== undefined && !current.approvedBranchIssues.has(issue.summary)) {
      return this.escalate(launch, issue, checkpoint);
    }
    return this.judge(launch, contract, ctx, { checkpoint, finalSettle });
  }

  /** Asks the judge about the new work when a trigger holds; a clean answer moves the review point. */
  private async judge(
    launch: Launch,
    contract: DelegationContract,
    ctx: ExtensionContext,
    options: { readonly checkpoint: Work; readonly finalSettle: boolean },
  ): Promise<void> {
    const initialLive = activeOverseer(this.options.base, launch);
    if (!initialLive.enabled) {
      clearJudgeUnavailable(this.options.base, launch.id);
      return;
    }
    const { checkpoint, finalSettle } = options;
    const current = this.ensureState(launch, contract);
    const { snapshot } = checkpoint;
    if (checkpoint.changes.files.length === 0) {
      this.pass(launch, snapshot);
      return;
    }
    if (!shouldRunJudgeCheckpoint(current, checkpoint, finalSettle)) {
      return;
    }
    if (initialLive.judge === "off") {
      current.turnsSinceJudge = 0;
      current.judged = { tree: snapshot.tree, lines: lineCount(checkpoint.diff) };
      clearJudgeUnavailable(this.options.base, launch.id);
      this.pass(launch, snapshot);
      return;
    }
    const acceptedFiles = this.changedBefore(launch, current.reviewPoint);
    const guidance = checkpointGuidance(ctx.sessionManager, launch, {
      baseline: this.options.activeRunBaseline(),
      admittedCorrections: current.admittedCorrections,
    });
    const outcome = await evaluateLiveDecisionCheckpoint(this.options.base, launch, {
      modelRegistry: ctx.modelRegistry,
      judgeSpec: initialLive.judge,
      prompt: launch.prompt,
      continuation: launch.predecessor !== undefined,
      guidance,
      contract,
      changedFiles: checkpoint.changes.files,
      acceptedFiles,
      diff: checkpoint.diff,
      failed: current.failedJudges,
      // Cancelling the child's run or disabling the judge mid-run cancels its judge request.
      signal: ctx.signal,
    });
    if (outcome.kind === "disabled") {
      clearJudgeUnavailable(this.options.base, launch.id);
      return;
    }
    if (outcome.kind === "aborted") {
      // Neither a verdict nor a fault of the judge: the work waits for the next checkpoint.
      return;
    }
    current.turnsSinceJudge = 0;
    current.judged = { tree: snapshot.tree, lines: lineCount(checkpoint.diff) };
    if (outcome.kind === "unavailable") {
      // No judge answered. That is no finding about the work, so the child is not paused. The
      // review point stays: a later checkpoint asks again about all the work since then, and
      // the completion notice reports a run that ends with work no judge answered for.
      recordJudgeUnavailable(this.options.base, launch.id, outcome.error);
      return;
    }
    // A classifier answered: the work is judged, whatever the verdict.
    clearJudgeUnavailable(this.options.base, launch.id);
    if (outcome.verdict === undefined) {
      this.pass(launch, snapshot);
      return;
    }
    if (!this.options.isStopping()) {
      await this.escalate(launch, outcome.verdict, checkpoint);
    }
  }

  private async onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext) {
    const launch = this.options.activeLaunch();
    const contract = activeContract(this.options.base, launch);
    if (!activeOverseer(this.options.base, launch).enabled || contract === undefined) {
      return;
    }
    const current = this.ensureState(launch, contract);
    const toolErrorTurns = current.toolErrors.record(event);
    const mutated = event.toolResults.some((result) => MUTATING_TOOLS.has(result.toolName));
    if (mutated) {
      current.turnsSinceJudge += 1;
    }
    if (!mutated && toolErrorTurns === undefined) {
      return;
    }
    await this.inspectCheckpoint(launch, ctx, false, toolErrorTurns);
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
      await this.inspectCheckpoint(this.options.activeLaunch(), ctx, true);
    });
  }
}
