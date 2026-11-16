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
  CONSECUTIVE_ERROR_TURN_LIMIT,
  captureRepoSnapshot,
  changedFilesSinceBaseline,
  checkDeterministicTripwires,
  evaluateDecisionCheckpoint,
  type RepoSnapshot,
  type ViolationCandidate,
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

interface RunSentinelState {
  readonly runId: string;
  readonly baseline: RepoSnapshot;
  readonly excludePaths: readonly string[];
  readonly seenSteerFiles: Set<string>;
  consecutiveErrors: number;
  turnsSinceJudge: number;
  lastJudgedDigest: string;
  lastJudgedLines: number;
  strikes: number;
  readonly approvedDigests: Set<string>;
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

function checkResolution(
  resolutionFile: string,
  escalationId: string,
  approvedDigests: Set<string>,
): EscalationResolution["verdict"] | undefined {
  const resolution = read(resolutionFile, escalationResolutionSchema);
  if (resolution?.escalationId !== escalationId) {
    return undefined;
  }
  if (resolution.verdict === "approved" && resolution.diffDigest !== undefined) {
    approvedDigests.add(resolution.diffDigest);
  }
  return resolution.verdict;
}

export async function waitForEscalationResolution(options: {
  base: string;
  launch: Launch;
  escalation: Escalation;
  approvedDigests: Set<string>;
  isStopping: () => boolean;
  seenSteerFiles?: Set<string> | undefined;
}): Promise<EscalationResolution["verdict"]> {
  const { base, launch, escalation, approvedDigests, isStopping } = options;
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
      const verdict = checkResolution(resolutionFile, escalation.id, approvedDigests);
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

function diffLineCount(snapshot: RepoSnapshot): number {
  return snapshot.rawDiff === "" ? 0 : snapshot.rawDiff.split("\n").length;
}

function shouldRunJudgeCheckpoint(
  state: RunSentinelState,
  snapshot: RepoSnapshot,
  finalSettle: boolean,
): boolean {
  if (snapshot.digest === state.lastJudgedDigest || state.approvedDigests.has(snapshot.digest)) {
    return false;
  }
  if (finalSettle) {
    return true;
  }
  return (
    state.turnsSinceJudge >= JUDGE_TURN_INTERVAL ||
    Math.abs(diffLineCount(snapshot) - state.lastJudgedLines) >= JUDGE_DIFF_DELTA
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
  snapshot: RepoSnapshot,
  changedFiles: string[],
): Promise<ViolationCandidate | undefined> {
  if (launch.contract === undefined) {
    return undefined;
  }
  try {
    return await evaluateDecisionCheckpoint({
      modelRegistry: ctx.modelRegistry,
      judgeSpec: launch.overseer?.judge,
      prompt: launch.prompt,
      contract: launch.contract,
      changedFiles,
      snapshot,
      signal: undefined,
    });
  } catch (error) {
    return {
      kind: "loop_violation",
      summary: errorText(error),
      changedFiles,
      diffExcerpt: snapshot.diffExcerpt,
      diffDigest: snapshot.digest,
    };
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
    const baseline = captureRepoSnapshot(launch.cwd, {
      baseBranch: launch.contract?.baseBranch,
      excludePaths,
    });
    const commandsDir = path.join(conversation(this.options.base, launch), "commands");
    this.state = {
      runId: launch.id,
      baseline,
      excludePaths,
      seenSteerFiles: jsonFiles(commandsDir),
      consecutiveErrors: 0,
      turnsSinceJudge: 0,
      lastJudgedDigest: baseline.digest,
      lastJudgedLines: diffLineCount(baseline),
      strikes: 0,
      approvedDigests: new Set(),
    };
    return this.state;
  }

  private async escalate(
    launch: Launch,
    hit: ViolationCandidate,
  ): Promise<EscalationResolution["verdict"]> {
    const current = this.ensureState(launch);
    current.strikes += 1;
    current.consecutiveErrors = 0;
    const escalation: Escalation = {
      id: randomUUID(),
      runId: launch.id,
      owner: launch.owner,
      at: Date.now(),
      strikes: current.strikes,
      ...hit,
    };
    return waitForEscalationResolution({
      base: this.options.base,
      launch,
      escalation,
      approvedDigests: current.approvedDigests,
      isStopping: this.options.isStopping,
      seenSteerFiles: current.seenSteerFiles,
    });
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
      baselineHead: current.baseline.head,
      hasBaseline: true,
      baseBranch: launch.contract.baseBranch,
      excludePaths: current.excludePaths,
    });
    const localHit = checkDeterministicTripwires({
      cwd: launch.cwd,
      contract: launch.contract,
      baseline: current.baseline,
      current: snapshot,
      consecutiveErrors: current.consecutiveErrors,
      excludePaths: current.excludePaths,
    });
    if (localHit !== undefined && !current.approvedDigests.has(localHit.diffDigest)) {
      return this.escalate(launch, localHit);
    }
    if (!shouldRunJudgeCheckpoint(current, snapshot, finalSettle)) {
      return undefined;
    }
    current.turnsSinceJudge = 0;
    const changedFiles = changedFilesSinceBaseline(
      launch.cwd,
      current.baseline,
      snapshot,
      current.excludePaths,
    );
    const judgeHit = await safeJudge(launch, ctx, snapshot, changedFiles);
    if (judgeHit === undefined) {
      current.lastJudgedDigest = snapshot.digest;
      current.lastJudgedLines = diffLineCount(snapshot);
      return undefined;
    }
    if (!this.options.isStopping()) {
      return this.escalate(launch, judgeHit);
    }
    return undefined;
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
