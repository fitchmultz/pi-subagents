import type { UserMessage } from "@earendil-works/pi-ai";
import type { CustomMessageEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInboundEntry } from "../pi-intercom/inbound-record.ts";
import { isRecord } from "../shared/unknown.ts";
import type { Launch } from "./contracts.ts";
import { OVERSEER_CORRECTION } from "./overseer-pause.ts";

function userText({ content }: UserMessage): string {
  return typeof content === "string"
    ? content
    : content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

function ownerCustomText(
  entry: CustomMessageEntry,
  owner: string,
  corrections: Map<string, string>,
): string | undefined {
  if (entry.customType === OVERSEER_CORRECTION) {
    return takeCorrection(entry, corrections);
  }
  const details: unknown = entry.details;
  return entry.customType === "intercom_message" &&
    isInboundEntry(details) &&
    details.from.rootSessionId === owner &&
    details.from.parentSessionId === undefined
    ? details.message.content.text
    : undefined;
}

function takeCorrection(
  entry: CustomMessageEntry,
  remaining: Map<string, string>,
): string | undefined {
  const details: unknown = entry.details;
  if (!isRecord(details) || typeof details.commandId !== "string") {
    return undefined;
  }
  const prompt = remaining.get(details.commandId);
  if (prompt === undefined || prompt !== entry.content) {
    return undefined;
  }
  remaining.delete(details.commandId);
  return prompt;
}

/** Only task-owner guidance placed on the native branch, not queued commands or review notes. */
export function checkpointGuidance(
  journal: Pick<ExtensionContext["sessionManager"], "getBranch">,
  launch: Launch,
  source: {
    readonly baseline: ReadonlySet<string> | undefined;
    readonly admittedCorrections: ReadonlyMap<string, string>;
  },
): string[] {
  const { baseline, admittedCorrections } = source;
  if (baseline === undefined) {
    return [];
  }
  const guidance: string[] = [];
  const corrections = new Map(admittedCorrections);
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
      const text = ownerCustomText(entry, launch.owner, corrections);
      if (text !== undefined) {
        guidance.push(text);
      }
    }
  }
  return guidance;
}
