import { createHash } from "node:crypto";
import { stripTerminalSequences } from "../shared/native-tui.ts";
import { HistoryIndexError } from "./types.ts";

export const hash = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");
export const exactTextDigest = (text: string): string => hash(stripTerminalSequences(text).trim());
export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
export function safeText(value: unknown, limit = 1024): string {
  if (typeof value !== "string") {
    return "";
  }
  const controls =
    // Bounded UI/SQLite previews deliberately remove terminal escapes and C0/C1 controls.
    // oxlint-disable-next-line no-control-regex
    /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
  return value.replace(controls, "").slice(0, limit);
}
export function integer(
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 0 ||
    result > maximum
  ) {
    throw new HistoryIndexError("INVALID", "Expected a bounded non-negative integer.");
  }
  return result;
}
export function pageLimit(value: unknown, fallback = 100): number {
  const limit = integer(value, fallback, 100);
  if (limit === 0) {
    throw new HistoryIndexError("INVALID", "Page limit must be from 1 to 100.");
  }
  return limit;
}
