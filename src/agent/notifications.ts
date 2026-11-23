import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionReceipts, escalationReceipts, noteReceipts } from "./receipts.ts";
import { readOutputPage } from "../shared/output-page.ts";
import { journalStamp } from "../shared/native-journal.ts";
import {
  escalationResolutionSchema,
  escalationSchema,
  type Escalation,
  type Launch,
  type OverseerNote,
  type Result,
} from "./contracts.ts";
import { activeOverseer } from "./overseer.ts";
import {
  checkpointEvidenceLines,
  checkpointKindLabel,
  formatFindingsLines,
} from "./overseer-evidence.ts";
import { judgeUnavailable } from "./overseer-skeptic.ts";
import { readOverseerNotes } from "./overseer-sentinel.ts";
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
  /** When false, append the notice to context without waking an idle parent. */
  readonly wake?: boolean | undefined;
  readonly message: Parameters<ExtensionAPI["sendMessage"]>[0];
}

export function deliver(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  notices: readonly Completion[],
): void {
  const idle = ctx.isIdle();
  const lastWake = notices.findLastIndex((notice) => notice.wake !== false);
  for (const [index, notice] of notices.entries()) {
    hold(notice.owner, notice.id);
    try {
      const shouldWake = notice.wake !== false && (!idle || index === lastWake);
      pi.sendMessage(notice.message, {
        triggerTurn: shouldWake,
        deliverAs: notice.wake === false ? "nextTurn" : "steer",
      });
    } catch (error) {
      release(notice.owner, notice.id);
      throw error;
    }
  }
}

