import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomTransport } from "./transport.ts";
import type { Journal } from "./inbound-journal.ts";
import type { ReplyTracker } from "./reply-tracker.ts";
import type { IntercomSessionScope, ToolResultLike } from "./runtime-types.ts";
import { formatSessionListSections, sessionsForScope } from "./ui/session-format.ts";
import { formatSessionTarget } from "./session-targets.ts";
import { pendingAskPreview } from "./message-format.ts";
import { toolError, toolText } from "./tool-arguments.ts";
import { errorMessage } from "./validation.ts";
export class IntercomInspection {
  private readonly journal: Journal;
  private readonly replies: Readonly<ReplyTracker>;
  constructor(journal: Journal, replies: Readonly<ReplyTracker>) {
    this.journal = journal;
    this.replies = replies;
  }
  pending(): ToolResultLike {
    const asks = this.replies.listPending();
    if (asks.length === 0) {
      return toolText("No unresolved inbound asks.");
    }
    const now = Date.now();
    const lines = asks.map(({ from, message, receivedAt }) => {
      const sender =
        from.name !== undefined && from.name !== ""
          ? `${from.name} (${formatSessionTarget(
              from,
              asks.map((ask) => ask.from),
            )})`
          : from.id;
      const replyTo = JSON.stringify(message.id);
      return `- ${sender} · replyTo: ${replyTo} · ${Math.max(0, Math.floor((now - receivedAt) / 1000))}s ago · ${pendingAskPreview(message)}\n  Reply: intercom({ action: "reply", replyTo: ${replyTo}, message: "..." })`;
    });
    return toolText(`**Pending asks:**\n${lines.join("\n")}`);
  }
  async list(active: IntercomTransport, scope: IntercomSessionScope): Promise<ToolResultLike> {
    try {
      const id = active.sessionId;
      if (id === null || id === "") {
        throw new Error("Current intercom session id is unavailable.");
      }
      const all = await active.listSessions();
      return toolText(formatSessionListSections(all, id, scope), {
        sessionCount: sessionsForScope(all, id, scope).length,
      });
    } catch (error) {
      return toolError(`Failed to list sessions: ${errorMessage(error)}`);
    }
  }
  async status(
    active: IntercomTransport,
    scope: IntercomSessionScope,
    ctx: ExtensionContext,
  ): Promise<ToolResultLike> {
    try {
      const id = active.sessionId;
      if (id === null || id === "") {
        throw new Error("Current intercom session id is unavailable.");
      }
      const all = await active.listSessions();
      this.journal.reconcileConsumed(ctx);
      const pending = this.journal.entries();
      const lines = pending.map(
        (entry) =>
          `- ${entry.from.name === undefined || entry.from.name === "" ? entry.from.id : entry.from.name} [${entry.message.id}] (${entry.stage === "queued" ? "queued; not yet delivered to model" : "delivered to model queue; not yet consumed"})\n${entry.bodyText}`,
      );
      const text =
        pending.length > 0
          ? `\n\nPending inbound messages: ${pending.length}\n${lines.join("\n\n")}`
          : "\n\nPending inbound messages: 0";
      return toolText(
        `**Intercom Status:**\nConnected: Yes\nSession ID: ${id}\nConnected sessions in scope: ${sessionsForScope(all, id, scope).length}\n\n${formatSessionListSections(all, id, scope)}${text}`,
      );
    } catch (error) {
      return toolError(`Failed to get status: ${errorMessage(error)}`);
    }
  }
}
