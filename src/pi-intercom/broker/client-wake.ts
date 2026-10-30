import type net from "node:net";
import type { EventEmitter } from "node:events";
import type { WakeResult } from "../types.ts";
import type { UnknownRecord } from "../../shared/unknown.ts";
import { validateIntercomMessageSize, writeMessage } from "./framing.ts";

/** Negotiated wake outcomes; old brokers and clients keep the original wake event. */
export class WakeMessages {
  supported = false;
  private readonly events: EventEmitter;
  private readonly socket: () => net.Socket;
  constructor(events: EventEmitter, socket: () => net.Socket) {
    this.events = events;
    this.socket = socket;
  }
  registration(): { wakeResults?: 1; wakeNotices?: 1 } {
    return {
      ...(this.events.listenerCount("wake_request") > 0 ? { wakeResults: 1 } : {}),
      ...(this.events.listenerCount("wake_failed") > 0 ? { wakeNotices: 1 } : {}),
    };
  }
  receive(msg: UnknownRecord): void {
    if (msg.type === "wake_registered") {
      if (typeof msg.requestId !== "string") {
        throw new Error("Invalid wake registration");
      }
      this.events.emit("wake_registered", msg.requestId);
      return;
    }
    if (typeof msg.sessionId !== "string") {
      throw new Error("Invalid wake message");
    }
    if (msg.type === "wake") {
      if (this.supported && typeof msg.requestId === "string") {
        this.events.emit("wake_request", msg.sessionId, msg.requestId);
      } else {
        this.events.emit("wake", msg.sessionId);
      }
      return;
    }
    if (typeof msg.messageId !== "string" || typeof msg.reason !== "string") {
      throw new Error("Invalid wake failure");
    }
    this.events.emit("wake_failed", msg.sessionId, msg.messageId, msg.reason);
  }
  respond(requestId: string, result: WakeResult): void {
    if (!this.supported) {
      return;
    }
    const frame = { type: "wake_result", requestId, result };
    writeMessage(
      this.socket(),
      validateIntercomMessageSize(frame) === null
        ? frame
        : {
            ...frame,
            result: { status: "failed", reason: "Wake failed; inspect the agent run for details." },
          },
    );
  }
}
