import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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
  const provider = fauxProvider({
    provider: "overseer-fixture",
    models: [{ id: "native-overseer", reasoning: false }],
  });
  const fail = (id: string, command: string) => fauxToolCall("bash", { command }, { id });
  provider.setResponses([
    async (context) => {
      if (hasMessage(context, "Check screenshot")) {
        return fauxAssistantMessage([fail("check-browser", "echo private-tool-output; exit 1")]);
      }
      // Write out-of-scope drift without a mutating tool so agent_before_settle catches it.
      fs.writeFileSync(path.join(cwd, "README.md"), "out-of-scope drift\n");
      // Another session commits in a different worktree of the same repository.
      fs.writeFileSync(path.join(sibling, "SIBLING.md"), "other session\n");
      execFileSync("git", ["add", "SIBLING.md"], { cwd: sibling, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "other session"], { cwd: sibling, stdio: "ignore" });
      return fauxAssistantMessage("DRIFTED");
    },
    async (context) => {
      if (hasMessage(context, "Check screenshot")) {
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "README.md" }, { id: "check-read" }),
          fail("check-selector", "echo private-arg; exit 2"),
        ]);
      }
      if (hasMessage(context, "REVERT_README")) {
        fs.writeFileSync(path.join(cwd, "README.md"), "committed\n");
        return fauxAssistantMessage("REVERTED");
      }
      return fauxAssistantMessage("UNSTEERED");
    },
    fauxAssistantMessage([fail("check-assertion", "exit 3")]),
    ...["retry-one", "retry-two", "retry-three"].map((id) =>
      fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" }, { id })]),
    ),
    fauxAssistantMessage("CHECKED"),
  ]);
  pi.registerProvider(provider.provider);
}
