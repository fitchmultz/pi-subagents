import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { receiptId } from "./receipts.ts";
import { readOutputPage } from "../shared/output-page.ts";
import { isRecord } from "../shared/unknown.ts";
import type { Launch, Result } from "./contracts.ts";
import { launchAt, list, runDirectory } from "./storage.ts";
import { readResult } from "./usage.ts";

function queuedAdmissions(): Set<string> {
  const store = globalThis as Record<string, unknown>;
  const existing = store.__pi_single_agent_admissions__;
  if (existing instanceof Set) {
    const values: Set<unknown> = existing;
    const strings = [...values].filter((value): value is string => typeof value === "string");
    if (strings.length === values.size) {
      // Keep one live queue identity across native extension reloads.
      // oxlint-disable-next-line typescript/no-unsafe-return
      return existing;
    }
  }
  const queued = new Set<string>();
  store.__pi_single_agent_admissions__ = queued;
  return queued;
}
const admissions = queuedAdmissions();
export function hold(owner: string, id: string): boolean {
  const key = `${owner}/${id}`;
  if (admissions.has(key)) {
    return false;
  }
  admissions.add(key);
  return true;
}
export function release(owner: string, id: string): void {
  admissions.delete(`${owner}/${id}`);
}
export function isHeld(owner: string, id: string): boolean {
  return admissions.has(`${owner}/${id}`);
}
export function settle(owner: string, pending: boolean): void {
  if (pending) {
    return;
  }
  for (const key of admissions) {
    if (key.startsWith(`${owner}/`)) {
      admissions.delete(key);
    }
  }
}
function matches(value: unknown, launch: Launch): boolean {
  return (
    isRecord(value) &&
    value.owner === launch.owner &&
    value.id === launch.id &&
    value.completed === true
  );
}
function toolReceipt(message: unknown, launch: Launch): boolean {
  if (!isRecord(message) || message.role !== "toolResult") {
    return false;
  }
  return (
    (message.toolName === "delegate" || message.toolName === "agent_runs") &&
    isRecord(message.details) &&
    message.details.receivedResult === true &&
    matches(message.details, launch)
  );
}
function receipt(body: unknown, launch: Launch): boolean {
  if (!isRecord(body)) {
    return false;
  }
  if (body.type === "custom_message" && body.customType === "agent-completion") {
    return matches(body.details, launch);
  }
  return body.type === "message" && toolReceipt(body.message, launch);
}
export function published(ctx: ExtensionContext, launch: Launch): string | undefined {
  return receiptId(ctx.sessionManager.getSessionFile(), launch.owner, (body) =>
    receipt(body, launch),
  );
}
function send(pi: ExtensionAPI, base: string, launch: Launch, result: Result): void {
  const file = path.join(runDirectory(base, launch.id), "output.txt");
  const page = fs.existsSync(file) ? readOutputPage(file, { offset: 0, length: 32768 }) : undefined;
  const more =
    page?.nextOffset !== undefined
      ? `\n[More output: agent_runs inspect id=${launch.id} offset=${page.nextOffset}; ${page.size} bytes total.]`
      : "";
  hold(launch.owner, launch.id);
  try {
    pi.sendMessage(
      {
        customType: "agent-completion",
        display: true,
        content: `Agent run ${launch.id}: ${result.status}. ${result.error ?? ""}\n${page?.text ?? ""}${more}\nNative journal: ${launch.sessionFile}`,
        details: {
          owner: launch.owner,
          id: launch.id,
          completed: true,
          result,
          outputFile: file,
          page,
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } catch (error) {
    admissions.delete(`${launch.owner}/${launch.id}`);
    throw error;
  }
}
export function notify(pi: ExtensionAPI, ctx: ExtensionContext, base: string, owner: string): void {
  for (const id of list(base)) {
    const launch = launchAt(base, id, owner);
    const result = readResult(base, launch);
    if (!result) {
      continue;
    }
    const key = `${owner}/${id}`;
    if (published(ctx, launch) !== undefined) {
      admissions.delete(key);
      continue;
    }
    if (!admissions.has(key)) {
      send(pi, base, launch, result);
    }
  }
}
