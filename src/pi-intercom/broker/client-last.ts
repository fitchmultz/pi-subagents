import type net from "node:net";
import { randomUUID } from "node:crypto";
import { errorMessage, type UnknownRecord } from "../../shared/unknown.ts";
import {
  isNativeReadQuery,
  isNativeReadResult,
  isLastMessageResult,
  isReceiptResult,
  type NativeReadResult,
} from "./last.ts";
import type { LastMessageQuery, LastMessageResult, ReceiptQuery, ReceiptResult } from "../types.ts";
import { writeMessage } from "./framing.ts";

export class LastMessageRequests {
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
    if (!isNativeReadQuery(query)) {
      return Promise.reject(new Error("Invalid last-message query"));
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
