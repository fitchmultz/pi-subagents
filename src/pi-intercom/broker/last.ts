import type net from "node:net";
import { randomUUID } from "node:crypto";
import { isRecord, type UnknownRecord } from "../../shared/unknown.ts";
import {
  isDeliveryGuard,
  isPublicationReplyHint,
  isLastMessageQuery,
  isReceiptQuery,
  LAST_MESSAGE_PAGE_LIMIT,
  normalizeSessionInfo,
  type LastMessageQuery,
  type LastMessageResult,
  type SessionInfo,
  type NativeReceipt,
  type ReceiptQuery,
  type ReceiptResult,
} from "../types.ts";
import { finiteNumber, nonNegativeInteger, optionalLabel, safeLabel } from "../validation.ts";
import { validateIntercomMessageSize, writeMessage } from "./framing.ts";
import { messageSender } from "./snapshots.ts";
import { findSessions } from "./targets.ts";

export type NativeReadQuery = LastMessageQuery | ReceiptQuery;
export type NativeReadResult = LastMessageResult | ReceiptResult;

export function isNativeReadQuery(value: unknown): value is NativeReadQuery {
  return isReceiptQuery(value) || isLastMessageQuery(value);
}
function isNativeReceipt(value: unknown): value is NativeReceipt {
  if (!isReceiptQuery(value) || !isRecord(value) || !isRecord(value.sender)) {
    return false;
  }
  return (
    value.version === 1 &&
    safeLabel(value.sender.peerId) &&
    [value.sender.rootSessionId, value.sender.incarnation].every(optionalLabel) &&
    typeof value.textSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.textSha256) &&
    receiptPublication(value) &&
    receiptFacts(value)
  );
}
function receiptPublication(value: UnknownRecord): boolean {
  return (
    typeof value.delivery === "string" &&
    ["queue", "steer", "passive"].includes(value.delivery) &&
    (value.guard === undefined || isDeliveryGuard(value.guard)) &&
    (value.replyHint === undefined || isPublicationReplyHint(value.replyHint))
  );
}
function receiptFacts(value: UnknownRecord): boolean {
  return (
    safeLabel(value.checkpointEntryId) &&
    finiteNumber(value.receivedAt) &&
    [value.queued, value.nativeHandoff, value.discarded].every(
      (field) => typeof field === "boolean",
    ) &&
    (value.placementEntryId === null || safeLabel(value.placementEntryId))
  );
}
export function isReceiptResult(value: unknown): value is ReceiptResult {
  return isRecord(value) && (typeof value.error === "string" || isNativeReceipt(value.receipt));
}
export function isNativeReadResult(value: unknown): value is NativeReadResult {
  return isReceiptResult(value) || isLastMessageResult(value);
}
function pageIdentity(value: UnknownRecord): boolean {
  return (
    normalizeSessionInfo(value.session) !== null &&
    (value.entryId === null || (typeof value.entryId === "string" && value.entryId.length > 0)) &&
    typeof value.text === "string" &&
    value.text.length <= LAST_MESSAGE_PAGE_LIMIT
  );
}
function pageOffsets(value: UnknownRecord): boolean {
  if (
    !nonNegativeInteger(value.offset) ||
    !nonNegativeInteger(value.totalLength) ||
    typeof value.text !== "string"
  ) {
    return false;
  }
  const end = value.offset + value.text.length;
  if (value.entryId === null) {
    return end === 0 && value.totalLength === 0 && value.nextOffset === undefined;
  }
  if (value.nextOffset === undefined) {
    return end === value.totalLength;
  }
  return value.nextOffset === end && end < value.totalLength && value.text.length > 0;
}
export function isLastMessageResult(value: unknown): value is LastMessageResult {
  return (
    isRecord(value) &&
    (typeof value.error === "string" || (pageIdentity(value) && pageOffsets(value)))
  );
}
interface LastPeer {
  readonly socket: net.Socket;
  readonly info: SessionInfo;
  readonly lastMessages: boolean;
  readonly receiptReads: boolean;
  readonly parked?: { readonly closed: boolean } | undefined;
}
interface PendingLast {
  readonly fromId: string;
  readonly toId: string;
  /** A parked child's main answers from the child's captured native history. */
  readonly via?: string | undefined;
  readonly requestId: string;
  readonly query: NativeReadQuery;
  readonly timer: NodeJS.Timeout;
}
/** An exited parked child answers nothing itself; only its main holds the captured history. */
function exitedRefusal(
  target: LastPeer,
  query: NativeReadQuery,
  via?: LastPeer,
): string | undefined {
  if (target.parked?.closed !== true) {
    return undefined;
  }
  // No loaded journal owner answers receipts, with or without its main.
  if ("messageId" in query) {
    return "publication_unavailable";
  }
  return via === undefined ? "Parked session history is unavailable." : undefined;
}
function unavailable(
  targets: readonly LastPeer[],
  name: string,
  pending: number,
  { query, via }: { readonly query: NativeReadQuery; readonly via?: LastPeer | undefined },
): string | undefined {
  const [target] = targets;
  if (target === undefined) {
    return "Session not found";
  }
  if (targets.length > 1) {
    return `Multiple sessions named "${name}" are connected. Use the session ID instead.`;
  }
  const exited = exitedRefusal(target, query, via);
  if (exited !== undefined) {
    return exited;
  }
  if (!target.lastMessages) {
    return "Recipient does not support last-message reads; reload its extension.";
  }
  if (
    "messageId" in query &&
    (!target.receiptReads || target.info.rootSessionId !== query.rootSessionId)
  ) {
    return "publication_unavailable";
  }
  if (pending >= 128) {
    return "Too many pending last-message reads; retry after they settle.";
  }
  return undefined;
}
function matchesPage(result: NativeReadResult, pending: PendingLast, fromId: string): boolean {
  if ("error" in result) {
    return true;
  }
  if ("messageId" in pending.query) {
    return (
      "receipt" in result &&
      result.receipt.messageId === pending.query.messageId &&
      result.receipt.rootSessionId === pending.query.rootSessionId
    );
  }
  if ("receipt" in result) {
    return false;
  }
  return matchesLastPage(result, pending.query, fromId);
}

