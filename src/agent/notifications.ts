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
export interface Completion {
  readonly owner: string;
  readonly id: string;
  readonly message: Parameters<ExtensionAPI["sendMessage"]>[0];
}
export function deliver(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  notices: readonly Completion[],
): void {
  const idle = ctx.isIdle();
  for (const [index, notice] of notices.entries()) {
    hold(notice.owner, notice.id);
    try {
      // Pi defers settlement-triggered runs separately. Publish the idle batch first,
      // then trigger once so no unstarted wakeup can outlive its admission hold.
      pi.sendMessage(notice.message, {
        triggerTurn: !idle || index === notices.length - 1,
        deliverAs: "steer",
      });
    } catch (error) {
      release(notice.owner, notice.id);
      throw error;
    }
  }
}
function notification(base: string, launch: Launch, result: Result): Completion {
  const file = path.join(runDirectory(base, launch.id), "output.txt");
  const page = fs.existsSync(file) ? readOutputPage(file, { offset: 0, length: 32768 }) : undefined;
  const more =
    page?.nextOffset !== undefined
      ? `\n[More output: agent_runs inspect id=${launch.id} offset=${page.nextOffset}; ${page.size} bytes total.]`
      : "";
  return {
    owner: launch.owner,
    id: launch.id,
    message: {
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
  };
}
export function notifications(ctx: ExtensionContext, base: string, owner: string): Completion[] {
  const notices: Completion[] = [];
  const completed = list(base)
    .map((id) => {
      const launch = launchAt(base, id, owner);
      return { launch, result: readResult(base, launch) };
    })
    .filter((item): item is { launch: Launch; result: Result } => item.result !== undefined)
    .sort((a, b) => {
      const ended = a.result.endedAt - b.result.endedAt;
      const created = a.launch.createdAt - b.launch.createdAt;
      if (ended !== 0) {
        return ended;
      }
      return created !== 0 ? created : a.launch.id.localeCompare(b.launch.id);
    });
  for (const { launch, result } of completed) {
    const id = launch.id;
    const key = `${owner}/${id}`;
    if (published(ctx, launch) !== undefined) {
      admissions.delete(key);
      continue;
    }
    if (!admissions.has(key)) {
      notices.push(notification(base, launch, result));
    }
  }
  return notices;
}
