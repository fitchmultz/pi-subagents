import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionReceipts } from "./receipts.ts";
import { readOutputPage } from "../shared/output-page.ts";
import { journalStamp } from "../shared/native-journal.ts";
import type { Launch, Result } from "./contracts.ts";
import { launchAt, list, runDirectory } from "./storage.ts";
import { readCanonicalResult, readResult } from "./usage.ts";

function queuedAdmissions(): Set<string> {
  const store = globalThis as Record<string, unknown>;
  const existing = store.__pi_single_agent_admissions__;
  if (existing instanceof Set) {
    const values: Set<unknown> = existing;
    const strings = [...values].filter((value): value is string => typeof value === "string");
    if (strings.length === values.size) {
      // Keep one live queue identity across native extension reloads.
      // oxlint-disable-next-line typescript/no-unsafe-return
      return existing;
    }
  }
  const queued = new Set<string>();
  store.__pi_single_agent_admissions__ = queued;
  return queued;
}
const admissions = queuedAdmissions();
function hold(owner: string, id: string): boolean {
  const key = `${owner}/${id}`;
  if (admissions.has(key)) {
    return false;
  }
  admissions.add(key);
  return true;
}
export function release(owner: string, id: string): void {
  admissions.delete(`${owner}/${id}`);
}
export function isHeld(owner: string, id: string): boolean {
  return admissions.has(`${owner}/${id}`);
}
export function settle(owner: string, pending: boolean): void {
  if (pending) {
    return;
  }
  for (const key of admissions) {
    if (key.startsWith(`${owner}/`)) {
      admissions.delete(key);
    }
  }
}
export function published(ctx: ExtensionContext, launch: Launch): string | undefined {
  return completionReceipts(ctx.sessionManager.getSessionFile(), launch.owner).get(launch.id);
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
      content: `Agent run ${launch.id}: ${result.status}. ${result.error ?? ""}\n${page?.text ?? ""}${more}\nNative journal: ${launch.sessionFile}`,
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
interface PendingJournal {
  readonly file: string;
  readonly stamp: string | undefined;
}
interface Loaded {
  readonly launch: Launch;
  readonly result: Result | undefined;
  readonly journal?: PendingJournal;
}
interface Settled {
  readonly launch: string;
  readonly result: string;
  readonly pending?: Loaded;
  readonly endedAt: number;
  readonly createdAt: number;
}
interface Completed {
  readonly id: string;
  readonly endedAt: number;
  readonly createdAt: number;
  readonly loaded?: Loaded;
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
  if (result?.accountingPending === undefined) {
    return { launch, result };
  }
  // Only pending runs need this pre-read stamp to observe concurrent publication.
  // readResult revalidates canonical state afterward: a miss intentionally reads result.json twice.
  const journal = pendingJournal(launch.sessionFile);
  return { launch, result: readResult(base, launch), journal };
}
function cacheableResult(loaded: Loaded): boolean {
  return loaded.result?.accountingPending === undefined || loaded.journal !== undefined;
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
  const pending = loaded.result.accountingPending === undefined ? undefined : loaded;
  if (launch !== undefined && result !== undefined && cacheableResult(loaded)) {
    settled.set(id, { launch, result, pending, ...order });
  }
  return { id, ...order, loaded };
}
function completed(base: string, owner: string): Completed[] {
  const key = JSON.stringify([base, owner]);
  const scan = {
    base,
    owner,
    known: settledRuns.get(key) ?? new Map<string, Settled>(),
    settled: new Map<string, Settled>(),
  };
  const runs = list(base).flatMap((id) => completedRun(scan, id) ?? []);
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
export function notifications(ctx: ExtensionContext, base: string, owner: string): Completion[] {
  const notices: Completion[] = [];
  const runs = completed(base, owner);
  const receipts =
    runs.length === 0 ? undefined : completionReceipts(ctx.sessionManager.getSessionFile(), owner);
  for (const run of runs) {
    const key = `${owner}/${run.id}`;
    if (receipts?.get(run.id) !== undefined) {
      admissions.delete(key);
      continue;
    }
    const loaded = admissions.has(key) ? undefined : (run.loaded ?? load(base, run.id, owner));
    if (loaded?.result !== undefined) {
      notices.push(notification(base, loaded.launch, loaded.result));
    }
  }
  return notices;
}
