import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionReceipts, escalationReceipts } from "./receipts.ts";
import { readOutputPage } from "../shared/output-page.ts";
import { journalStamp } from "../shared/native-journal.ts";
import {
  escalationResolutionSchema,
  escalationSchema,
  type Escalation,
  type Launch,
  type Result,
} from "./contracts.ts";
import { needsOverseerReview } from "./overseer-review.ts";
import { launchAt, list, read, runDirectory } from "./storage.ts";
import { accountingState, readCanonicalResult, readResult } from "./usage.ts";

function isStringSet(value: unknown): value is Set<string> {
  if (!(value instanceof Set)) {
    return false;
  }
  const entries: Set<unknown> = value;
  return [...entries].every((entry) => typeof entry === "string");
}

function queuedAdmissions(): Set<string> {
  const store = globalThis as Record<string, unknown>;
  const existing = store.__pi_single_agent_admissions__;
  if (isStringSet(existing)) {
    // Keep one live queue identity across native extension reloads.
    return existing;
  }
  const queued = new Set<string>();
  store.__pi_single_agent_admissions__ = queued;
  return queued;
}
const admissions = queuedAdmissions();
function hold(owner: string, id: string): void {
  admissions.add(`${owner}/${id}`);
}
export function release(owner: string, id: string): void {
  admissions.delete(`${owner}/${id}`);
}
type DeliveryDecision =
  | { readonly kind: "published"; readonly where: "file" | "memory" }
  | { readonly kind: "held" | "deliverable" };

/** Canonical result readers establish availability before deciding delivery. */
function deliveryDecision(receipt: "file" | "memory" | undefined, held: boolean): DeliveryDecision {
  return receipt === undefined
    ? { kind: held ? "held" : "deliverable" }
    : { kind: "published", where: receipt };
}

export function completionDelivery(
  owner: string,
  id: string,
  receipt: "file" | "memory" | undefined,
): DeliveryDecision {
  return deliveryDecision(receipt, admissions.has(`${owner}/${id}`));
}
/** Returns whether any admission was released for reconciliation. */
export function settle(owner: string, pending: boolean): boolean {
  if (pending) {
    return false;
  }
  let released = false;
  for (const key of admissions) {
    if (key.startsWith(`${owner}/`)) {
      admissions.delete(key);
      released = true;
    }
  }
  return released;
}
export function published(ctx: ExtensionContext, launch: Launch): string | undefined {
  return completionReceipts(ctx.sessionManager, launch.owner).get(launch.id);
}
export interface Completion {
  readonly owner: string;
  readonly id: string;
  readonly message: Parameters<ExtensionAPI["sendMessage"]>[0];
}
export function deliver(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  notices: readonly Completion[],
): void {
  const idle = ctx.isIdle();
  for (const [index, notice] of notices.entries()) {
    hold(notice.owner, notice.id);
    try {
      // Pi defers settlement-triggered runs separately. Publish the idle batch first,
      // then trigger once so no unstarted wakeup can outlive its admission hold.
      pi.sendMessage(notice.message, {
        triggerTurn: !idle || index === notices.length - 1,
        deliverAs: "steer",
      });
    } catch (error) {
      release(notice.owner, notice.id);
      throw error;
    }
  }
}
function overseerReviewHint(base: string, launch: Launch, result: Result): string {
  if (!needsOverseerReview(base, launch, result)) {
    return "";
  }
  const files = (result.changedFiles ?? []).join(", ");
  return `\n[Overseer review required: inspect git diff in ${launch.cwd} (${files}) and call agent_runs(action="review", id="${launch.id}", verdict="approved", summary="...") in this turn before finishing.]`;
}

function notification(base: string, launch: Launch, result: Result): Completion {
  const file = path.join(runDirectory(base, launch.id), "output.txt");
  const page = fs.existsSync(file) ? readOutputPage(file, { offset: 0, length: 32768 }) : undefined;
  const more =
    page?.nextOffset !== undefined
      ? `\n[More output: agent_runs inspect id=${launch.id} offset=${page.nextOffset}; ${page.size} bytes total.]`
      : "";
  return {
    owner: launch.owner,
    id: launch.id,
    message: {
      customType: "agent-completion",
      display: true,
      content: `Agent run ${launch.id}: ${result.status}. ${result.error ?? ""}\n${page?.text ?? ""}${more}${overseerReviewHint(base, launch, result)}\nNative journal: ${launch.sessionFile}`,
      details: {
        owner: launch.owner,
        id: launch.id,
        completed: true,
        result,
        outputFile: file,
        page,
      },
    },
  };
}

const named = (label: string, files: readonly string[] | undefined): string =>
  files === undefined || files.length === 0 ? "" : `${label}: ${files.join(", ")}`;

