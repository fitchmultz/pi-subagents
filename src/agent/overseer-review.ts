import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  overseerReviewSchema,
  successorSchema,
  type Launch,
  type OverseerReview,
  type Result,
} from "./contracts.ts";
import { resolveActiveEscalation } from "./overseer-sentinel.ts";
import { completionReceipts } from "./receipts.ts";
import { latest, launchAt, list, read, runDirectory, write } from "./storage.ts";
import type { RunsInput } from "./tool-schemas.ts";
import { readCanonicalResult } from "./usage.ts";

const MAX_REMINDERS = 2;

export const readReview = (base: string, runId: string): OverseerReview | undefined =>
  read(path.join(runDirectory(base, runId), "review.json"), overseerReviewSchema);

function isApprovedAfter(base: string, runId: string, endedAt: number): boolean {
  const rev = readReview(base, runId);
  return rev?.verdict === "approved" && rev.at >= endedAt;
}

export function needsOverseerReview(
  base: string,
  launch: Launch,
  result: Result | undefined,
): boolean {
  if (
    launch.overseer?.enabled !== true ||
    result?.status !== "completed" ||
    (result.changedFiles?.length ?? 0) === 0
  ) {
    return false;
  }
  if (read(path.join(runDirectory(base, launch.id), "successor.json"), successorSchema)) {
    return false;
  }
  return !isApprovedAfter(base, launch.id, result.endedAt);
}

export function recordOverseerReview(
  base: string,
  launch: Launch,
  verdict: "approved" | "changes_requested",
  summary: string,
): OverseerReview {
  const s = summary.trim();
  if (s.length === 0) {
    throw new Error("review requires a non-empty summary.");
  }
  if (verdict === "approved") {
    resolveActiveEscalation(base, launch, "approved");
  }
  const res = readCanonicalResult(base, launch);
  const review: OverseerReview = {
    runId: launch.id,
    verdict,
    summary: s,
    at: res ? Math.max(Date.now(), res.endedAt) : Date.now(),
  };
  write(path.join(runDirectory(base, launch.id), "review.json"), review);
  return review;
}

export interface UnreviewedRun {
  readonly launch: Launch;
  readonly changedFiles: string[];
}

export function unreviewedCompletedRuns(
  ctx: Pick<ExtensionContext, "sessionManager">,
  base: string,
  owner: string,
): UnreviewedRun[] {
  const ids = list(base);
  if (ids.length === 0) {
    return [];
  }
  const receipts = completionReceipts(ctx.sessionManager, owner);
  return ids.flatMap((id) => {
    if (!receipts.has(id)) {
      return [];
    }
    const launch = launchAt(base, id, owner);
    const result = readCanonicalResult(base, launch);
    return needsOverseerReview(base, launch, result)
      ? [{ launch, changedFiles: result?.changedFiles ?? [] }]
      : [];
  });
}

export function buildReviewGateDraft(
  unreviewed: readonly UnreviewedRun[],
  reminders: Map<string, number>,
):
  | { type: "custom_message"; customType: "overseer-review-gate"; content: string; display: true }
  | undefined {
  const due = unreviewed.filter(({ launch }) => (reminders.get(launch.id) ?? 0) < MAX_REMINDERS);
  if (due.length === 0) {
    return undefined;
  }
  for (const { launch } of due) {
    reminders.set(launch.id, (reminders.get(launch.id) ?? 0) + 1);
  }
  const rows = due.map(({ launch: l, changedFiles }) => {
    const tag = l.name === undefined ? l.id : `${l.id} (${l.name})`;
    return `- ${tag} in ${l.cwd}: ${changedFiles.join(", ")}`;
  });
  return {
    type: "custom_message",
    customType: "overseer-review-gate",
    display: true,
    content: [
      'Overseer review required. Inspect each diff against its contract, then call `agent_runs` `action="review"` (`verdict="approved"` or `"changes_requested"`, `summary="..."`):',
      ...rows,
    ].join("\n"),
  };
}

export function prepareOverseerReviewAction(
  base: string,
  original: Launch,
  input: RunsInput,
): {
  target: Launch;
  review: OverseerReview;
  verdict: "approved" | "changes_requested";
  /** The review approved a pause that was open on the target. */
  released: boolean;
} {
  if (input.verdict === undefined || input.summary === undefined) {
    throw new Error("review requires verdict ('approved' | 'changes_requested') and summary.");
  }
  const tip = latest(base, original);
  const settled = (id: string): boolean =>
    fs.existsSync(path.join(runDirectory(base, id), "result.json"));
  const target = !settled(tip.id) || !settled(original.id) ? tip : original;
  const paused = fs.existsSync(path.join(runDirectory(base, target.id), "escalation.json"));
  return {
    target,
    review: recordOverseerReview(base, target, input.verdict, input.summary),
    verdict: input.verdict,
    released: paused && input.verdict === "approved",
  };
}

export function registerOverseerSettleGate(
  pi: ExtensionAPI,
  state: () => { enabled: boolean; base: string; owner: string } | undefined,
): void {
  const reminders = new Map<string, number>();
  pi.on("agent_before_settle", (event, context) => {
    const active = event.outcome === "completed" ? state() : undefined;
    if (active?.enabled !== true) {
      return;
    }
    const draft = buildReviewGateDraft(
      unreviewedCompletedRuns(context, active.base, active.owner),
      reminders,
    );
    return draft === undefined ? undefined : { entries: [...event.entries, draft], continue: true };
  });
}
