import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IntercomTools } from "./tools.ts";
import { throwIfToolError } from "./tool-results.ts";
import { intercomSchema } from "./tool-schemas.ts";
import { registerCompactMessages, renderCompactResult } from "../shared/compact-cards.ts";

export function registerIntercomTools(
  pi: ExtensionAPI,
  tools: Readonly<Pick<IntercomTools, "execute">>,
): void {
  registerCompactMessages(pi, ["intercom_message", "subagent-human-message"]);
  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description:
      "Message connected Pi sessions in your group; mains also reach other mains across projects. List shows target IDs. Ask waits for a correlated reply; reply answers the active or sole pending ask. Pending lists asks; status shows connection and inbound queue. Last pages a peer's last completed response without waking it. Broker acceptance is not recipient persistence, consumption or completion.",
    parameters: intercomSchema,
    renderResult: renderCompactResult,
    // oxlint-disable-next-line max-params
    async execute(_id, params, signal, _update, ctx) {
      const result = throwIfToolError(await tools.execute(params, signal, ctx));
      return { content: [...result.content], details: result.details };
    },
  });
}
