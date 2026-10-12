import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_CHILD_ENV } from "../runs/shared/child-route-env.ts";
import { errorMessage } from "../shared/unknown.ts";
import { loadConfig } from "./config.ts";

export { loadConfig } from "./config.ts";

export default async function registerSubagentExtension(pi: ExtensionAPI): Promise<void> {
  if (process.env[SUBAGENT_CHILD_ENV] === "1") {
    // Explicit fanout-child owns nested delegation; globally discovered parent code remains inert.
    return;
  }
  // Children discover this entry too; keep the parent execution/history/UI graph behind the guard.
  const [{ ensureTempRoot }, { ParentSubagentRuntime }, { cleanupStaleRuntime }] =
    await Promise.all([
      import("../shared/temp-root.ts"),
      import("./parent-runtime.ts"),
      import("./runtime-reload.ts"),
    ]);
  try {
    ensureTempRoot();
  } catch (error) {
    console.error(`[pi-subagents] temp storage setup failed: ${errorMessage(error)}`);
    return;
  }
  cleanupStaleRuntime();
  new ParentSubagentRuntime(pi, loadConfig()).register();
}
