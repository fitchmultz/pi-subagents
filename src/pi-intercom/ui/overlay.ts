import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomTransport } from "../transport.ts";
import type { Lifecycle } from "../lifecycle.ts";
import type { Connection } from "../connection.ts";
import type { TopicOwner } from "../topics.ts";
import type { SessionInfo } from "../types.ts";
import { TOPICS_UNAVAILABLE, type IntercomSessionScope } from "../runtime-types.ts";
import { errorMessage } from "../validation.ts";
import { targetDisplayName } from "../session-targets.ts";
import { sessionsForScope } from "./session-format.ts";
import { SessionListOverlay } from "./session-list.ts";
import { ComposeOverlay, type ComposeResult } from "./compose.ts";
interface OverlayOwners {
  readonly pi: ExtensionAPI;
  readonly lifecycle: Lifecycle;
  readonly connection: Connection;
  readonly topics: TopicOwner;
}
interface SessionChoices {
  readonly current: SessionInfo;
  readonly peers: readonly SessionInfo[];
  readonly all: readonly SessionInfo[];
  readonly hidden: number;
}
function sentResult(
  result: Readonly<ComposeResult> | undefined | null,
): { readonly messageId: string; readonly text: string; readonly expectsReply: boolean } | null {
  if (result?.sent !== true) {
    return null;
  }
  const messageId = result.messageId ?? "";
  const text = result.text ?? "";
  return messageId === "" || text === ""
    ? null
    : { messageId, text, expectsReply: result.expectsReply === true };
}
export class IntercomOverlay {
  private readonly owners: OverlayOwners;
  constructor(owners: OverlayOwners) {
    this.owners = owners;
  }
  private notify(ctx: ExtensionContext, generation: number, message: string): void {
    this.owners.lifecycle.notify(ctx, message, "error", generation);
  }
  private async connect(
    ctx: ExtensionContext,
    generation: number,
  ): Promise<IntercomTransport | null> {
    try {
      return await this.owners.connection.ensure("overlay");
    } catch (error) {
      this.notify(ctx, generation, `Intercom unavailable: ${errorMessage(error)}`);
      return null;
    }
  }
  private async choices(
    active: IntercomTransport,
    scope: IntercomSessionScope,
  ): Promise<SessionChoices> {
    const id = active.sessionId;
    if (id === null || id === "") {
      throw new Error("Current intercom session id is unavailable.");
    }
    const all = await active.listSessions();
    const current = all.find((session) => session.id === id);
    if (!current) {
      throw new Error("Current session is missing from intercom session list");
    }
    const scoped = sessionsForScope(all, id, scope);
    return {
      current,
      peers: scoped.filter((session) => session.id !== id),
      all,
      hidden: all.length - scoped.length,
    };
  }
  private async select(
    ctx: ExtensionContext,
    choices: SessionChoices,
  ): Promise<SessionInfo | undefined | null> {
    return await ctx.ui
      .custom<SessionInfo | undefined>(
        (tui, theme, keybindings, done) =>
          new SessionListOverlay(tui, theme, {
            keybindings,
            currentSession: choices.current,
            sessions: choices.peers,
            done,
            hiddenSessionCount: choices.hidden,
            allSessions: choices.all,
          }),
        { overlay: true },
      )
      .catch(() => null);
  }
  private async compose(
    ctx: ExtensionContext,
    active: IntercomTransport,
    selected: SessionInfo,
    all: readonly SessionInfo[],
  ): Promise<ComposeResult | undefined | null> {
    return await ctx.ui
      .custom<ComposeResult>(
        (tui, theme, keybindings, done) =>
          new ComposeOverlay(tui, theme, {
            keybindings,
            target: selected,
            targetLabel: targetDisplayName(selected, all),
            client: active,
            done,
          }),
        { overlay: true },
      )
      .catch(() => null);
  }
  private async choose(
    ctx: ExtensionContext,
    scope: IntercomSessionScope,
    generation: number,
  ): Promise<{ readonly selected: SessionInfo; readonly all: readonly SessionInfo[] } | null> {
    const active = await this.connect(ctx, generation);
    if (!active || !this.owners.lifecycle.live(ctx, generation)) {
      return null;
    }
    this.owners.connection.syncIdentity(ctx.sessionManager.getSessionId());
    let choices: SessionChoices;
    try {
      choices = await this.choices(active, scope);
    } catch (error) {
      this.notify(ctx, generation, `Failed to list sessions: ${errorMessage(error)}`);
      return null;
    }
    if (!this.owners.lifecycle.live(ctx, generation)) {
      return null;
    }
    const selected = await this.select(ctx, choices);
    return selected ? { selected, all: choices.all } : null;
  }
  private record(
    ctx: ExtensionContext,
    generation: number,
    sent: { readonly messageId: string; readonly text: string; readonly expectsReply: boolean },
    selection: { readonly selected: SessionInfo; readonly all: readonly SessionInfo[] },
  ): void {
    if (!this.owners.lifecycle.live(ctx, generation)) {
      return;
    }
    const { selected, all } = selection;
    this.owners.pi.appendEntry("intercom_sent", {
      to: selected.name === undefined || selected.name === "" ? selected.id : selected.name,
      message: { text: sent.text, expectsReply: sent.expectsReply },
      messageId: sent.messageId,
      timestamp: Date.now(),
    });
    this.owners.lifecycle.notify(
      ctx,
      `${sent.expectsReply ? "Ask sent" : "Message sent"} to ${targetDisplayName(selected, all)}`,
      "info",
      generation,
    );
  }
  async open(ctx: ExtensionContext, scope: IntercomSessionScope = "project"): Promise<void> {
    const generation = this.owners.lifecycle.generation;
    const live = this.owners.lifecycle.live(ctx, generation);
    if (!live || !live.hasUI || live.mode !== "tui") {
      return;
    }
    const selection = await this.choose(ctx, scope, generation);
    if (!selection || !this.owners.lifecycle.live(ctx, generation)) {
      return;
    }
    const active = await this.connect(ctx, generation);
    if (!active || !this.owners.lifecycle.live(ctx, generation)) {
      return;
    }
    const sent = sentResult(await this.compose(ctx, active, selection.selected, selection.all));
    if (sent) {
      this.record(ctx, generation, sent, selection);
    }
  }
  private async topics(ctx: ExtensionContext): Promise<void> {
    const generation = this.owners.lifecycle.generation;
    let notice: string | undefined;
    try {
      const active = await this.owners.connection.ensure("overlay");
      if (!active.supportsTopics) {
        notice = TOPICS_UNAVAILABLE;
        this.owners.topics.disconnected();
      } else {
        const sessions = await active.listSessions();
        if (this.owners.lifecycle.live(ctx, generation)) {
          this.owners.topics.refresh(sessions);
        }
      }
    } catch {
      if (this.owners.lifecycle.live(ctx, generation)) {
        this.owners.topics.disconnected();
        notice = "Broker unavailable; last saved topic records follow.";
      }
    }
    if (this.owners.lifecycle.live(ctx, generation) && ctx.mode === "tui") {
      await this.owners.topics.open(ctx, notice);
    }
  }
  register(shortcut: Parameters<ExtensionAPI["registerShortcut"]>[0]): void {
    this.owners.pi.registerCommand("intercom", {
      description:
        "Open peer messaging; 'all' includes other projects, 'topics' inspects quiet topic/owner state",
      handler: async (args, ctx) => {
        const scope = args.trim();
        if (scope === "topics") {
          await this.topics(ctx);
          return;
        }
        if (scope !== "" && scope !== "all") {
          ctx.ui.notify("Usage: /intercom [all|topics]", "warning");
          return;
        }
        await this.open(ctx, scope === "all" ? "all" : "project");
      },
    });
    this.owners.pi.registerShortcut(shortcut, {
      description: "Toggle your agents, or open connected sessions",
      handler: async (ctx) => {
        // The event contract intentionally permits its owner to mark the request handled synchronously.
        const request = { ctx, handled: false };
        this.owners.pi.events.emit("subagent:open-agents", request);
        if (!request.handled) {
          await this.open(ctx);
        }
      },
    });
  }
}
