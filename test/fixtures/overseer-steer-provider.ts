import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";

function hasMessage(context: TranscriptContext, needle: string): boolean {
  return context.messages.some((message) => JSON.stringify(message.content).includes(needle));
}

export default function fixture(pi: ExtensionAPI): void {
  const cwd = process.env.OVERSEER_TEST_REPO;
  const sibling = process.env.OVERSEER_TEST_SIBLING;
  if (cwd === undefined || sibling === undefined) {
    throw new Error("OVERSEER_TEST_REPO and OVERSEER_TEST_SIBLING required");
  }
  const provider = fauxProvider({
    provider: "overseer-fixture",
    models: [{ id: "native-overseer", reasoning: false }],
  });
  provider.setResponses([
    async () => {
      // Write out-of-scope drift without a mutating tool so agent_before_settle catches it.
      fs.writeFileSync(path.join(cwd, "README.md"), "out-of-scope drift\n");
      // Another session commits in a different worktree of the same repository.
      fs.writeFileSync(path.join(sibling, "SIBLING.md"), "other session\n");
      execFileSync("git", ["add", "SIBLING.md"], { cwd: sibling, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "other session"], { cwd: sibling, stdio: "ignore" });
      return fauxAssistantMessage("DRIFTED");
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
