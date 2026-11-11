import type { Message, SessionInfo } from "./types.ts";
import { formatSessionTarget, resolveSessionTarget, shortSessionId } from "./session-targets.ts";
import { RecoveryError } from "./tool-results.ts";

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

function matchingSender(
  contexts: readonly IntercomContext[],
  to: string,
): readonly IntercomContext[] {
  const tooShort = tooShortSenderTargetMessage(contexts, to);
  if (tooShort !== null && tooShort !== "") {
    throw new RecoveryError("ambiguous_reply_target", tooShort);
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
    throw new RecoveryError("no_pending_reply", `No pending ask with replyTo "${replyTo}"`);
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
  const [onlyMatch] = matches;
  if (matches.length === 1 && onlyMatch !== undefined) {
    return onlyMatch;
  }
  if (matches.length > 1) {
    throw new RecoveryError(
      "ambiguous_reply_target",
      `Multiple pending asks from "${to}" — use one of: ${pendingSenderOptions(matches, contexts)}.`,
    );
  }
  throw new RecoveryError("no_pending_reply", `No pending ask from "${to}"`);
}
export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnIds: string[] = [];
  /** The ask attributed to the current turn, or only to the active agent between turns. */
  private attribution:
    | { readonly kind: "none" }
    | { readonly kind: "turn"; readonly id: string }
    | { readonly kind: "agent"; readonly id: string } = { kind: "none" };
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

  queueTurnContext(messageId: string): void {
    if (!this.pendingAsks.has(messageId) || this.hasTurnContext(messageId)) {
      return;
    }
    this.pendingTurnIds.push(messageId);
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    const next = this.pendingTurnIds.shift();
    if (next !== undefined) {
      this.attribution = { kind: "turn", id: next };
    } else if (this.attribution.kind !== "none") {
      this.attribution = { kind: "agent", id: this.attribution.id };
    }
  }

  currentTurn(): IntercomContext | null {
    return this.attribution.kind === "none"
      ? null
      : (this.pendingAsks.get(this.attribution.id) ?? null);
  }

  endTurn(): void {
    if (this.attribution.kind === "turn") {
      this.attribution = { kind: "agent", id: this.attribution.id };
    }
  }

  endAgent(): void {
    this.attribution = { kind: "none" };
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnIds.length = 0;
    this.endAgent();
  }

  expireSender(sessionId: string): number {
    const expiring = new Set(
      [...this.pendingAsks.values()]
        .filter((context) => context.from.id === sessionId)
        .map((context) => context.message.id),
    );
    let expired = 0;
    for (const messageId of expiring) {
      this.pendingAsks.delete(messageId);
      expired += 1;
    }
    const beforeQueued = this.pendingTurnIds.length;
    for (let index = this.pendingTurnIds.length - 1; index >= 0; index -= 1) {
      const id = this.pendingTurnIds[index];
      if (id !== undefined && expiring.has(id)) {
        this.pendingTurnIds.splice(index, 1);
      }
    }
    expired += beforeQueued - this.pendingTurnIds.length;
    if (this.attribution.kind !== "none" && expiring.has(this.attribution.id)) {
      expired += this.attribution.kind === "turn" ? 2 : 1;
      this.attribution = { kind: "none" };
    }
    return expired;
  }

  resolveReplyTarget(
    options: { readonly to?: string | undefined; readonly replyTo?: string | undefined },
    now = Date.now(),
  ): IntercomContext {
    this.pruneExpired(now);

    const pending = Array.from(this.pendingAsks.values());
    const replyTo = options.replyTo ?? "";
    const to = options.to ?? "";
    if (replyTo !== "") {
      return explicitReply(pending, replyTo, to);
    }
    if (to !== "") {
      return replyBySender(pending, to);
    }
    return this.implicitReplyTarget(pending);
  }

  /** Without an explicit target, the turn context wins, then a sole pending ask. */
  private implicitReplyTarget(pending: readonly IntercomContext[]): IntercomContext {
    // Agent-only attribution does not pick an untargeted reply; it would bypass disambiguation.
    const current =
      this.attribution.kind === "turn" ? this.pendingAsks.get(this.attribution.id) : undefined;
    if (current !== undefined) {
      return current;
    }
    const [solePending] = pending;
    if (pending.length === 1 && solePending !== undefined) {
      return solePending;
    }
    if (pending.length === 0) {
      throw new RecoveryError("no_pending_reply", "No active intercom context to reply to");
    }
    throw new RecoveryError("ambiguous_reply_target", "Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.removeContext(replyTo);
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private hasTurnContext(messageId: string): boolean {
    return (
      this.pendingTurnIds.includes(messageId) ||
      (this.attribution.kind !== "none" && this.attribution.id === messageId)
    );
  }

  private removeContext(messageId: string): void {
    this.pendingAsks.delete(messageId);
    for (let index = this.pendingTurnIds.length - 1; index >= 0; index -= 1) {
      if (this.pendingTurnIds[index] === messageId) {
        this.pendingTurnIds.splice(index, 1);
      }
    }
    if (this.attribution.kind !== "none" && this.attribution.id === messageId) {
      this.attribution = { kind: "none" };
    }
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.removeContext(messageId);
      }
    }
  }
}
