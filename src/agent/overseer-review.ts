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

const MAX_GATE_REMINDERS_PER_RUN = 2;

export function readReview(base: string, runId: string): OverseerReview | undefined {
  return read(path.join(runDirectory(base, runId), "review.json"), overseerReviewSchema);
}

function hasApprovedCompletionReview(base: string, runId: string, endedAt: number): boolean {
  const review = readReview(base, runId);
  return review !== undefined && review.verdict === "approved" && review.at >= endedAt;
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
  const dir = runDirectory(base, launch.id);
  if (read(path.join(dir, "successor.json"), successorSchema) !== undefined) {
    return false;
  }
  return !hasApprovedCompletionReview(base, launch.id, result.endedAt);
}

export function recordOverseerReview(
  base: string,
  launch: Launch,
  verdict: "approved" | "changes_requested",
  summary: string,
): OverseerReview {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    throw new Error("review requires a non-empty summary.");
  }
  if (verdict === "approved") {
    resolveActiveEscalation(base, launch, "approved");
  }
  const settledResult = readCanonicalResult(base, launch);
  const review: OverseerReview = {
    runId: launch.id,
    verdict,
    summary: trimmed,
    at: settledResult !== undefined ? Math.max(Date.now(), settledResult.endedAt) : Date.now(),
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
  const pending: UnreviewedRun[] = [];
  for (const id of ids) {
    if (!receipts.has(id)) {
      continue;
    }
    const launch = launchAt(base, id, owner);
    const result = readCanonicalResult(base, launch);
    if (needsOverseerReview(base, launch, result)) {
      pending.push({ launch, changedFiles: result?.changedFiles ?? [] });
    }
  }
  return pending;
}

export function buildReviewGateDraft(
  unreviewed: readonly UnreviewedRun[],
  reminders: Map<string, number>,
):
  | { type: "custom_message"; customType: "overseer-review-gate"; content: string; display: true }
  | undefined {
  const actionable = unreviewed.filter(
    ({ launch }) => (reminders.get(launch.id) ?? 0) < MAX_GATE_REMINDERS_PER_RUN,
  );
  if (actionable.length === 0) {
    return undefined;
  }
  for (const { launch } of actionable) {
    reminders.set(launch.id, (reminders.get(launch.id) ?? 0) + 1);
  }
  const items = actionable.map(({ launch, changedFiles }) => {
    const label = launch.name === undefined ? launch.id : `${launch.id} (${launch.name})`;
    return `- ${label} in ${launch.cwd}: ${changedFiles.join(", ")}`;
  });
  return {
    type: "custom_message",
    customType: "overseer-review-gate",
    display: true,
    content: [
      'Overseer review required before finishing. Inspect the actual git diff against each child\'s contract, then call `agent_runs` with `action="review"`, `verdict="approved"` (citing diff/verification evidence in `summary`) or `verdict="changes_requested"` (with corrective instructions in `summary`):',
      ...items,
    ].join("\n"),
  };
}

export function prepareOverseerReviewAction(
  base: string,
  original: Launch,
  input: RunsInput,
): { target: Launch; review: OverseerReview; verdict: "approved" | "changes_requested" } {
  if (input.verdict === undefined || input.summary === undefined) {
    throw new Error("review requires verdict ('approved' | 'changes_requested') and summary.");
  }
  const tip = latest(base, original);
  const tipSettled = fs.existsSync(path.join(runDirectory(base, tip.id), "result.json"));
  const originalSettled = fs.existsSync(path.join(runDirectory(base, original.id), "result.json"));
  // If the conversation continued to an active/paused tip, review applies to that tip rather than
  // stranding a live escalation behind a settled predecessor ID.
  const target = !tipSettled || !originalSettled ? tip : original;
  const review = recordOverseerReview(base, target, input.verdict, input.summary);
  return { target, review, verdict: input.verdict };
}

export function registerOverseerSettleGate(
  pi: ExtensionAPI,
  state: () => { enabled: boolean; base: string; owner: string } | undefined,
): void {
  const reminders = new Map<string, number>();
  pi.on("agent_before_settle", (event, context) => {
    if (event.outcome !== "completed") {
      return;
    }
    const active = state();
    if (active === undefined || !active.enabled) {
      return;
    }
    const draft = buildReviewGateDraft(
      unreviewedCompletedRuns(context, active.base, active.owner),
      reminders,
    );
    return draft === undefined ? undefined : { entries: [...event.entries, draft], continue: true };
  });
}
