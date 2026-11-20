import { randomUUID } from "node:crypto";
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
import { activeOverseer } from "./overseer.ts";
import { assertContractActionAllowed, validateReviewContract } from "./overseer-contract.ts";
import { resolveActiveEscalation } from "./overseer-pause.ts";
import { inspectActorClaim, possiblyLive } from "./process.ts";
import { notifyInventory } from "./inventory-events.ts";
import { completionReceipts } from "./receipts.ts";
import { readRunState } from "./run-state.ts";
import { enqueue, latest, launchAt, list, read, runDirectory, write } from "./storage.ts";
import type { RunsInput } from "./tool-schemas.ts";
import { readCanonicalResult } from "./usage.ts";

const MAX_REMINDERS = 2;

export const readReview = (base: string, runId: string): OverseerReview | undefined =>
  read(path.join(runDirectory(base, runId), "review.json"), overseerReviewSchema);

function isApprovedAfter(base: string, runId: string, endedAt: number): boolean {
  const rev = readReview(base, runId);
  return rev?.verdict === "approved" && rev.at >= endedAt;
}

export function isReviewableResult(
  launch: Launch,
  result: Result | undefined,
  base?: string,
): result is Result & { status: "completed"; changedFiles: string[] } {
  const enabled =
    base === undefined ? launch.overseer?.enabled === true : activeOverseer(base, launch).enabled;
  return enabled && result?.status === "completed" && (result.changedFiles?.length ?? 0) > 0;
}

export function needsOverseerReview(
  base: string,
  launch: Launch,
  result: Result | undefined,
): boolean {
  if (!isReviewableResult(launch, result, base)) {
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
  const at = Date.now();
  const res = readCanonicalResult(base, launch);
  const review: OverseerReview = {
    runId: launch.id,
    verdict,
    summary: s,
    at: res ? Math.max(at, res.endedAt) : at,
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

export function reviewTarget(base: string, original: Launch): Launch {
  const tip = latest(base, original);
  const settled = (id: string): boolean =>
    fs.existsSync(path.join(runDirectory(base, id), "result.json"));
  return !settled(tip.id) || !settled(original.id) ? tip : original;
}

export function assertReviewNoteActionAllowed(input: RunsInput): void {
  if (input.note === undefined) {
    return;
  }
  if (input.action === "review" && input.verdict === "approved") {
    if (input.note.trim().length === 0) {
      throw new Error("note must be non-empty when provided.");
    }
    return;
  }
  throw new Error(
    'note is only supported with action="review" and verdict="approved" (for verdict="changes_requested", put the instructions in summary).',
  );
}

/** Validates action-scoped optional fields (`contract`, `note`) before dispatching `agent_runs`. */
export function assertRunActionOptionsAllowed(input: RunsInput): void {
  assertContractActionAllowed(input);
  assertReviewNoteActionAllowed(input);
}

export function assertReviewNoteTargetLive(base: string, original: Launch, input: RunsInput): void {
  if (input.note === undefined) {
    return;
  }
  const target = reviewTarget(base, original);
  const state = readRunState(base, target);
  if (state.kind === "settled") {
    throw new Error(
      `Cannot send a steering note on review approval: run ${target.id} is ${state.result.status}. Omit note to record approval, or use action="continue" to resume the saved conversation.`,
    );
  }
  if (state.kind === "saved-unadmitted") {
    throw new Error(
      `Cannot send a steering note on review approval: run ${target.id} is awaiting native admission.`,
    );
  }
  if (!possiblyLive(inspectActorClaim(base, target))) {
    throw new Error(
      `Cannot send a steering note on review approval: run ${target.id} is interrupted (not running). Omit note to record approval, or use action="continue" to resume the saved conversation.`,
    );
  }
}

/** Validates contract amendment and live-target requirements before recording a review. */
export function validateReviewInput(base: string, original: Launch, input: RunsInput): void {
  validateReviewContract(base, original, input);
  assertReviewNoteTargetLive(base, original, input);
}

function resolveReviewNote(
  base: string,
  target: Launch,
  note: string | undefined,
): { readonly id: string; readonly prompt: string } | undefined {
  const trimmed = note?.trim();
  if (trimmed === undefined) {
    return undefined;
  }
  if (fs.existsSync(path.join(runDirectory(base, target.id), "result.json"))) {
    throw new Error(
      `Cannot send a steering note on review approval: run ${target.id} has already settled. Omit note to record approval, or use action="continue" to resume the saved conversation.`,
    );
  }
  return { id: randomUUID(), prompt: trimmed };
}

export function prepareOverseerReviewAction(
  base: string,
  original: Launch,
  input: RunsInput,
): {
  target: Launch;
  review: OverseerReview;
  /** The review approved a pause that was open on the target. */
  released: boolean;
  /** Steer command ID queued when `note` was provided with `verdict="approved"`. */
  command?: string | undefined;
} {
  if (input.verdict === undefined || input.summary === undefined) {
    throw new Error("review requires verdict ('approved' | 'changes_requested') and summary.");
  }
  assertReviewNoteActionAllowed({ ...input, action: "review" });
  const target = reviewTarget(base, original);
  const steer = resolveReviewNote(base, target, input.note);
  const review = recordOverseerReview(base, target, input.verdict, input.summary);
  const released =
    review.verdict === "approved" &&
    resolveActiveEscalation(base, target, "approved", steer) !== undefined;
  if (steer !== undefined) {
    enqueue(base, target, { action: "steer", prompt: steer.prompt, id: steer.id });
  }
  if (released) {
    notifyInventory(base, target.id);
  }
  return {
    target,
    review,
    released,
    ...(steer !== undefined ? { command: steer.id } : {}),
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
