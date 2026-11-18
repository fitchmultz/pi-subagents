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
  const judgeInput = process.env.OVERSEER_TEST_JUDGE_INPUT;
  if (cwd === undefined || sibling === undefined || judgeInput === undefined) {
    throw new Error("The overseer fixture requires both worktrees and a judge input path.");
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
  const fail = (id: string, command: string) => fauxToolCall("bash", { command }, { id });
  provider.setResponses([
    async (context) => {
      if (hasMessage(context, "Check screenshot")) {
        return fauxAssistantMessage([fail("check-browser", "echo private-tool-output; exit 1")]);
      }
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
      if (hasMessage(context, "Check screenshot")) {
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "README.md" }, { id: "check-read" }),
          fail("check-selector", "echo private-arg; exit 2"),
        ]);
      }
      const guidance = context.messages.flatMap((message) => {
        if (message.role !== "user") {
          return [];
        }
        const { content } = message;
        const text =
          typeof content === "string"
            ? content
            : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
        return text.includes("Keep x instead of replacing it.") ||
          text.includes("REVERT_README and replace x with the greeting")
          ? [text]
          : [];
      });
      if (toolGate !== undefined) {
        fs.writeFileSync(`${judgeInput}.model`, JSON.stringify(guidance));
      }
      if (hasMessage(context, "REVERT_README")) {
        fs.writeFileSync(path.join(cwd, "README.md"), "committed\n");
        if (
          hasMessage(context, "REVERT_README and replace x with the greeting in src/allowed.ts.")
        ) {
          const preserveX = guidance.at(-1)?.includes("Keep x instead of replacing it.") === true;
          fs.writeFileSync(
            path.join(cwd, "src", "allowed.ts"),
            preserveX ? "export const x = 2;\n" : "export const greeting = 'hi';\n",
          );
        }
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
  pi.registerProvider("overseer-choice-fixture", {
    baseUrl: "http://127.0.0.1",
    apiKey: "fixture",
    models: [
      {
        id: "choice-only",
        name: "Choice only",
        type: "classifier",
        api: "overseer-choice",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
      },
    ],
    classifiers: {
      "overseer-choice": {
        classify: (model, context) => {
          fs.writeFileSync(judgeInput, JSON.stringify(context));
          return Promise.resolve({
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            stopReason: "stop",
            answers: {
              verdict: {
                type: "choice",
                choice: "scope_violation",
                confidence: 0.99,
                probabilities: { compliant: 0.01, scope_violation: 0.99 },
              },
            },
          });
        },
      },
    },
  });
}
