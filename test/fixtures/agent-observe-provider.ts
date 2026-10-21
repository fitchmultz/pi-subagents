import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function fixture(pi: ExtensionAPI): void {
  const root = process.env.OBSERVE_TEST_ROOT;
  if (root === undefined) {
    throw new Error("OBSERVE_TEST_ROOT required");
  }
  const child = process.env.PI_INTERCOM_PARENT_SESSION_ID !== undefined;
  pi.on("session_start", (_event, ctx) => {
    fs.appendFileSync(
      path.join(root, "sessions.jsonl"),
      JSON.stringify({
        child,
        pid: process.pid,
        owner: ctx.sessionManager.getSessionId(),
        mode: ctx.mode,
        observerCommand: pi.getCommands().some((command) => command.name === "agents"),
      }) + "\n",
    );
  });
  const provider = fauxProvider({
    provider: "observe-fixture",
    models: [{ id: "native-observe", reasoning: false }],
  });
  provider.setResponses(
    Array.from({ length: 20 }, () => async (context, options) => {
      fs.appendFileSync(
        path.join(root, "requests.jsonl"),
        JSON.stringify({ child, count: context.messages.length }) + "\n",
      );
      const result = context.messages.some((message) => message.role === "toolResult");
      if (child) {
        return result
          ? fauxAssistantMessage("CHILD_FINAL_FACT")
          : fauxAssistantMessage(
              [
                { type: "text", text: "CHILD_TEXT_LIVE 雪😀" },
                { type: "toolCall", id: "observe-gate", name: "observe_gate", arguments: {} },
              ],
              { stopReason: "toolUse" },
            );
      }
      if (result) {
        fs.writeFileSync(path.join(root, "parent-ready"), "ready");
        while (
          !fs.existsSync(path.join(root, "release-parent")) &&
          options?.signal?.aborted !== true
        ) {
          // oxlint-disable-next-line no-await-in-loop
          await delay(20);
        }
        return fauxAssistantMessage("PARENT_FINAL_FACT");
      }
      return fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "observe-delegate",
            name: "delegate",
            arguments: {
              prompt: "OBSERVE_CHILD",
              name: "watch-child 雪",
              context: process.env.OBSERVE_TEST_CONTEXT === "fork" ? "fork" : "fresh",
            },
          },
        ],
        { stopReason: "toolUse" },
      );
    }),
  );
  pi.registerProvider(provider.provider);
  pi.registerTool({
    name: "observe_gate",
    label: "Observe gate",
    description: "Native held tool for passive observer verification",
    parameters: Type.Object({}),
    execute: async (_id, _args, signal) => {
      fs.writeFileSync(path.join(root, "child-ready"), "ready");
      while (!fs.existsSync(path.join(root, "release-child"))) {
        if (signal?.aborted === true) {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop
        await delay(20);
      }
      return {
        content: [{ type: "text", text: "CHILD_TOOL_ERROR_FACT" }],
        details: undefined,
        isError: true,
      };
    },
  });
}
