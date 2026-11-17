import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../shared/unknown.ts";
import {
  commandMetadataSchema,
  escalationResolutionSchema,
  escalationSchema,
  type Escalation,
  type EscalationResolution,
  type Launch,
} from "./contracts.ts";
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
  evaluateDecisionCheckpoint,
  type Violation,
} from "./overseer-judge.ts";
import { conversation, read, runDirectory, write } from "./storage.ts";
import { DirectoryWatch, Wake } from "./wake.ts";

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
  readonly seenSteerFiles: Set<string>;
  consecutiveErrors: number;
  turnsSinceJudge: number;
  /** The state the judge last saw, and the size of the new work it saw then. */
  judged: { readonly tree: string | undefined; readonly lines: number };
  strikes: number;
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

function jsonFiles(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).filter((file) => file.endsWith(".json")));
  } catch {
    return new Set();
  }
}

function consumePendingSteers(
  commandsDir: string,
  runId: string,
  seenSteerFiles: Set<string>,
): boolean {
  let found = false;
  for (const file of jsonFiles(commandsDir)) {
    if (seenSteerFiles.has(file)) {
      continue;
    }
    const meta = read(path.join(commandsDir, file), commandMetadataSchema);
    if (meta?.runId === runId && meta.action === "steer") {
      seenSteerFiles.add(file);
      found = true;
    }
  }
  return found;
}

function resolutionVerdict(
  resolutionFile: string,
  escalationId: string,
): EscalationResolution["verdict"] | undefined {
  const resolution = read(resolutionFile, escalationResolutionSchema);
  return resolution?.escalationId === escalationId ? resolution.verdict : undefined;
}

export async function waitForEscalationResolution(options: {
  base: string;
  launch: Launch;
  escalation: Escalation;
  isStopping: () => boolean;
  seenSteerFiles?: Set<string> | undefined;
}): Promise<EscalationResolution["verdict"]> {
  const { base, launch, escalation, isStopping } = options;
  const runDir = runDirectory(base, launch.id);
  const convDir = conversation(base, launch);
  const commandsDir = path.join(convDir, "commands");
  const seenSteers = options.seenSteerFiles ?? jsonFiles(path.join(convDir, "admissions"));
  const escalationFile = path.join(runDir, "escalation.json");
  const resolutionFile = path.join(runDir, "escalation-resolution.json");
  write(escalationFile, escalation);

  const wake = new Wake();
  const watchRun = new DirectoryWatch(runDir, () => true, wake.raise);
  const watchCommands = new DirectoryWatch(commandsDir, () => true, wake.raise);
  try {
    while (!isStopping()) {
      wake.take();
      watchRun.ensure();
      watchCommands.ensure();
      const verdict = resolutionVerdict(resolutionFile, escalation.id);
      if (verdict !== undefined) {
        consumePendingSteers(commandsDir, launch.id, seenSteers);
        return verdict;
      }
      if (consumePendingSteers(commandsDir, launch.id, seenSteers)) {
        return "steered";
      }
      await wake.sleep(200);
    }
    return "stopped";
  } finally {
    watchRun.close();
    watchCommands.close();
    fs.rmSync(escalationFile, { force: true });
  }
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
  // The judge already answered for this exact state.
  if (checkpoint.snapshot.tree === state.judged.tree) {
    return false;
  }
  return (
    state.turnsSinceJudge >= JUDGE_TURN_INTERVAL ||
    Math.abs(lineCount(checkpoint.diff) - state.judged.lines) >= JUDGE_DIFF_DELTA
  );
}

export interface SentinelOptions {
  readonly base: string;
  readonly activeLaunch: () => Launch;
  readonly isStopping: () => boolean;
  readonly flushPendingCommands?: () => boolean;
}

export function resolveActiveEscalation(
  base: string,
  launch: Launch,
  verdict: "steered" | "approved" | "stopped",
): Escalation | undefined {
  const dir = runDirectory(base, launch.id);
  const active = read(path.join(dir, "escalation.json"), escalationSchema);
  if (active === undefined) {
    return undefined;
  }
  write(path.join(dir, "escalation-resolution.json"), {
    escalationId: active.id,
    verdict,
    ...(verdict === "approved" ? { diffDigest: active.diffDigest } : {}),
    at: Date.now(),
  });
  return active;
}

async function safeJudge(
  launch: Launch,
  ctx: ExtensionContext,
  checkpoint: Work,
  acceptedFiles: readonly string[],
): Promise<Violation | undefined> {
  if (launch.contract === undefined) {
    return undefined;
  }
  try {
    return await evaluateDecisionCheckpoint({
      modelRegistry: ctx.modelRegistry,
      judgeSpec: launch.overseer?.judge,
      prompt: launch.prompt,
      contract: launch.contract,
      changedFiles: checkpoint.changes.files,
      acceptedFiles,
      diff: checkpoint.diff,
      signal: undefined,
    });
  } catch (error) {
    return { kind: "loop_violation", summary: errorText(error) };
  }
}

