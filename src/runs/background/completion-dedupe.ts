import { createHash } from "node:crypto";
import { isRecord, hasText } from "./async-value.ts";

interface CompletionDataLike {
  completionId?: string;
  id: string;
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

export function buildCompletionKey(data: Readonly<CompletionDataLike>): string {
  if (hasText(data.completionId)) {
    return `completion:${data.completionId.trim()}`;
  }
  return `id:${data.id.trim()}:${payloadDigest(data)}`;
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