/** What changed, as far as the child's package version reports it. */
function changeLines(escalation: Escalation): string[] {
  const files = escalation.changedFiles.length > 0 ? escalation.changedFiles.join(", ") : "(none)";
  if (escalation.stat === undefined) {
    return [`Changed files: ${files}`, escalation.diffExcerpt];
  }
  const stat = escalation.stat.replaceAll(/^(\S+)\t(\S+)\t/gmu, "  +$1 -$2 ").trimEnd();
  return [
    `Changes since ${escalation.since === "approval" ? "your last approval" : "launch"}:`,
    stat === "" ? `  ${files}` : stat,
    named("Changed since the last clean check, look here first", escalation.unchecked),
    named("Committed in this worktree and no longer checked out", escalation.leftBehind),
    named("Approved earlier in this run, not shown", escalation.approved),
    escalation.diffExcerpt.trimEnd(),
    escalation.diffCommand === undefined ? "" : `[Diff cut. All of it: ${escalation.diffCommand}]`,
  ];
}

function escalationNotice(launch: Launch, escalation: Escalation): Completion {
  const label = launch.name === undefined ? launch.id : `${launch.id} (${launch.name})`;
  const stopHint =
    escalation.strikes >= 3
      ? '3rd strike: prefer `agent_runs` `action="stop"`, or approve (`action="review"`, `verdict="approved"`, `summary="..."`).'
      : 'Steer (`agent_runs` `action="continue"` or `action="review"`, `verdict="changes_requested"`, `summary="..."`), approve (`action="review"`, `verdict="approved"`, `summary="..."`), or `action="stop"`.';
  return {
    owner: launch.owner,
    id: `escalation:${escalation.id}`,
    message: {
      customType: "agent-escalation",
      display: true,
      content: [
        `[Overseer escalation #${escalation.strikes} - ${escalation.kind}] Run ${label} paused in ${launch.cwd}.`,
        `Reason: ${escalation.summary}`,
        ...changeLines(escalation),
        stopHint,
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
      details: {
        owner: launch.owner,
        id: launch.id,
        escalationId: escalation.id,
        escalation,
      },
    },
  };
}

function inspectRunEscalation(
  base: string,
  owner: string,
  id: string,
  awaited: Set<string>,
): { launch: Launch; escalation: Escalation } | undefined {
  const launch = launchAt(base, id, owner);
  if (launch.overseer?.enabled !== true) {
    return undefined;
  }
  const dir = runDirectory(base, id);
  const escFile = path.join(dir, "escalation.json");
  awaited.add(escFile);
  const escalation = read(escFile, escalationSchema);
  if (escalation === undefined) {
    return undefined;
  }
  const resolution = read(path.join(dir, "escalation-resolution.json"), escalationResolutionSchema);
  return resolution?.escalationId === escalation.id ? undefined : { launch, escalation };
}

function pendingEscalations(
  ctx: Pick<ExtensionContext, "sessionManager">,
  options: { base: string; owner: string; unsettledIds: readonly string[]; awaited: Set<string> },
): Completion[] {
  const { base, owner, unsettledIds, awaited } = options;
  if (unsettledIds.length === 0) {
    return [];
  }
  let seen: ReadonlySet<string> | undefined;
  const where = ctx.sessionManager.getSessionFile() === undefined ? "memory" : "file";
  const notices: Completion[] = [];
  for (const id of unsettledIds) {
    const found = inspectRunEscalation(base, owner, id, awaited);
    if (found === undefined) {
      continue;
    }
    seen ??= escalationReceipts(ctx.sessionManager, owner);
    const key = `escalation:${found.escalation.id}`;
    const state = completionDelivery(owner, key, seen.has(found.escalation.id) ? where : undefined);
    if (state.kind === "published") {
      release(owner, key);
    } else if (state.kind === "deliverable") {
      notices.push(escalationNotice(found.launch, found.escalation));
    }
  }
  return notices;
}

interface PendingJournal {
  readonly file: string;
  readonly stamp: string | undefined;
}
interface Loaded {
  readonly launch: Launch;
  readonly result: Result | undefined;
  readonly journal?: PendingJournal | undefined;
}
interface Settled {
  readonly launch: string;
  readonly result: string;
  readonly pending?: Loaded | undefined;
  readonly endedAt: number;
  readonly createdAt: number;
}
interface Completed {
  readonly id: string;
  readonly endedAt: number;
  readonly createdAt: number;
  readonly loaded?: Loaded | undefined;
}
// Validated settled runs by file stamp, so polling does not reparse unchanged history.
const settledRuns = new Map<string, Map<string, Settled>>();
function stamp(file: string): string | undefined {
  const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? undefined : journalStamp(stat);
}
function pendingJournal(file: string): PendingJournal | undefined {
  try {
    return { file, stamp: stamp(file) };
  } catch {
    // Unavailable metadata cannot validate a cached attempt or hide execution.
    return undefined;
  }
}
function unchangedPending(pending: Loaded | undefined): boolean {
  if (pending === undefined) {
    return true;
  }
  const journal = pending.journal;
  if (journal === undefined) {
    return false;
  }
  const current = pendingJournal(journal.file);
  return current !== undefined && current.stamp === journal.stamp;
}
function load(base: string, id: string, owner: string): Loaded {
  const launch = launchAt(base, id, owner);
  const result = readCanonicalResult(base, launch);
  if (accountingState(result).kind !== "pending") {
    return { launch, result };
  }
  // Only pending runs need this pre-read stamp to observe concurrent publication.
  // readResult revalidates canonical state afterward: a miss intentionally reads result.json twice.
  const journal = pendingJournal(launch.sessionFile);
  return { launch, result: readResult(base, launch), journal };
}
function cacheableResult(loaded: Loaded): boolean {
  return accountingState(loaded.result).kind !== "pending" || loaded.journal !== undefined;
}
interface Scan {
  readonly base: string;
  readonly owner: string;
  readonly known: ReadonlyMap<string, Settled>;
  readonly settled: Map<string, Settled>;
}
function completedRun({ base, owner, known, settled }: Scan, id: string): Completed | undefined {
  const directory = runDirectory(base, id);
  const launch = stamp(path.join(directory, "launch.json"));
  const result = stamp(path.join(directory, "result.json"));
  const prior = known.get(id);
  if (
    prior !== undefined &&
    prior.launch === launch &&
    prior.result === result &&
    unchangedPending(prior.pending)
  ) {
    settled.set(id, prior);
    return { id, ...prior, loaded: prior.pending };
  }
  const loaded = load(base, id, owner);
  if (loaded.result === undefined) {
    return;
  }
  const order = { endedAt: loaded.result.endedAt, createdAt: loaded.launch.createdAt };
  // Pending accounting retries on child changes, even after the completion receipt.
  // Ordinary settled history retains its launch/result-only idle probes.
  const pending = accountingState(loaded.result).kind === "pending" ? loaded : undefined;
  if (launch !== undefined && result !== undefined && cacheableResult(loaded)) {
    settled.set(id, { launch, result, pending, ...order });
  }
  return { id, ...order, loaded };
}
function completed(
  base: string,
  owner: string,
  awaited: Set<string>,
  unsettledIds: string[],
): Completed[] {
  const key = JSON.stringify([base, owner]);
  const scan = {
    base,
    owner,
    known: settledRuns.get(key) ?? new Map<string, Settled>(),
    settled: new Map<string, Settled>(),
  };
  const runs = list(base).flatMap((id) => {
    const run = completedRun(scan, id);
    if (run === undefined) {
      awaited.add(path.join(runDirectory(base, id), "result.json"));
      unsettledIds.push(id);
    } else if (run.loaded && accountingState(run.loaded.result).kind === "pending") {
      awaited.add(run.loaded.launch.sessionFile);
    }
    return run ?? [];
  });
  settledRuns.delete(key);
  settledRuns.set(key, scan.settled);
  if (settledRuns.size > 8) {
    settledRuns.delete(settledRuns.keys().next().value ?? key);
  }
  return runs.sort((a, b) => {
    if (a.endedAt !== b.endedAt) {
      return a.endedAt - b.endedAt;
    }
    return a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id.localeCompare(b.id);
  });
}
export interface Reconciliation {
  readonly notices: Completion[];
  /** Canonical files whose publication can change what this owner must deliver. */
  readonly awaited: ReadonlySet<string>;
}
export function notifications(
  ctx: Pick<ExtensionContext, "sessionManager">,
  base: string,
  owner: string,
): Reconciliation {
  const notices: Completion[] = [];
  const awaited = new Set<string>();
  const unsettledIds: string[] = [];
  const runs = completed(base, owner, awaited, unsettledIds);
  notices.push(...pendingEscalations(ctx, { base, owner, unsettledIds, awaited }));
  const receipts = runs.length === 0 ? undefined : completionReceipts(ctx.sessionManager, owner);
  const where = ctx.sessionManager.getSessionFile() === undefined ? "memory" : "file";
  for (const run of runs) {
    const state = completionDelivery(
      owner,
      run.id,
      receipts?.get(run.id) === undefined ? undefined : where,
    );
    switch (state.kind) {
      case "published":
        release(owner, run.id);
        continue;
      case "held":
        continue;
      case "deliverable":
        break;
    }
    const loaded = run.loaded ?? load(base, run.id, owner);
    if (loaded.result !== undefined) {
      notices.push(notification(base, loaded.launch, loaded.result));
    }
  }
  return { notices, awaited };
}
