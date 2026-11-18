import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fixture(pi: ExtensionAPI): void {
  const steps = process.env.OVERSEER_ATTRIBUTION_STEPS;
  if (steps === undefined) {
    throw new Error("OVERSEER_ATTRIBUTION_STEPS required");
  }
  const provider = fauxProvider({
    provider: "attribution-fixture",
    models: [{ id: "native-attribution", reasoning: false }],
  });
  provider.setResponses(
    [0, 1, 2, 3].map((step) => async (_context, options) => {
      const commandFile = path.join(steps, `${step}.command`);
      // This request is only made after the previous turn's checkpoint has returned.
      fs.writeFileSync(path.join(steps, `${step}.ready`), "");
      while (!fs.existsSync(commandFile)) {
        if (options?.signal?.aborted === true) {
          return fauxAssistantMessage("Stopped");
        }
        await delay(10);
      }
      const command = fs.readFileSync(commandFile, "utf8");
      return command === ""
        ? fauxAssistantMessage("Finished")
        : fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
    }),
  );
  pi.registerProvider(provider.provider);
}