export function harnessExcludePaths(base: string, launch: Launch): string[] {
  return [base, launch.agentDir, path.dirname(launch.sessionFile)];
}

class SentinelRunner {
  private state: RunSentinelState | undefined;
  private readonly options: SentinelOptions;

  constructor(options: SentinelOptions) {
    this.options = options;
  }

  primeBaseline(launch: Launch): void {
    if (launch.overseer?.enabled === true && launch.contract !== undefined) {
      this.ensureState(launch);
    }
  }

  markTurnSteers(launch: Launch): void {
    if (launch.overseer?.enabled !== true || launch.contract === undefined) {
      return;
    }
    const current = this.ensureState(launch);
    for (const file of jsonFiles(
      path.join(conversation(this.options.base, launch), "admissions"),
    )) {
      current.seenSteerFiles.add(file);
    }
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
    const commandsDir = path.join(conversation(this.options.base, launch), "commands");
    this.state = {
      runId: launch.id,
      launch: point,
      reviewPoint: point,
      approved: point,
      approvedBranchIssues: new Set(),
      excludePaths,
      seenSteerFiles: jsonFiles(commandsDir),
      consecutiveErrors: 0,
      turnsSinceJudge: 0,
      judged: { tree: point.snapshot.tree, lines: 0 },
      strikes: 0,
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
  }

  private async escalate(
    launch: Launch,
    issue: Violation,
    checkpoint: Work,
  ): Promise<EscalationResolution["verdict"]> {
    const current = this.ensureState(launch);
    current.strikes += 1;
    current.consecutiveErrors = 0;
    // The overseer answers for all the work it has not approved, not only for what failed now.
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
    const escalation: Escalation = {
      id: randomUUID(),
      runId: launch.id,
      owner: launch.owner,
      at: Date.now(),
      strikes: current.strikes,
      ...issue,
      changedFiles: [...unapproved.changes.files],
      diffExcerpt: unapproved.diff.slice(0, ESCALATION_EXCERPT_CHARS),
      diffDigest: checkpoint.snapshot.tree ?? "non-git",
      since: everApproved ? "approval" : "launch",
      stat: changesStat(launch.cwd, unapproved.changes),
      ...(diffCommand === undefined ? {} : { diffCommand }),
      // Named only when it narrows the list: where the overseer should look first.
      unchecked: flagged.join("\0") === unapproved.changes.files.join("\0") ? [] : [...flagged],
      leftBehind: [...unapproved.changes.leftBehind],
      approved: everApproved ? this.changedBefore(launch, current.approved) : [],
    };
    const verdict = await waitForEscalationResolution({
      base: this.options.base,
      launch,
      escalation,
      isStopping: this.options.isStopping,
      seenSteerFiles: current.seenSteerFiles,
    });
    if (verdict === "approved") {
      this.pass(launch, checkpoint.snapshot);
      current.approved = current.reviewPoint;
      if (issue.kind === "branch_violation") {
        current.approvedBranchIssues.add(issue.summary);
      }
    }
    return verdict;
  }

  async inspectCheckpoint(
    launch: Launch,
    ctx: ExtensionContext,
    finalSettle: boolean,
  ): Promise<EscalationResolution["verdict"] | undefined> {
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
  ): Promise<EscalationResolution["verdict"] | undefined> {
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
    const accepted = this.changedBefore(launch, current.reviewPoint);
    const verdict = await safeJudge(launch, ctx, checkpoint, accepted);
    if (verdict === undefined) {
      this.pass(launch, snapshot);
      return undefined;
    }
    return this.options.isStopping() ? undefined : this.escalate(launch, verdict, checkpoint);
  }

  async onTurnEnd(event: unknown, ctx: ExtensionContext): Promise<void> {
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
    await this.inspectCheckpoint(launch, ctx, false);
  }
}

export function attachOverseerSentinel(pi: ExtensionAPI, options: SentinelOptions): void {
  const runner = new SentinelRunner(options);
  pi.on("session_start", () => {
    runner.primeBaseline(options.activeLaunch());
  });
  pi.on("before_agent_start", () => {
    runner.primeBaseline(options.activeLaunch());
  });
  pi.on("turn_start", () => {
    runner.markTurnSteers(options.activeLaunch());
  });
  pi.on("turn_end", async (event, ctx) => {
    await runner.onTurnEnd(event, ctx);
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") {
      return;
    }
    const verdict = await runner.inspectCheckpoint(options.activeLaunch(), ctx, true);
    if (verdict !== "steered") {
      return;
    }
    if (
      options.flushPendingCommands?.() === true ||
      event.context.pendingMessages.length > 0 ||
      ctx.hasPendingMessages()
    ) {
      return { continue: true };
    }
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "overseer-sentinel",
          display: false,
          content:
            "Overseer steered this run before settlement. Apply the steering guidance and satisfy the delegation contract before finishing.",
        },
      ],
      continue: true,
    };
  });
}
