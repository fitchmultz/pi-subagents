import * as path from "node:path";

type InventoryListener = (runId?: string) => void;
type ListenerRegistry = Map<string, Set<InventoryListener>>;

const REGISTRY_KEY = Symbol.for("@fitchmultz/pi-subagents/inventory-events");

function registry(): ListenerRegistry {
  const host: Record<symbol, unknown> = globalThis;
  const existing = host[REGISTRY_KEY];
  if (existing instanceof Map) {
    return existing;
  }
  const created: ListenerRegistry = new Map();
  host[REGISTRY_KEY] = created;
  return created;
}

/** Subscribes to in-process run lifecycle updates for one owner directory. */
export function subscribeInventory(base: string, listener: InventoryListener): () => void {
  const key = path.resolve(base);
  const listeners = registry();
  let bucket = listeners.get(key);
  if (bucket === undefined) {
    bucket = new Set();
    listeners.set(key, bucket);
  }
  bucket.add(listener);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) {
      listeners.delete(key);
    }
  };
}

/** Wakes in-process observers for one owner directory without waiting on OS file watches. */
export function notifyInventory(base: string, runId?: string): void {
  const bucket = registry().get(path.resolve(base));
  if (bucket === undefined) {
    return;
  }
  for (const listener of new Set(bucket)) {
    listener(runId);
  }
}
