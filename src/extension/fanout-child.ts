import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { CHILD_CLEANUP_KEY, FanoutChildRuntime } from "./child-runtime.ts";
import { sharedRuntimeValue, setSharedRuntimeValue } from "./runtime-reload.ts";

const REGISTERED_APIS_KEY = "__piSubagentFanoutChildRegisteredApis";

function registeredApis(): WeakSet<object> {
  const value = sharedRuntimeValue(REGISTERED_APIS_KEY);
  if (value instanceof WeakSet) {
    return value;
  }
  const apis = new WeakSet<object>();
  setSharedRuntimeValue(REGISTERED_APIS_KEY, apis);
  return apis;
}

function cleanupPreviousInbox(): void {
  const previous = sharedRuntimeValue(CHILD_CLEANUP_KEY);
  if (typeof previous !== "function") {
    return;
  }
  try {
    const pending: unknown = Reflect.apply(previous, undefined, []);
    if (pending instanceof Promise) {
      pending.catch((error: unknown) => {
        console.error("Could not close stale child runtime:", error);
      });
    }
  } catch {
    // A stale runtime must not prevent the replacement extension from registering.
  }
}

export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI): void {
  if (process.env[SUBAGENT_CHILD_ENV] !== "1" || process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1") {
    return;
  }
  const apis = registeredApis();
  if (apis.has(pi)) {
    return;
  }
  apis.add(pi);
  cleanupPreviousInbox();
  new FanoutChildRuntime(pi).register();
}
