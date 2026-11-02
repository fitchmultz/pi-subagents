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
  /** Negotiated at registration; a failed connection supports neither. */
  lastMessages = false;
  receiptReads = false;
  private readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }
  private readonly pending = new Map<
    string,
    {
      readonly resolve: (result: NativeReadResult) => void;
      readonly reject: (error: Readonly<Error>) => void;
      readonly timer: NodeJS.Timeout;
    }
  >();

  fail(error: Readonly<Error>): void {
    this.lastMessages = false;
    this.receiptReads = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  receive(message: UnknownRecord): void {
    if (typeof message.requestId !== "string" || !isNativeReadResult(message.result)) {
      throw new Error("Invalid last-message response");
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message.result);
  }

  async last(socket: net.Socket, to: string, query: LastMessageQuery): Promise<LastMessageResult> {
    const result = await this.request(socket, to, query);
    return isLastMessageResult(result) ? result : { error: "Invalid last-message response" };
  }
  async receipt(socket: net.Socket, to: string, query: ReceiptQuery): Promise<ReceiptResult> {
    const result = await this.request(socket, to, query);
    return isReceiptResult(result) ? result : { error: "Invalid receipt response" };
  }
  private request(socket: net.Socket, to: string, query: unknown): Promise<NativeReadResult> {
    if (!this.lastMessages) {
      return Promise.reject(
        new Error("This broker does not support last-message reads; reload after it exits."),
      );
    }
    if (!isNativeReadQuery(query)) {
      return Promise.reject(new Error("Invalid last-message query"));
    }
    if ("messageId" in query && !this.receiptReads) {
      return Promise.reject(new Error("publication_unavailable"));
    }
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Last-message read timeout"));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        writeMessage(socket, { type: "last_request", requestId, to, query });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error(errorMessage(error)));
      }
    });
  }
}