function judgeUnavailableHint(base: string, launch: Launch): string {
  const live = activeOverseer(base, launch);
  const unavailable =
    live.enabled && live.judge !== "off" ? judgeUnavailable(base, launch.id) : undefined;
  return unavailable === undefined
    ? ""
    : `\n[Overseer skeptic unavailable: no model evaluated the last changes (${unavailable.summary}). Structural checkpoints still ran.]`;
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
      content: `Agent run ${launch.id}: ${result.status}. ${result.error ?? ""}\n${page?.text ?? ""}${more}${judgeUnavailableHint(base, launch)}\nNative journal: ${launch.sessionFile}`,
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

function changeLines(escalation: Escalation): string[] {
  const files = escalation.changedFiles.length > 0 ? escalation.changedFiles.join(", ") : "(none)";
  const header = `Changes since ${escalation.since === "checkpoint" ? "last checkpoint" : "launch"}:`;
  const stat =
    escalation.stat === undefined
      ? `  ${files}`
      : escalation.stat.replaceAll(/^(\S+)\t(\S+)\t/gmu, "  +$1 -$2 ");
  return [
    header,
    stat,
    escalation.diffExcerpt.trimEnd(),
    escalation.diffCommand === undefined ? "" : `[Diff cut. Full diff: ${escalation.diffCommand}]`,
  ];
}

function escalationNotice(launch: Launch, escalation: Escalation): Completion {
  const label = launch.name === undefined ? launch.id : `${launch.id} (${launch.name})`;
  const steers = escalation.steers ?? 0;
  return {
    owner: launch.owner,
    id: `escalation:${escalation.id}`,
    message: {
      customType: "agent-escalation",
      display: true,
      content: [
        `[Overseer checkpoint #${escalation.pauseNumber} - ${checkpointKindLabel(escalation)}] Run ${label} paused in ${launch.cwd}.`,
        ...checkpointEvidenceLines(escalation),
        ...changeLines(escalation),
        steers === 0 ? "" : `Earlier pauses answered with steering: ${steers}.`,
        'Answer: `agent_runs` `action="continue"` (omit `prompt` to approve and continue, or pass `prompt` to steer with corrections) or `action="stop"`.',
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

function noteNotice(launch: Launch, note: OverseerNote): Completion {
  const label = launch.name === undefined ? launch.id : `${launch.id} (${launch.name})`;
  return {
    owner: launch.owner,
    id: `note:${note.id}`,
    wake: false,
    message: {
      customType: "overseer-note",
      display: true,
      content: [
        `[Overseer heads-up (non-blocking) - ${note.model}] Run ${label} is still running:`,
        ...formatFindingsLines(note.findings),
      ].join("\n"),
      details: {
        owner: launch.owner,
        id: launch.id,
        noteId: note.id,
        note,
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
  const live = activeOverseer(base, launch);
  if (!live.enabled) {
    return undefined;
  }
  const dir = runDirectory(base, id);
  const escFile = path.join(dir, "escalation.json");
  awaited.add(escFile);
  const escalation = read(escFile, escalationSchema);
  if (escalation === undefined) {
    return undefined;
  }
  if (escalation.kind === "skeptic" && live.judge === "off") {
    return undefined;
  }
  const resolution = read(path.join(dir, "escalation-resolution.json"), escalationResolutionSchema);
  return resolution?.escalationId === escalation.id ? undefined : { launch, escalation };
}

function collectEscalationNotice(input: {
  readonly found: { readonly launch: Launch; readonly escalation: Escalation };
  readonly owner: string;
  readonly where: "file" | "memory";
  readonly seen: ReadonlySet<string>;
}): Completion | undefined {
  const { found, owner, where, seen } = input;
  const key = `escalation:${found.escalation.id}`;
  const state = completionDelivery(owner, key, seen.has(found.escalation.id) ? where : undefined);
  if (state.kind === "published") {
    release(owner, key);
    return;
  }
  return state.kind === "deliverable"
    ? escalationNotice(found.launch, found.escalation)
    : undefined;
}

function collectNoteNotices(input: {
  readonly launch: Launch;
  readonly notes: readonly OverseerNote[];
  readonly where: "file" | "memory";
  readonly seen: ReadonlySet<string>;
}): Completion[] {
  const { launch, notes, where, seen } = input;
  const notices: Completion[] = [];
  for (const note of notes) {
    const key = `note:${note.id}`;
    const state = completionDelivery(launch.owner, key, seen.has(note.id) ? where : undefined);
    if (state.kind === "published") {
      release(launch.owner, key);
    } else if (state.kind === "deliverable") {
      notices.push(noteNotice(launch, note));
    }
  }
  return notices;
}

function pendingNotesForRun(input: {
  readonly base: string;
  readonly owner: string;
  readonly id: string;
  readonly launch?: Launch | undefined;
  readonly where: "file" | "memory";
  readonly getSeen: () => ReadonlySet<string>;
  readonly awaited: Set<string>;
}): Completion[] {
  const { base, owner, id, where, getSeen, awaited } = input;
  awaited.add(path.join(runDirectory(base, id), "overseer-notes.json"));
  const notes = readOverseerNotes(base, id);
  if (notes.length === 0) {
    return [];
  }
  const launch = input.launch ?? launchAt(base, id, owner);
  return collectNoteNotices({ launch, notes, where, seen: getSeen() });
}

function pendingOverseerNotices(
  ctx: Pick<ExtensionContext, "sessionManager">,
  options: { base: string; owner: string; unsettledIds: readonly string[]; awaited: Set<string> },
): Completion[] {
  const { base, owner, unsettledIds, awaited } = options;
  if (unsettledIds.length === 0) {
    return [];
  }
  let seenEsc: ReadonlySet<string> | undefined;
  let seenNotes: ReadonlySet<string> | undefined;
  const getSeenNotes = (): ReadonlySet<string> => {
    seenNotes ??= noteReceipts(ctx.sessionManager, owner);
    return seenNotes;
  };
  const where = ctx.sessionManager.getSessionFile() === undefined ? "memory" : "file";
  const notices: Completion[] = [];
  for (const id of unsettledIds) {
    const found = inspectRunEscalation(base, owner, id, awaited);
    if (found !== undefined) {
      seenEsc ??= escalationReceipts(ctx.sessionManager, owner);
      const notice = collectEscalationNotice({ found, owner, where, seen: seenEsc });
      if (notice !== undefined) {
        notices.push(notice);
      }
    }
    notices.push(
      ...pendingNotesForRun({
        base,
        owner,
        id,
        launch: found?.launch,
        where,
        getSeen: getSeenNotes,
        awaited,
      }),
    );
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
const settledRuns = new Map<string, Map<string, Settled>>();
function stamp(file: string): string | undefined {
  const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? undefined : journalStamp(stat);
}
function pendingJournal(file: string): PendingJournal | undefined {
  try {
    return { file, stamp: stamp(file) };
  } catch {
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
  notices.push(...pendingOverseerNotices(ctx, { base, owner, unsettledIds, awaited }));
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
