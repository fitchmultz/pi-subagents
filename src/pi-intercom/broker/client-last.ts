import type net from "node:net";
import { randomUUID } from "node:crypto";
import { errorMessage, type UnknownRecord } from "../../shared/unknown.ts";
import type { LastMessageResult } from "../types.ts";
import { isLastMessageQuery, isLastMessageResult } from "./last.ts";
import { writeMessage } from "./framing.ts";

export class LastMessageRequests {
  private readonly pending = new Map<
    string,
    {
      readonly resolve: (result: LastMessageResult) => void;
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
    if (typeof message.requestId !== "string" || !isLastMessageResult(message.result)) {
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

  request(
    socket: net.Socket,
    to: string,
    query: unknown,
    timeoutMs: number,
  ): Promise<LastMessageResult> {
    if (!isLastMessageQuery(query)) {
      return Promise.reject(new Error("Invalid last-message query"));
    }
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Last-message read timeout"));
      }, timeoutMs);
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
