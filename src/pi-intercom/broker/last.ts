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
}
interface PendingLast {
  readonly fromId: string;
  readonly toId: string;
  readonly requestId: string;
  readonly query: NativeReadQuery;
  readonly timer: NodeJS.Timeout;
}
function unavailable(
  targets: readonly LastPeer[],
  name: string,
  pending: number,
  query: NativeReadQuery,
): string | undefined {
  if (targets.length === 0) {
    return "Session not found";
  }
  if (targets.length > 1) {
    return `Multiple sessions named "${name}" are connected. Use the session ID instead.`;
  }
  if (!targets[0].lastMessages) {
    return "Recipient does not support last-message reads; reload its extension.";
  }
  if (
    "messageId" in query &&
    (!targets[0].receiptReads || targets[0].info.rootSessionId !== query.rootSessionId)
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

/** Correlation belongs to the broker, not the requester or the recipient's model queue. */
export class LastMessageRelay {
  private readonly pending = new Map<string, PendingLast>();
  private readonly sessions: ReadonlyMap<string, LastPeer>;
  constructor(sessions: ReadonlyMap<string, LastPeer>) {
    this.sessions = sessions;
  }

  request(fromId: string, message: UnknownRecord): void {
    if (
      typeof message.requestId !== "string" ||
      typeof message.to !== "string" ||
      !isNativeReadQuery(message.query)
    ) {
      throw new Error("Invalid last message request");
    }
    const targets = findSessions(this.sessions, message.to, fromId);
    const target = targets[0];
    const from = this.sessions.get(fromId);
    if (!from) {
      return;
    }
    const token = randomUUID();
    const frame = {
      type: "last_request" as const,
      requestId: token,
      from: messageSender(from.info),
      query: message.query,
    };
    const error =
      unavailable(targets, message.to, this.pending.size, message.query) ??
      validateIntercomMessageSize(frame)?.message;
    if (error !== undefined) {
      writeMessage(from.socket, {
        type: "last_response",
        requestId: message.requestId,
        result: { error },
      });
      return;
    }
    const timer = setTimeout(
      () => this.finish(token, { error: "Last-message read timed out" }),
      5000,
    );
    timer.unref();
    this.pending.set(token, {
      fromId,
      toId: target.info.id,
      requestId: message.requestId,
      query: message.query,
      timer,
    });
    try {
      writeMessage(target.socket, frame);
    } catch {
      this.finish(token, { error: "Recipient disconnected before last-message read" });
    }
  }

  respond(fromId: string, message: UnknownRecord): void {
    if (typeof message.requestId !== "string") {
      throw new Error("Invalid last message response");
    }
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.toId !== fromId) {
      return;
    }
    const result = message.result;
    this.finish(
      message.requestId,
      isNativeReadResult(result) && matchesPage(result, pending, fromId)
        ? result
        : { error: "Recipient returned an invalid last-message page" },
    );
  }

  disconnected(sessionId: string): void {
    for (const [token, pending] of this.pending) {
      if (pending.fromId === sessionId || pending.toId === sessionId) {
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
