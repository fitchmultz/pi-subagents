import { createHash } from "node:crypto";
import { isRecord, hasText } from "./async-value.ts";

interface CompletionDataLike {
  completionId?: unknown;
  id?: unknown;
  agent?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  taskIndex?: unknown;
  totalTasks?: unknown;
  success?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  return Number.isFinite(value) ? value : undefined;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (!isRecord(value)) {
    throw new Error("Completion identity must contain JSON-compatible values.");
  }
  const record = value;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function payloadDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function buildCompletionKey(data: Readonly<CompletionDataLike>, fallback: string): string {
  const completionId = asNonEmptyString(data.completionId);
  if (hasText(completionId)) {
    return `completion:${completionId}`;
  }
  const id = asNonEmptyString(data.id);
  if (hasText(id)) {
    return `id:${id}:${payloadDigest(data)}`;
  }
  const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
  const agent = asNonEmptyString(data.agent) ?? "unknown";
  const timestamp = asFiniteNumber(data.timestamp);
  const taskIndex = asFiniteNumber(data.taskIndex);
  const totalTasks = asFiniteNumber(data.totalTasks);
  const success = data.success === true ? "1" : "?";
  const successIdentity = data.success === false ? "0" : success;
  return [
    "meta",
    sessionId,
    agent,
    timestamp !== undefined ? String(timestamp) : "no-ts",
    taskIndex !== undefined ? String(taskIndex) : "-",
    totalTasks !== undefined ? String(totalTasks) : "-",
    successIdentity,
    fallback,
  ].join(":");
}

/** Mutable identity store owned by the completion-admission lifecycle. */
export interface CompletionSeenStore {
  readonly entries: () => IterableIterator<[string, number]>;
  readonly has: (key: string) => boolean;
  readonly set: (key: string, value: number) => unknown;
  readonly delete: (key: string) => boolean;
}

function pruneSeenMap(seen: CompletionSeenStore, now: number, ttlMs: number): void {
  for (const [key, ts] of seen.entries()) {
    if (now - ts > ttlMs) {
      seen.delete(key);
    }
  }
}

export function markSeenWithTtl(
  seen: CompletionSeenStore,
  key: string,
  now: number,
  ttlMs: number,
): boolean {
  pruneSeenMap(seen, now, ttlMs);
  if (seen.has(key)) {
    return true;
  }
  seen.set(key, now);
  return false;
}

function isSeenMap(value: unknown): value is Map<string, number> {
  if (!(value instanceof Map)) {
    return false;
  }
  const entries: Map<unknown, unknown> = value;
  return [...entries].every(
    ([key, timestamp]) => typeof key === "string" && typeof timestamp === "number",
  );
}

export function getGlobalSeenMap(storeKey: string): Map<string, number> {
  const globalStore = globalThis as Record<string, unknown>;
  const existing = globalStore[storeKey];
  if (isSeenMap(existing)) {
    return existing;
  }
  const map = new Map<string, number>();
  globalStore[storeKey] = map;
  return map;
}
