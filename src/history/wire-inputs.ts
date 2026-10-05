import * as Type from "typebox";
import { Check } from "typebox/value";
import {
  HistoryIndexError,
  type Request,
  type HistoryOwner,
  type HistoryRunOptions,
  type HistoryPageInput,
  type HistorySearchInput,
  type HistoryEntryInput,
  type ReadonlyForegroundResumeRun,
} from "./types.ts";
import { isUnknownArray } from "../shared/unknown.ts";
import { object } from "./values.ts";
import { parseOwnedRun } from "./wire-models.ts";

const optString = Type.Optional(Type.String());
const optNumber = Type.Optional(Type.Number());
const runOptions = Type.Object({
  offset: optNumber,
  limit: optNumber,
  cursor: optString,
  sort: Type.Optional(Type.Enum(["attention", "newest", "oldest"])),
  agent: optString,
  state: Type.Optional(Type.Enum(["live", "completed", "paused", "blocked", "failed", "unknown"])),
  text: optString,
  latestTasksOnly: Type.Optional(Type.Boolean()),
});
const page = Type.Object({
  runId: Type.String(),
  index: Type.Number(),
  limit: optNumber,
  before: optNumber,
  after: optNumber,
  cursor: optString,
  terminalEntryId: optString,
  endedAt: optNumber,
  leaf: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  messageIds: Type.Optional(Type.Array(Type.String())),
  readThrough: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const search = Type.Object({
  query: Type.String(),
  runId: optString,
  index: optNumber,
  limit: optNumber,
  cursor: optString,
  sort: Type.Optional(Type.Enum(["relevance", "newest"])),
  agent: optString,
});
const entry = Type.Object({
  runId: Type.String(),
  index: Type.Number(),
  entryId: optString,
  ref: Type.Optional(
    Type.Object({
      sourceId: Type.String(),
      generation: Type.Number(),
      start: Type.Number(),
      end: Type.Number(),
      digest: Type.String(),
    }),
  ),
  toolCallId: optString,
  kind: Type.Optional(Type.Enum(["call", "result"])),
  terminalEntryId: optString,
  endedAt: optNumber,
});
function invalid(): never {
  throw new HistoryIndexError("INVALID", "Invalid history request payload.");
}
export function parseRequest(value: unknown): Request {
  const request = object(value);
  if (
    typeof request.id !== "number" ||
    !Number.isSafeInteger(request.id) ||
    request.id < 1 ||
    typeof request.method !== "string"
  ) {
    invalid();
  }
  return { id: request.id, method: request.method, input: request.input };
}
export function parseRunOptions(value: unknown): HistoryRunOptions {
  if (!Check(runOptions, value)) {
    invalid();
  }
  return value;
}
export function parsePageInput(value: unknown): HistoryPageInput {
  if (!Check(page, value)) {
    invalid();
  }
  return value;
}
export function parseSearchInput(value: unknown): HistorySearchInput {
  if (!Check(search, value)) {
    invalid();
  }
  return value;
}
export function parseEntryInput(value: unknown): HistoryEntryInput {
  if (!Check(entry, value)) {
    invalid();
  }
  return value;
}
export function parseRefresh(value: unknown): string | undefined {
  const input = object(value);
  if (input.runId !== undefined && typeof input.runId !== "string") {
    invalid();
  }
  return input.runId;
}
export function parseOwner(
  value: unknown,
  parseForeground: (value: unknown) => ReadonlyForegroundResumeRun,
): HistoryOwner {
  const input = object(value);
  if (
    typeof input.ownerSessionId !== "string" ||
    input.ownerSessionId.length === 0 ||
    !isUnknownArray(input.runs) ||
    (input.ownerSessionFile !== undefined && typeof input.ownerSessionFile !== "string")
  ) {
    throw new HistoryIndexError("OWNERSHIP", "Invalid ownership snapshot.");
  }
  const runs = input.runs.map(parseOwnedRun);
  if (runs.some((run) => run.ownerSessionId !== input.ownerSessionId)) {
    throw new HistoryIndexError("OWNERSHIP", "Invalid ownership snapshot.");
  }
  const foreground = input.foregroundRuns;
  if (foreground !== undefined && !isUnknownArray(foreground)) {
    invalid();
  }
  return {
    ownerSessionId: input.ownerSessionId,
    ownerSessionFile: input.ownerSessionFile,
    runs,
    foregroundRuns: foreground?.map(parseForeground),
  };
}
