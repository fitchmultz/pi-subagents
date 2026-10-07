import type { Message, SessionInfo } from "./types.ts";
import { formatSessionTarget, resolveSessionTarget, shortSessionId } from "./session-targets.ts";

export interface IntercomContext {
  readonly from: SessionInfo;
  readonly message: Message;
  readonly receivedAt: number;
}

function resolveBySenderTarget(
  contexts: readonly IntercomContext[],
  to: string,
): IntercomContext[] {
  const sessions = contexts.map((context) => context.from);
  const resolution = resolveSessionTarget(sessions, to);
  if (resolution.status === "none" || resolution.status === "prefix_too_short") {
    return [];
  }
  const matchingIds = new Set(resolution.matches.map((session) => session.id));
  return contexts.filter((context) => matchingIds.has(context.from.id));
}

function tooShortSenderTargetMessage(
  contexts: readonly IntercomContext[],
  to: string,
): string | null {
  const resolution = resolveSessionTarget(
    contexts.map((context) => context.from),
    to,
  );
  if (resolution.status !== "prefix_too_short") {
    return null;
  }
  const matchingIds = new Set(resolution.matches.map((session) => session.id));
  const matches = contexts.filter((context) => matchingIds.has(context.from.id));
  return `Pending ask target "${to}" is too short. Use one of: ${pendingSenderOptions(matches, contexts)}.`;
}

function pendingSenderOptions(
  contexts: readonly IntercomContext[],
  allContexts: readonly IntercomContext[] = contexts,
): string {
  const allSenders = allContexts.map((context) => context.from);
  return contexts
    .map(
      (context) =>
        `${context.from.name === undefined || context.from.name === "" ? shortSessionId(context.from.id) : context.from.name}: to: ${JSON.stringify(formatSessionTarget(context.from, allSenders))} or replyTo: ${JSON.stringify(context.message.id)}`,
    )
    .join(", ");
}

export function isDurableSupervisorQuestion(message: Message): boolean {
  return message.content.text.includes(`Question ID: ${message.id}`);
}

function matchingSender(
  contexts: readonly IntercomContext[],
  to: string,
): readonly IntercomContext[] {
  const tooShort = tooShortSenderTargetMessage(contexts, to);
  if (tooShort !== null && tooShort !== "") {
    throw new Error(tooShort);
  }
  return resolveBySenderTarget(contexts, to);
}
function explicitReply(
  contexts: readonly IntercomContext[],
  replyTo: string,
  to: string,
): IntercomContext {
  const target = contexts.find((context) => context.message.id === replyTo);
  if (!target) {
    throw new Error(`No pending ask with replyTo "${replyTo}"`);
  }
  if (
    to !== "" &&
    !matchingSender(contexts, to).some((context) => context.message.id === target.message.id)
  ) {
    throw new Error(`Pending ask "${replyTo}" is not from "${to}"`);
  }
  return target;
}
function replyBySender(contexts: readonly IntercomContext[], to: string): IntercomContext {
  const matches = matchingSender(contexts, to);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple pending asks from "${to}" — use one of: ${pendingSenderOptions(matches, contexts)}.`,
    );
  }
  throw new Error(`No pending ask from "${to}"`);
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

  recordIncomingMessage(
    from: SessionInfo,
    message: Message,
    receivedAt = Date.now(),
  ): IntercomContext {
    const context = { from, message, receivedAt };
    if (message.expectsReply === true) {
      this.pruneExpired(receivedAt);
      this.pendingAsks.set(message.id, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    if (context.message.expectsReply !== true) {
      return;
    }
    if (this.hasTurnContext(context.message.id)) {
      return;
    }
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
    const expires = (context: IntercomContext) =>
      context.from.id === sessionId && !isDurableSupervisorQuestion(context.message);
    let expired = 0;
    for (const [messageId, context] of this.pendingAsks) {
      if (expires(context)) {
        this.pendingAsks.delete(messageId);
        expired += 1;
      }
    }
    const beforeQueued = this.pendingTurnContexts.length;
    for (let index = this.pendingTurnContexts.length - 1; index >= 0; index -= 1) {
      const context = this.pendingTurnContexts[index];
      if (expires(context)) {
        this.pendingTurnContexts.splice(index, 1);
      }
    }
    expired += beforeQueued - this.pendingTurnContexts.length;
    if (this.currentTurnContext && expires(this.currentTurnContext)) {
      this.currentTurnContext = null;
      expired += 1;
    }
    if (this.activeAgentContext && expires(this.activeAgentContext)) {
      this.activeAgentContext = null;
      expired += 1;
    }
    return expired;
  }

  resolveReplyTarget(
    options: { readonly to?: string; readonly replyTo?: string },
    now = Date.now(),
  ): IntercomContext {
    this.pruneExpired(now);

    const pending = Array.from(this.pendingAsks.values());
    const contexts = this.currentTurnContext
      ? [
          this.currentTurnContext,
          ...pending.filter(
            (context) => context.message.id !== this.currentTurnContext?.message.id,
          ),
        ]
      : pending;

    const replyTo = options.replyTo ?? "";
    const to = options.to ?? "";
    if (replyTo !== "") {
      return explicitReply(contexts, replyTo, to);
    }
    if (to !== "") {
      return replyBySender(contexts, to);
    }
    if (this.currentTurnContext) {
      return this.currentTurnContext;
    }
    if (pending.length === 1) {
      return pending[0];
    }
    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }
    throw new Error("Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.removeContext(replyTo);
  }

  get hasReplyContext(): boolean {
    return (
      this.pendingAsks.size > 0 ||
      this.pendingTurnContexts.length > 0 ||
      this.currentTurnContext !== null ||
      this.activeAgentContext !== null
    );
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private hasTurnContext(messageId: string): boolean {
    return (
      this.pendingTurnContexts.some((context) => context.message.id === messageId) ||
      this.currentTurnContext?.message.id === messageId ||
      this.activeAgentContext?.message.id === messageId
    );
  }

  private removeContext(messageId: string): void {
    this.pendingAsks.delete(messageId);
    for (let index = this.pendingTurnContexts.length - 1; index >= 0; index -= 1) {
      if (this.pendingTurnContexts[index]?.message.id === messageId) {
        this.pendingTurnContexts.splice(index, 1);
      }
    }
    if (this.currentTurnContext?.message.id === messageId) {
      this.currentTurnContext = null;
    }
    if (this.activeAgentContext?.message.id === messageId) {
      this.activeAgentContext = null;
    }
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (
        !isDurableSupervisorQuestion(context.message) &&
        now - context.receivedAt > this.askTimeoutMs
      ) {
        this.removeContext(messageId);
      }
    }
  }
}
