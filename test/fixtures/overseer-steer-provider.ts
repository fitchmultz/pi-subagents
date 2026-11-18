import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

function hasMessage(context: TranscriptContext, needle: string): boolean {
  return context.messages.some((message) => JSON.stringify(message.content).includes(needle));
}

export default function fixture(pi: ExtensionAPI): void {
  const cwd = process.env.OVERSEER_TEST_REPO;
  const sibling = process.env.OVERSEER_TEST_SIBLING;
  if (cwd === undefined || sibling === undefined) {
    throw new Error("OVERSEER_TEST_REPO and OVERSEER_TEST_SIBLING required");
  }
  const toolGate = process.env.OVERSEER_TEST_TOOL_GATE;
  if (toolGate !== undefined) {
    pi.on("tool_result", async (event, ctx) => {
      if (event.toolName !== "bash") {
        return;
      }
      fs.writeFileSync(`${toolGate}.ready`, "");
      while (!fs.existsSync(toolGate)) {
        await delay(20, undefined, { signal: ctx.signal });
      }
    });
  }
  const provider = fauxProvider({
    provider: "overseer-fixture",
    models: [{ id: "native-overseer", reasoning: false }],
  });
  provider.setResponses([
    async () => {
      fs.writeFileSync(path.join(cwd, "README.md"), "out-of-scope drift\n");
      // Another session commits in a different worktree of the same repository.
      fs.writeFileSync(path.join(sibling, "SIBLING.md"), "other session\n");
      execFileSync("git", ["add", "SIBLING.md"], { cwd: sibling, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "other session"], { cwd: sibling, stdio: "ignore" });
      return toolGate === undefined
        ? fauxAssistantMessage("DRIFTED")
        : fauxAssistantMessage([fauxToolCall("bash", { command: "printf checkpoint" })], {
            stopReason: "toolUse",
          });
    },
    async (context) => {
      if (hasMessage(context, "REVERT_README")) {
        fs.writeFileSync(path.join(cwd, "README.md"), "committed\n");
        return fauxAssistantMessage("REVERTED");
      }
      return fauxAssistantMessage("UNSTEERED");
    },
  ]);
  pi.registerProvider(provider.provider);
}
