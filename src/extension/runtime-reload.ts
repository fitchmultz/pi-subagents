import { isUnknownArray } from "../shared/unknown.ts";

export const RUNTIME_CLEANUP_KEY = "__piSubagentRuntimeCleanup";
export const EVENT_UNSUBSCRIBES_KEY = "__piSubagentEventUnsubscribes";
const VISIBLE_NOTICES_KEY = "__piSubagentVisibleControlNotices";

export function sharedRuntimeValue(key: string): unknown {
  return Reflect.get(globalThis, key);
}

export function setSharedRuntimeValue(key: string, value: unknown): void {
  if (!Reflect.set(globalThis, key, value)) {
    throw new Error(`Could not register subagent runtime value '${key}'.`);
  }
}

export function removeSharedRuntimeValue(key: string, current: unknown): void {
  if (sharedRuntimeValue(key) === current) {
    Reflect.deleteProperty(globalThis, key);
  }
}

function isCallback(value: unknown): value is () => unknown {
  return typeof value === "function";
}

function cleanupCallback(value: unknown): void {
  if (!isCallback(value)) {
    return;
  }
  try {
    const pending = value();
    if (pending instanceof Promise) {
      pending.catch((error: unknown) => {
        console.error("Could not clean stale subagent runtime:", error);
      });
    }
  } catch {
    // Stale cleanup must not prevent the replacement extension from registering.
  }
}

export function cleanupStaleRuntime(key = RUNTIME_CLEANUP_KEY): void {
  cleanupCallback(sharedRuntimeValue(key));
}

export function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Extension context no longer active");
}

export function cleanupStaleSubscriptions(): void {
  const previous = sharedRuntimeValue(EVENT_UNSUBSCRIBES_KEY);
  if (isUnknownArray(previous)) {
    for (const unsubscribe of previous) {
      cleanupCallback(unsubscribe);
    }
  }
}

function isStringSet(value: unknown): value is Set<string> {
  return value instanceof Set && [...value].every((entry: unknown) => typeof entry === "string");
}

export function visibleControlNotices(): Set<string> {
  const previous = sharedRuntimeValue(VISIBLE_NOTICES_KEY);
  if (isStringSet(previous)) {
    return previous;
  }
  const notices = new Set<string>();
  setSharedRuntimeValue(VISIBLE_NOTICES_KEY, notices);
  return notices;
}
