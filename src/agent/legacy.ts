import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { journalStamp } from "../shared/native-journal.ts";
import { receiptId } from "./receipts.ts";
import { resolveTempRootDir } from "../shared/types.ts";
import { isRecord } from "../shared/unknown.ts";
import { hold, release, isHeld } from "./notifications.ts";
import { missing } from "./storage.ts";

interface LegacyInput {
  file: string;
  raw: string;
  stamp: string;
  id: string;
  key: string;
  owner: string;
  single: boolean;
}
function legacyInput(file: string, owner: string): LegacyInput | undefined {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return;
  }
  const raw = fs.readFileSync(file, "utf8");
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || data.sessionId !== owner) {
    return;
  }
  const id = typeof data.runId === "string" ? data.runId : data.id;
  if (typeof id !== "string" || path.basename(file, ".json") !== id) {
    return;
  }
  const legacy = `legacy:${id}:${typeof data.timestamp === "number" ? data.timestamp : "unknown"}`;
  const completionId = typeof data.completionId === "string" ? data.completionId : legacy;
  return {
    file,
    raw,
    stamp: journalStamp(stat),
    id,
    key: `completion:${completionId}`,
    owner,
    single: data.mode === "single",
  };
}
function legacyCompletion(details: unknown, input: LegacyInput): boolean {
  if (!isRecord(details)) {
    return false;
  }
  const value = details.completion ?? details.subagentCompletion;
  if (!isRecord(value) || value.runId !== input.id) {
    return false;
  }
  if (value.ownerSessionId !== undefined && value.ownerSessionId !== input.owner) {
    return false;
  }
  return completionKey(value, input.key);
}
function completionKey(value: Record<string, unknown>, key: string): boolean {
  return (
    value.key === key ||
    `completion:${typeof value.completionId === "string" ? value.completionId : ""}` === key ||
    (key.startsWith("completion:legacy:") && value.completionId === undefined)
  );
}
function legacyWait(message: unknown, input: LegacyInput): boolean {
  if (
    !isRecord(message) ||
    message.role !== "toolResult" ||
    message.isError === true ||
    !isRecord(message.details)
  ) {
    return false;
  }
  if (
    !["delegate", "subagent", "agent_runs"].includes(
      typeof message.toolName === "string" ? message.toolName : "",
    )
  ) {
    return false;
  }
  return completedWait(message.details.wait, input);
}
function completedWait(wait: unknown, input: LegacyInput): boolean {
  return (
    isRecord(wait) &&
    wait.status === "completed" &&
    wait.runId === input.id &&
    (wait.index === undefined || (input.single && wait.index === 0))
  );
}
function receipt(body: unknown, input: LegacyInput): boolean {
  if (!isRecord(body)) {
    return false;
  }
  if (body.type === "custom_message") {
    return legacyCompletion(body.details, input);
  }
  return body.type === "message" && legacyWait(body.message, input);
}
function published(ctx: ExtensionContext, input: LegacyInput): boolean {
  return (
    receiptId(ctx.sessionManager.getSessionFile(), input.owner, (body) => receipt(body, input)) !==
    undefined
  );
}
function deliver(pi: ExtensionAPI, ctx: ExtensionContext, input: LegacyInput): void {
  const identity = `legacy:${input.id}:${input.key}`;
  if (published(ctx, input)) {
    release(input.owner, identity);
    // Retire only the unchanged recovery input whose actual native receipt exists.
    if (
      journalStamp(fs.lstatSync(input.file, { bigint: true })) === input.stamp &&
      fs.readFileSync(input.file, "utf8") === input.raw
    ) {
      fs.unlinkSync(input.file);
    }
    return;
  }
  if (isHeld(input.owner, identity)) {
    return;
  }
  hold(input.owner, identity);
  try {
    pi.sendMessage(
      {
        customType: "subagent-notify",
        display: true,
        // Full saved bytes, not a replacement summary. No owner/run record is invented.
        content: input.raw,
        details: { completion: { runId: input.id, key: input.key, ownerSessionId: input.owner } },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } catch (error) {
    release(input.owner, identity);
    throw error;
  }
}
export function notifyLegacy(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const root = resolveTempRootDir();
  const directory = path.join(root, "async-subagent-results");
  let names: string[];
  try {
    for (const candidate of [root, directory]) {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Unsafe legacy recovery directory: ${candidate}`);
      }
    }
    names = fs.readdirSync(directory);
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const input = legacyInput(path.join(directory, name), ctx.sessionManager.getSessionId());
    if (input) {
      deliver(pi, ctx, input);
    }
  }
}
