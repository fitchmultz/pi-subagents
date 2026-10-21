import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IntercomTools } from "./tools.ts";
import { throwIfToolError } from "./tool-results.ts";
import { intercomSchema } from "./tool-schemas.ts";
import { registerCompactMessages, renderCompactResult } from "../shared/compact-cards.ts";

export function registerIntercomTools(
  pi: ExtensionAPI,
  tools: Readonly<Pick<IntercomTools, "execute">>,
): void {
  registerCompactMessages(pi, ["intercom_message"]);
  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description:
      "Discover and message connected Pi sessions in your collaboration group; main sessions can also reach other mains, across projects. Use list for unambiguous targets. Send defaults to steer at the next tool boundary; queue defers; passive never wakes the model. Ask waits for a correlated reply; reply answers the active or single pending ask (specify replyTo when ambiguous). Pending lists asks; status shows connection and inbound queue state. Last reads a peer's original completed assistant response without waking it; page using entryId and nextOffset. Broker acceptance is not recipient persistence, consumption, or task completion.",
    parameters: intercomSchema,
    renderResult: renderCompactResult,
    async execute(_id, params, signal, _update, ctx) {
      const result = throwIfToolError(await tools.execute(params, signal, ctx));
      return { content: [...result.content], details: result.details };
    },
  });
}
