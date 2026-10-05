import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionEntryCursor } from "../../shared/session-entries.ts";
import { nonempty } from "./child-presence.ts";

function entryObservation(entry: SessionEntry): Readonly<Record<string, unknown>> {
  const message = entry.type === "message" ? entry.message : undefined;
  const usage =
    entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
      ? entry.usage
      : undefined;
  return {
    id: entry.id,
    type: entry.type,
    parentId: entry.parentId,
    ...("checkpoint" in entry ? { checkpoint: entry.checkpoint } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(entry.type === "usage" ? { provider: entry.provider, model: entry.model } : {}),
    ...(message ? { message: messageObservation(message) } : {}),
  };
}
function messageObservation(
  message: Extract<SessionEntry, { type: "message" }>["message"],
): Readonly<Record<string, unknown>> {
  return {
    role: message.role,
    timestamp: message.timestamp,
    ...("usage" in message ? { usage: message.usage } : {}),
    ...(message.role === "assistant"
      ? { provider: message.provider, model: message.model, responseModel: message.responseModel }
      : {}),
    ...("toolCallId" in message ? { toolCallId: message.toolCallId } : {}),
  };
}

/** turn_end follows native append; message_end alone is never a commit receipt. */
export class ChildNativeObservation {
  private readonly cursor = new SessionEntryCursor();
  private previousIds = new Set<string>();
  private observedMessages = 0;
  start(ctx: ExtensionContext): void {
    this.cursor.reset();
    this.observedMessages = 0;
    const { entries } = this.cursor.read(ctx.sessionManager);
    const baseline = process.env.PI_SUBAGENT_NATIVE_BASELINE_COUNT;
    if (nonempty(baseline) && /^\d+$/.test(baseline)) {
      process.stdout.write(
        `${JSON.stringify({ type: "subagent.native_baseline", sessionId: ctx.sessionManager.getSessionId(), entryIds: entries.slice(0, Number(baseline)).map((entry) => entry.id) })}\n`,
      );
    }
    const file = ctx.sessionManager.getSessionFile();
    const persisted = nonempty(file) && fs.existsSync(file);
    this.previousIds = persisted ? new Set(entries.map((entry) => entry.id)) : new Set();
    if (!persisted) {
      this.cursor.reset();
    }
  }
  message(role: string): void {
    if (["assistant", "user", "toolResult"].includes(role)) {
      this.observedMessages++;
    }
  }
  publish(ctx: ExtensionContext, boundary: string, pi: ExtensionAPI): void {
    if (process.env.PI_SUBAGENT_CHILD !== "1") {
      return;
    }
    const entries: Readonly<Record<string, unknown>>[] = [];
    for (const entry of this.cursor.read(ctx.sessionManager).entries) {
      if (!this.previousIds.has(entry.id)) {
        this.previousIds.add(entry.id);
        entries.push(entryObservation(entry));
      }
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    process.stdout.write(
      `${JSON.stringify({ type: "subagent.native", boundary, entries, sessionId: ctx.sessionManager.getSessionId(), sessionFile, leafId: ctx.sessionManager.getLeafId(), persisted: nonempty(sessionFile) && fs.existsSync(sessionFile), messageCount: this.observedMessages, configuration: { ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}), thinking: pi.getThinkingLevel() } })}\n`,
    );
  }
}
