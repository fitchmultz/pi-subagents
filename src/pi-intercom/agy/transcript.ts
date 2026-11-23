import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { previewText } from "../message-format.ts";
import {
  isLastMessageQuery,
  LAST_MESSAGE_PAGE_LIMIT,
  type LastMessageQuery,
  type LastMessageResult,
  type SessionInfo,
} from "../types.ts";
import { isRecord, isUnknownArray, MAX_TURN_ERROR_LENGTH } from "../validation.ts";

interface TranscriptStep {
  readonly stepIndex: number;
  readonly source: string;
  readonly type: string;
  readonly status: string;
  readonly content: string;
  readonly error?: string | undefined;
  readonly truncatedContent: boolean;
}

function strField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function parseStep(line: string): TranscriptStep | undefined {
  if (line.trim() === "") {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      !isRecord(parsed) ||
      typeof parsed.step_index !== "number" ||
      !Number.isInteger(parsed.step_index)
    ) {
      return;
    }
    const truncatedContent =
      isUnknownArray(parsed.truncated_fields) && parsed.truncated_fields.includes("content");
    return {
      stepIndex: parsed.step_index,
      source: strField(parsed, "source"),
      type: strField(parsed, "type"),
      status: strField(parsed, "status"),
      content: strField(parsed, "content"),
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      truncatedContent,
    };
  } catch {
    return;
  }
}

function readSteps(filePath: string): readonly TranscriptStep[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const steps: TranscriptStep[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const step = parseStep(line);
    if (step) {
      steps.push(step);
    }
  }
  return steps;
}

function readFullStepContent(transcriptPath: string, stepIndex: number): string | undefined {
  const fullPath = join(dirname(transcriptPath), "transcript_full.jsonl");
  if (!fs.existsSync(fullPath)) {
    return;
  }
  const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const step = parseStep(line);
    if (step && step.stepIndex === stepIndex) {
      return step.content;
    }
  }
  return;
}

function entryIdFor(stepIndex: number): string {
  return `step-${stepIndex}`;
}

function isCompletedResponse(step: TranscriptStep): boolean {
  return (
    step.source === "MODEL" &&
    step.type === "PLANNER_RESPONSE" &&
    step.status === "DONE" &&
    step.content.trim() !== ""
  );
}

function findResponseStep(
  steps: readonly TranscriptStep[],
  requestedEntryId?: string,
): TranscriptStep | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && isCompletedResponse(step)) {
      if (requestedEntryId === undefined || entryIdFor(step.stepIndex) === requestedEntryId) {
        return step;
      }
    }
  }
  return;
}

function isPlannerStep(step: TranscriptStep | undefined): step is TranscriptStep {
  return step !== undefined && step.source === "MODEL" && step.type === "PLANNER_RESPONSE";
}

function latestTurnFailure(
  steps: readonly TranscriptStep[],
  requestedEntryId?: string,
  afterStepIndex?: number,
): { readonly entryId: string; readonly error: string } | undefined {
  if (requestedEntryId !== undefined) {
    return;
  }
  const latest = steps.findLast(isPlannerStep);
  if (
    !latest ||
    (afterStepIndex !== undefined && latest.stepIndex <= afterStepIndex) ||
    latest.status !== "ERROR"
  ) {
    return;
  }
  const detail = previewText(latest.error ?? latest.content, MAX_TURN_ERROR_LENGTH);
  return {
    entryId: entryIdFor(latest.stepIndex),
    error: detail ?? "assistant turn failed",
  };
}

function emptyLastResult(
  session: SessionInfo,
  entryId: string | undefined,
  latestTurnError?: { readonly entryId: string; readonly error: string },
): LastMessageResult {
  if (entryId !== undefined) {
    return { error: "Requested completed assistant response is not in the agy transcript." };
  }
  return {
    session,
    entryId: null,
    text: "",
    offset: 0,
    totalLength: 0,
    ...(latestTurnError ? { latestTurnError } : {}),
  };
}

function resolveResponseText(transcriptPath: string, response: TranscriptStep): string {
  if (!response.truncatedContent) {
    return response.content;
  }
  return readFullStepContent(transcriptPath, response.stepIndex) ?? response.content;
}

function sliceLastPage(options: {
  readonly session: SessionInfo;
  readonly entryId: string;
  readonly fullText: string;
  readonly offset: number;
  readonly limit: number;
  readonly latestTurnError?: { readonly entryId: string; readonly error: string } | undefined;
}): LastMessageResult {
  const { session, entryId, fullText, offset, limit, latestTurnError } = options;
  if (offset > fullText.length) {
    return { error: "Last response offset exceeds its length." };
  }
  const end = Math.min(fullText.length, offset + limit);
  return {
    session,
    entryId,
    text: fullText.slice(offset, end),
    offset,
    totalLength: fullText.length,
    ...(end < fullText.length ? { nextOffset: end } : {}),
    ...(latestTurnError ? { latestTurnError } : {}),
  };
}

/** Reads finalized Antigravity transcript entries without invoking the model. */
export function readAgyLastMessage(
  transcriptPath: string | undefined,
  session: SessionInfo,
  query: LastMessageQuery,
): LastMessageResult {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? LAST_MESSAGE_PAGE_LIMIT;
  if (!isLastMessageQuery({ offset, limit })) {
    return {
      error: "Invalid last response page: offset must be non-negative and limit must be 1–16384.",
    };
  }
  if (transcriptPath === undefined || transcriptPath === "") {
    return emptyLastResult(session, query.entryId);
  }
  const steps = readSteps(transcriptPath);
  const response = findResponseStep(steps, query.entryId);
  const latestTurnError = latestTurnFailure(steps, query.entryId, response?.stepIndex);
  if (!response) {
    return emptyLastResult(session, query.entryId, latestTurnError);
  }
  return sliceLastPage({
    session,
    entryId: entryIdFor(response.stepIndex),
    fullText: resolveResponseText(transcriptPath, response),
    offset,
    limit,
    latestTurnError,
  });
}
