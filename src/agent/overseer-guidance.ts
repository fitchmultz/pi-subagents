import type { UserMessage } from "@earendil-works/pi-ai";
import type { CustomMessageEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInboundEntry } from "../pi-intercom/inbound-record.ts";
import type { Launch } from "./contracts.ts";

function userText({ content }: UserMessage): string {
  return typeof content === "string"
    ? content
    : content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

function ownerIntercomText(entry: CustomMessageEntry, owner: string): string | undefined {
  const details: unknown = entry.details;
  return entry.customType === "intercom_message" &&
    isInboundEntry(details) &&
    details.from.rootSessionId === owner &&
    details.from.parentSessionId === undefined
    ? details.message.content.text
    : undefined;
}

/** Only task-owner guidance placed on the native branch, not queued commands or review notes. */
export function checkpointGuidance(
  journal: Pick<ExtensionContext["sessionManager"], "getBranch">,
  launch: Launch,
  baseline: ReadonlySet<string> | undefined,
): string[] {
  if (baseline === undefined) {
    return [];
  }
  const guidance: string[] = [];
  let sawPrompt = false;
  for (const entry of journal.getBranch()) {
    if (baseline.has(entry.id)) {
      continue;
    }
    if (entry.type === "message" && entry.message.role === "user") {
      const text = userText(entry.message);
      // The actor's initial native user message is already supplied as taskPrompt.
      if (sawPrompt || text !== launch.prompt) {
        guidance.push(text);
      }
      sawPrompt = true;
    } else if (entry.type === "custom_message") {
      const text = ownerIntercomText(entry, launch.owner);
      if (text !== undefined) {
        guidance.push(text);
      }
    }
  }
  return guidance;
}
