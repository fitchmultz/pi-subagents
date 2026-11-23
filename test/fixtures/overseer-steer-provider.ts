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
  const skepticLog = process.env.OVERSEER_TEST_SKEPTIC_LOG;
  if (cwd === undefined || skepticLog === undefined) {
    throw new Error(
      "The overseer fixture requires OVERSEER_TEST_REPO and OVERSEER_TEST_SKEPTIC_LOG.",
    );
  }

  const worker = fauxProvider({
    provider: "overseer-fixture",
    models: [{ id: "native-overseer", reasoning: false }],
  });

  worker.setResponses([
    async (context) => {
      if (hasMessage(context, "READ_ONLY_TRY_WRITE")) {
        return fauxAssistantMessage([
          fauxToolCall(
            "write",
            { path: "src/blocked.ts", content: "nope\n" },
            { id: "ro-write-1" },
          ),
        ]);
      }
      if (hasMessage(context, "TOOL_ERROR_LOOP")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "exit 1" }, { id: "err-1" })]);
      }
      // First working-tree edit triggers the one-time early shape_check pause.
      fs.writeFileSync(
        path.join(cwd, "src", "timer.ts"),
        "export const INTERVAL_MS = 5 * 60_000;\n",
      );
      fs.writeFileSync(path.join(cwd, "src", "extra.ts"), "export const ok = true;\n");
      return fauxAssistantMessage([
        fauxToolCall("bash", { command: "printf turn1" }, { id: "turn1-bash" }),
      ]);
    },
    async (context) => {
      if (hasMessage(context, "READ_ONLY_TRY_WRITE")) {
        const blocked = hasMessage(context, "read-only");
        return fauxAssistantMessage(blocked ? "BLOCKED_AS_EXPECTED" : "UNEXPECTED");
      }
      if (hasMessage(context, "TOOL_ERROR_LOOP")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "exit 2" }, { id: "err-2" })]);
      }
      if (hasMessage(context, "FIX_INTERVAL_TO_60S")) {
        fs.writeFileSync(path.join(cwd, "src", "timer.ts"), "export const INTERVAL_MS = 60_000;\n");
        return fauxAssistantMessage("FIXED_60S");
      }
      // Make a second edit after shape_check approval so final_diff + skeptic fire before settle.
      fs.writeFileSync(
        path.join(cwd, "src", "timer.ts"),
        "export const INTERVAL_MS = 5 * 60_000;\nexport const extra = 1;\n",
      );
      return fauxAssistantMessage("READY_TO_SHIP");
    },
    async (context) => {
      if (hasMessage(context, "TOOL_ERROR_LOOP")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "exit 3" }, { id: "err-3" })]);
      }
      if (hasMessage(context, "FIX_INTERVAL_TO_60S")) {
        fs.writeFileSync(path.join(cwd, "src", "timer.ts"), "export const INTERVAL_MS = 60_000;\n");
        return fauxAssistantMessage("FIXED_AFTER_FINAL_STEER");
      }
      return fauxAssistantMessage("DONE_TURN_3");
    },
    async () => fauxAssistantMessage("RECOVERED_AFTER_ERROR_STEER"),
  ]);
  pi.registerProvider(worker.provider);

  const skeptic = fauxProvider({
    provider: "overseer-skeptic-fixture",
    models: [{ id: "grounded-skeptic", reasoning: true }],
  });
  skeptic.setResponses([
    async (context) => {
      const text = JSON.stringify(context.messages);
      fs.writeFileSync(skepticLog, text);
      if (text.includes("INTERVAL_MS = 5 * 60_000")) {
        return fauxAssistantMessage(
          JSON.stringify({
            action: "flag",
            findings: [
              {
                kind: "intent_drift",
                file: "src/timer.ts",
                excerpt: "export const INTERVAL_MS = 5 * 60_000;",
                why: "Owner asked for a 60-second interval, not five minutes.",
                blocking: true,
              },
            ],
          }),
        );
      }
      return fauxAssistantMessage(JSON.stringify({ action: "ok", findings: [] }));
    },
    async () => fauxAssistantMessage(JSON.stringify({ action: "ok", findings: [] })),
    async () => fauxAssistantMessage(JSON.stringify({ action: "ok", findings: [] })),
  ]);
  pi.registerProvider(skeptic.provider);
}
