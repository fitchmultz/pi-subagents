import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { journalStamp } from "../shared/native-journal.ts";
import { receiptId } from "./receipts.ts";
import { resolveTempRootDir } from "../shared/types.ts";
import { isRecord } from "../shared/unknown.ts";
import { release, isHeld, type Completion } from "./notifications.ts";
import { missing } from "./storage.ts";
import { errorText } from "./host.ts";

interface LegacyInput {
  file: string;
  raw: string;
  stamp: string;
  id: string;
  key: string;
  owner: string;
  single: boolean;
}
interface IgnoredInputs {
  readonly owner: string;
  readonly directory: string;
  readonly ignored: Map<string, string>;
}
interface LegacyScan extends IgnoredInputs {
  readonly known: ReadonlyMap<string, string> | undefined;
}
// Retain only foreign classifications, never their saved output, for each live native manager.
const ignoredInputs = new WeakMap<ExtensionContext["sessionManager"], IgnoredInputs>();
function fileStamp(file: string): string | undefined {
  const stat = fs.lstatSync(file, { bigint: true });
  return stat.isFile() && !stat.isSymbolicLink() ? journalStamp(stat) : undefined;
}
function legacyInput(file: string, scan: LegacyScan): LegacyInput | undefined {
  const stamp = fileStamp(file);
  if (stamp === undefined) {
    return;
  }
  if (scan.known?.get(file) === stamp) {
    scan.ignored.set(file, stamp);
    return;
  }
  const raw = fs.readFileSync(file, "utf8");
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || data.sessionId !== scan.owner) {
    if (fileStamp(file) === stamp) {
      scan.ignored.set(file, stamp);
    }
    return;
  }
  return ownedInput({ file, raw, stamp, owner: scan.owner }, data);
}
function ownedInput(
  source: Pick<LegacyInput, "file" | "raw" | "stamp" | "owner">,
  data: Record<string, unknown>,
): LegacyInput | undefined {
  const id = typeof data.runId === "string" ? data.runId : data.id;
  if (typeof id !== "string" || path.basename(source.file, ".json") !== id) {
    return;
  }
  const legacy = `legacy:${id}:${typeof data.timestamp === "number" ? data.timestamp : "unknown"}`;
  const completionId = typeof data.completionId === "string" ? data.completionId : legacy;
  return {
    ...source,
    id,
    key: `completion:${completionId}`,
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
function notification(ctx: ExtensionContext, input: LegacyInput): Completion | undefined {
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
  return {
    owner: input.owner,
    id: identity,
    message: {
      customType: "subagent-notify",
      display: true,
      // Full saved bytes, not a replacement summary. No owner/run record is invented.
      content: input.raw,
      details: { completion: { runId: input.id, key: input.key, ownerSessionId: input.owner } },
    },
  };
}
function legacyNotice(
  ctx: ExtensionContext,
  file: string,
  scan: LegacyScan,
): Completion | undefined {
  try {
    const input = legacyInput(file, scan);
    return input ? notification(ctx, input) : undefined;
  } catch (error) {
    console.error(`Skipped legacy completion ${file}: ${errorText(error)}`);
    return;
  }
}
function startScan(ctx: ExtensionContext, directory: string): LegacyScan {
  const manager = ctx.sessionManager;
  const owner = manager.getSessionId();
  const prior = ignoredInputs.get(manager);
  const scan: LegacyScan = {
    directory,
    owner,
    known: prior?.directory === directory && prior.owner === owner ? prior.ignored : undefined,
    ignored: new Map(),
  };
  // Replace even on a failed directory scan; vanished/unsafe inputs keep no cached decision.
  ignoredInputs.set(manager, { directory, owner, ignored: scan.ignored });
  return scan;
}
/** Retired releases created this directory at session start, before any of their runners. */
export function legacyDirectory(): string {
  return path.join(resolveTempRootDir(), "async-subagent-results");
}
export function legacyNotifications(ctx: ExtensionContext): Completion[] {
  const notices: Completion[] = [];
  const directory = legacyDirectory();
  const root = path.dirname(directory);
  const scan = startScan(ctx, directory);
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
      return notices;
    }
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const notice = legacyNotice(ctx, path.join(directory, name), scan);
    if (notice) {
      notices.push(notice);
    }
  }
  return notices;
}
