import type { Message, SessionInfo } from "./types.ts";
import { formatSessionTarget, resolveSessionTarget, shortSessionId } from "./session-targets.ts";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
}

function resolveBySenderTarget(contexts: IntercomContext[], to: string): IntercomContext[] {
  const sessions = contexts.map((context) => context.from);
  const resolution = resolveSessionTarget(sessions, to);
  if (resolution.status === "none" || resolution.status === "prefix_too_short") {
    return [];
  }
  const matchingIds = new Set(resolution.matches.map((session) => session.id));
  return contexts.filter((context) => matchingIds.has(context.from.id));
}

function tooShortSenderTargetMessage(contexts: IntercomContext[], to: string): string | null {
  const resolution = resolveSessionTarget(contexts.map((context) => context.from), to);
  if (resolution.status !== "prefix_too_short") {
    return null;
  }
  const matchingIds = new Set(resolution.matches.map((session) => session.id));
  const matches = contexts.filter((context) => matchingIds.has(context.from.id));
  return `Pending ask target "${to}" is too short. Use one of: ${pendingSenderOptions(matches, contexts)}.`;
}

function pendingSenderOptions(contexts: IntercomContext[], allContexts: IntercomContext[] = contexts): string {
  const allSenders = allContexts.map((context) => context.from);
  return contexts
    .map((context) => `${context.from.name || shortSessionId(context.from.id)}: to: ${JSON.stringify(formatSessionTarget(context.from, allSenders))} or replyTo: ${JSON.stringify(context.message.id)}`)
    .join(", ");
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[] = [];
  private currentTurnContext: IntercomContext | null = null;
  private activeAgentContext: IntercomContext | null = null;
  private readonly askTimeoutMs: number;

  constructor(askTimeoutMs = 10 * 60 * 1000) {
    this.askTimeoutMs = askTimeoutMs;
  }

  recordIncomingMessage(from: SessionInfo, message: Message, receivedAt = Date.now()): IntercomContext {
    const context = { from, message, receivedAt };
    if (message.expectsReply) {
      this.pruneExpired(receivedAt);
      this.pendingAsks.set(message.id, context);
      while (this.pendingAsks.size > 100) this.pendingAsks.delete(this.pendingAsks.keys().next().value!);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    if (!context.message.expectsReply) return;
    this.pendingTurnContexts.push(context);
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
    if (this.currentTurnContext) {
      this.activeAgentContext = this.currentTurnContext;
    }
  }

  currentTurn(): IntercomContext | null {
    return this.currentTurnContext ?? this.activeAgentContext;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  endAgent(): void {
    this.currentTurnContext = null;
    this.activeAgentContext = null;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
    this.activeAgentContext = null;
  }

  expireSender(sessionId: string): number {
    let expired = 0;
    for (const [messageId, context] of this.pendingAsks) {
      if (context.from.id === sessionId) {
        this.pendingAsks.delete(messageId);
        expired += 1;
      }
    }
    const beforeQueued = this.pendingTurnContexts.length;
    for (let index = this.pendingTurnContexts.length - 1; index >= 0; index -= 1) {
      if (this.pendingTurnContexts[index]?.from.id === sessionId) {
        this.pendingTurnContexts.splice(index, 1);
      }
    }
    expired += beforeQueued - this.pendingTurnContexts.length;
    if (this.currentTurnContext?.from.id === sessionId) {
      this.currentTurnContext = null;
      expired += 1;
    }
    if (this.activeAgentContext?.from.id === sessionId) {
      this.activeAgentContext = null;
      expired += 1;
    }
    return expired;
  }

  resolveReplyTarget(options: { to?: string; replyTo?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    const pending = Array.from(this.pendingAsks.values());
    const contexts = this.currentTurnContext
      ? [this.currentTurnContext, ...pending.filter((context) => context.message.id !== this.currentTurnContext?.message.id)]
      : pending;

    if (options.replyTo) {
      const target = contexts.find((context) => context.message.id === options.replyTo);
      if (!target) {
        throw new Error(`No pending ask with replyTo "${options.replyTo}"`);
      }
      if (options.to) {
        const tooShortMessage = tooShortSenderTargetMessage(contexts, options.to);
        if (tooShortMessage) {
          throw new Error(tooShortMessage);
        }
        const senderMatches = resolveBySenderTarget(contexts, options.to);
        if (!senderMatches.some((context) => context.message.id === target.message.id)) {
          throw new Error(`Pending ask "${options.replyTo}" is not from "${options.to}"`);
        }
      }
      return target;
    }

    if (options.to) {
      const tooShortMessage = tooShortSenderTargetMessage(contexts, options.to);
      if (tooShortMessage) {
        throw new Error(tooShortMessage);
      }
      const matches = resolveBySenderTarget(contexts, options.to);
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks from \"${options.to}\" — use one of: ${pendingSenderOptions(matches, contexts)}.`);
      }
      throw new Error(`No pending ask from \"${options.to}\"`);
    }

    if (this.currentTurnContext) {
      return this.currentTurnContext;
    }

    if (pending.length === 1) {
      return pending[0]!;
    }

    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }

    throw new Error("Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
    if (this.activeAgentContext?.message.id === replyTo) {
      this.activeAgentContext = null;
    }
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.pendingAsks.delete(messageId);
      }
    }
  }
}