function matchesLastPage(
  result: Exclude<LastMessageResult, { readonly error: string }>,
  query: LastMessageQuery,
  fromId: string,
): boolean {
  return (
    result.session.id === fromId &&
    result.offset === (query.offset ?? 0) &&
    (query.entryId === undefined || result.entryId === query.entryId) &&
    result.text.length <= (query.limit ?? LAST_MESSAGE_PAGE_LIMIT)
  );
}

function lastRequest(message: UnknownRecord): {
  readonly requestId: string;
  readonly to: string;
  readonly query: NativeReadQuery;
} {
  const { requestId, to, query } = message;
  if (typeof requestId !== "string" || typeof to !== "string" || !isNativeReadQuery(query)) {
    throw new Error("Invalid last message request");
  }
  return { requestId, to, query };
}
/** Correlation belongs to the broker, not the requester or the recipient's model queue. */
export class LastMessageRelay {
  private readonly pending = new Map<string, PendingLast>();
  private readonly sessions: ReadonlyMap<string, LastPeer>;
  constructor(sessions: ReadonlyMap<string, LastPeer>) {
    this.sessions = sessions;
  }

  /** `reader` names another peer that answers for an exited target from its captured history. */
  request(
    fromId: string,
    input: UnknownRecord,
    reader: (id: string) => LastPeer | undefined,
  ): void {
    const message = lastRequest(input);
    const targets = findSessions(this.sessions, message.to, fromId);
    const from = this.sessions.get(fromId);
    if (!from) {
      return;
    }
    const token = randomUUID();
    const delegated = this.delegatedReader(targets, reader);
    const via = delegated?.via;
    const frame = {
      type: "last_request" as const,
      requestId: token,
      from: messageSender(from.info),
      query: message.query,
      parked: delegated === undefined ? undefined : messageSender(delegated.target.info),
    };
    const error =
      unavailable(targets, message.to, this.pending.size, { query: message.query, via }) ??
      validateIntercomMessageSize(frame)?.message;
    if (error !== undefined) {
      writeMessage(from.socket, {
        type: "last_response",
        requestId: message.requestId,
        result: { error },
      });
      return;
    }
    const [recipient] = targets;
    if (recipient === undefined) {
      return;
    }
    this.forward(
      { token, fromId, requestId: message.requestId, query: message.query },
      recipient,
      via,
      frame,
    );
  }

  /** Register the correlated wait, then forward the read to the reader or the recipient. */
  private forward(
    wait: {
      readonly token: string;
      readonly fromId: string;
      readonly requestId: string;
      readonly query: NativeReadQuery;
    },
    recipient: LastPeer,
    via: LastPeer | undefined,
    frame: {
      readonly type: "last_request";
      readonly requestId: string;
      readonly from: SessionInfo;
      readonly query: NativeReadQuery;
      readonly parked?: SessionInfo | undefined;
    },
  ): void {
    const timer = setTimeout(
      () => this.finish(wait.token, { error: "Last-message read timed out" }),
      5000,
    );
    timer.unref();
    this.pending.set(wait.token, {
      fromId: wait.fromId,
      toId: recipient.info.id,
      via: via?.info.id,
      requestId: wait.requestId,
      query: wait.query,
      timer,
    });
    try {
      writeMessage((via ?? recipient).socket, frame);
    } catch {
      this.finish(wait.token, { error: "Recipient disconnected before last-message read" });
    }
  }

  /** A sole matched target may delegate the read to another peer's captured history. */
  private delegatedReader(
    targets: readonly LastPeer[],
    reader: (id: string) => LastPeer | undefined,
  ): { readonly target: LastPeer; readonly via: LastPeer } | undefined {
    const [target] = targets;
    if (targets.length !== 1 || target === undefined) {
      return undefined;
    }
    const via = reader(target.info.id);
    return via === undefined ? undefined : { target, via };
  }

  respond(fromId: string, message: UnknownRecord): void {
    if (typeof message.requestId !== "string") {
      throw new Error("Invalid last message response");
    }
    const pending = this.pending.get(message.requestId);
    if (!pending || (pending.via ?? pending.toId) !== fromId) {
      return;
    }
    const result = message.result;
    this.finish(
      message.requestId,
      isNativeReadResult(result) && matchesPage(result, pending, pending.toId)
        ? result
        : { error: "Recipient returned an invalid last-message page" },
    );
  }

  disconnected(sessionId: string): void {
    for (const [token, pending] of this.pending) {
      if ([pending.fromId, pending.toId, pending.via].includes(sessionId)) {
        this.finish(token, { error: "Peer disconnected during last-message read" });
      }
    }
  }

  private finish(token: string, result: NativeReadResult): void {
    const pending = this.pending.get(token);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(token);
    const from = this.sessions.get(pending.fromId);
    if (!from) {
      return;
    }
    const frame = { type: "last_response" as const, requestId: pending.requestId, result };
    const invalid = validateIntercomMessageSize(frame);
    writeMessage(
      from.socket,
      invalid
        ? {
            type: "last_response",
            requestId: pending.requestId,
            result: { error: invalid.message },
          }
        : frame,
    );
  }
}
