import { randomUUID } from "node:crypto";
import type { Message, SendResult, SessionInfo } from "./types.ts";
import { Fault } from "./bridge-protocol.ts";

export interface Envelope {
  readonly from: SessionInfo;
  readonly message: Message;
}

/** Owns correlation, the early rejection observer and the outgoing ask deadline. */
export class WaitingAsk {
  readonly id = randomUUID();
  readonly reply: Promise<Envelope>;
  private readonly resolveReply: (reply: Envelope) => void;
  private readonly rejectReply: (error: Readonly<Error>) => void;
  private timer?: NodeJS.Timeout;
  peer?: string;
  private settledState = false;
  receipt?: SendResult;

  constructor() {
    const { promise, resolve, reject } = Promise.withResolvers<Envelope>();
    this.reply = promise;
    this.resolveReply = resolve;
    this.rejectReply = reject;
    promise.catch(() => {
      // Consume early rejection during lookup/ack; the request later awaits the original reply.
    });
  }
  get settled(): boolean {
    return this.settledState;
  }
  resolve(answer: Envelope): void {
    this.settledState = true;
    this.clear();
    this.resolveReply(answer);
  }
  reject(error: Readonly<Error>): void {
    this.settledState = true;
    this.clear();
    this.rejectReply(error);
  }
  matches(peer: string, replyTo?: string): boolean {
    return !this.settled && this.id === replyTo && this.peer === peer;
  }
  clear(): void {
    clearTimeout(this.timer);
  }
  deadline(timeoutMs: number, close: (error: Readonly<Fault>) => void): void {
    this.timer = setTimeout(() => {
      const fault = new Fault(504, "ask_timeout", "Peer did not reply before the ask deadline.", {
        id: this.id,
        ...(this.receipt
          ? { accepted: this.receipt.accepted, delivered: this.receipt.delivered }
          : { deliveryUnknown: true }),
      });
      if (this.receipt) {
        this.reject(fault);
      } else {
        close(fault);
      }
    }, timeoutMs);
  }
}
