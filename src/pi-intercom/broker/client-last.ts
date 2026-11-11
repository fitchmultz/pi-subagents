import type net from "node:net";
import { randomUUID } from "node:crypto";
import { errorMessage, type UnknownRecord } from "../../shared/unknown.ts";
import {
  isNativeReadQuery,
  isNativeReadResult,
  isLastMessageResult,
  isReceiptResult,
  type NativeReadQuery,
  type NativeReadResult,
} from "./last.ts";
import {
  normalizeSessionInfo,
  type LastMessageQuery,
  type LastMessageResult,
  type ReceiptQuery,
  type ReceiptResult,
  type SessionInfo,
} from "../types.ts";
import { writeMessage } from "./framing.ts";
import { PendingRequests } from "./pending-requests.ts";

/** A peer's read of this session or, for a main, of its exited `parked` child. */
export function lastRequest(msg: UnknownRecord): {
  readonly requestId: string;
  readonly from: SessionInfo;
  readonly query: NativeReadQuery;
  readonly parked?: SessionInfo | undefined;
} {
  const from = normalizeSessionInfo(msg.from);
  if (typeof msg.requestId !== "string" || !from || !isNativeReadQuery(msg.query)) {
    throw new Error("Invalid last-message request");
  }
  return {
    requestId: msg.requestId,
    from,
    query: msg.query,
    parked: normalizeSessionInfo(msg.parked) ?? undefined,
  };
}

export class LastMessageRequests {
  private readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }
  private readonly pending = new PendingRequests<{
    readonly resolve: (result: NativeReadResult) => void;
    readonly reject: (error: Readonly<Error>) => void;
  }>();

  fail(error: Readonly<Error>): void {
    this.pending.fail(error);
  }

  receive(message: UnknownRecord): void {
    if (typeof message.requestId !== "string" || !isNativeReadResult(message.result)) {
      throw new Error("Invalid last-message response");
    }
    const pending = this.pending.take(message.requestId);
    if (!pending) {
      return;
    }
    pending.resolve(message.result);
  }

  async last(
    socket: net.Socket,
    to: string,
    query: LastMessageQuery,
    supported: ReadCapabilities,
  ): Promise<LastMessageResult> {
    const result = await this.request(socket, to, query, supported);
    return isLastMessageResult(result) ? result : { error: "Invalid last-message response" };
  }
  async receipt(
    socket: net.Socket,
    to: string,
    query: ReceiptQuery,
    supported: ReadCapabilities,
  ): Promise<ReceiptResult> {
    const result = await this.request(socket, to, query, supported);
    return isReceiptResult(result) ? result : { error: "Invalid receipt response" };
  }
  private request(
    socket: net.Socket,
    to: string,
    query: unknown,
    supported: ReadCapabilities,
  ): Promise<NativeReadResult> {
    if (!supported.lastMessages) {
      return Promise.reject(
        new Error("This broker does not support last-message reads; reload after it exits."),
      );
    }
    if (!isNativeReadQuery(query)) {
      return Promise.reject(new Error("Invalid last-message query"));
    }
    if ("messageId" in query && !supported.receiptReads) {
      return Promise.reject(new Error("publication_unavailable"));
    }
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      this.pending.set(
        requestId,
        { resolve, reject },
        this.timeoutMs,
        () => new Error("Last-message read timeout"),
      );
      try {
        writeMessage(socket, { type: "last_request", requestId, to, query });
      } catch (error) {
        this.pending.take(requestId)?.reject(new Error(errorMessage(error)));
      }
    });
  }
}
/** What a broker advertised in its registration for read-only history. */
export interface ReadCapabilities {
  readonly lastMessages: boolean;
  readonly receiptReads: boolean;
}
