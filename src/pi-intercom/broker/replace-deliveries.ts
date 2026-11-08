import type { Message, SessionInfo } from "../types.ts";

const REPLACE_DELIVERY_DELAY_MS = 1500;

interface StagedDelivery {
  readonly fromId: string;
  readonly toId: string;
  readonly from: SessionInfo;
  readonly message: Message;
  readonly timer: NodeJS.Timeout;
}

/** Only broker-staged messages remain replaceable; forwarding ends this owner's authority. */
export class ReplaceDeliveries {
  private readonly pending = new Map<string, StagedDelivery>();
  private readonly deliver: (toId: string, from: SessionInfo, message: Message) => string | null;

  constructor(deliver: (toId: string, from: SessionInfo, message: Message) => string | null) {
    this.deliver = deliver;
  }

  stage(fromId: string, toId: string, from: SessionInfo, message: Message): void {
    const key = `${fromId}\0${toId}\0${message.threadId ?? ""}`;
    this.supersede(fromId, toId, message);
    const timer = setTimeout(() => this.flush(key), REPLACE_DELIVERY_DELAY_MS);
    timer.unref();
    this.pending.set(key, { fromId, toId, from, message, timer });
  }

  /** Call only after admission; rejected successors leave accepted input intact. */
  supersede(fromId: string, toId: string, message: Message): void {
    if (
      message.delivery === "queue" &&
      message.queueMode === "replace" &&
      message.threadId !== undefined &&
      message.threadId.length > 0
    ) {
      this.take(`${fromId}\0${toId}\0${message.threadId}`);
    }
  }

  private take(key: string): StagedDelivery | undefined {
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
    }
    return pending;
  }

  private flush(key: string): void {
    const pending = this.take(key);
    if (pending !== undefined) {
      this.deliver(pending.toId, pending.from, pending.message);
    }
  }

  disconnected(sessionId: string): void {
    for (const [key, pending] of this.pending) {
      if (
        pending.toId === sessionId ||
        (pending.fromId === sessionId && pending.message.expectsReply === true)
      ) {
        this.take(key);
      }
    }
  }
}
