import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { ensureTempRoot } from "../shared/temp-root.ts";
import { errorMessage } from "../shared/unknown.ts";
import { loadConfig } from "./config.ts";
import { ParentSubagentRuntime } from "./parent-runtime.ts";
import { cleanupStaleRuntime } from "./runtime-reload.ts";

export { loadConfig } from "./config.ts";

export default function registerSubagentExtension(pi: ExtensionAPI): void {
  if (process.env[SUBAGENT_CHILD_ENV] === "1") {
    // Explicit fanout-child owns nested delegation; globally discovered parent code remains inert.
    return;
  }
  try {
    ensureTempRoot();
  } catch (error) {
    console.error(`[pi-subagents] temp storage setup failed: ${errorMessage(error)}`);
    return;
  }
  cleanupStaleRuntime();
  new ParentSubagentRuntime(pi, loadConfig()).register();
}
