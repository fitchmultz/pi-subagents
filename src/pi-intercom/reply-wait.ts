import type { Message } from "./types.ts";
import type { IntercomClient, SendResult } from "./broker/client.ts";
import type { IntercomTransport } from "./transport.ts";
import type { IntercomLifecycle } from "./lifecycle.ts";
import { asError } from "./validation.ts";
import { AskDeliveryError, RecoveryError } from "./tool-results.ts";

type Lifecycle = Readonly<Pick<IntercomLifecycle, "markActivity">>;
interface ReplyWaiter {
  readonly from: string;
  readonly replyTo: string;
  readonly resolve: (message: Message) => void;
  readonly reject: (error: Readonly<Error>) => void;
}
export interface ReplyWaitOptions {
  readonly from: string;
  readonly replyTo: string;
  readonly signal?: AbortSignal;
}
export interface AskTransaction {
  readonly to: string;
  readonly questionId: string;
  readonly options: Parameters<IntercomClient["send"]>[1];
  readonly signal?: AbortSignal;
  readonly onSent: (result: SendResult) => void;
}
/** One correlated blocking wait; admitted before send so a fast reply cannot race it. */
export class ReplyWait {
  private waiter: ReplyWaiter | null = null;
  private readonly lifecycle: Lifecycle;
  private readonly timeoutMs: number;
  constructor(lifecycle: Lifecycle, timeoutMs: number) {
    this.lifecycle = lifecycle;
    this.timeoutMs = timeoutMs;
  }
  get waiting(): boolean {
    return this.waiter !== null;
  }
  isWaitingFor(id: string): boolean {
    return this.waiter?.replyTo === id;
  }
  reject(error: Readonly<Error>): void {
    this.waiter?.reject(error);
  }
  peerDisconnected(id: string): void {
    if (this.waiter?.from === id) {
      this.reject(new Error(`Reply peer disconnected before answering: ${id}`));
    }
  }
  receive(
    sender: { readonly id: string; readonly name?: string },
    message: Message,
    onMatch: () => void,
  ): boolean {
    const waiter = this.waiter;
    if (!waiter || sender.id !== waiter.from || message.replyTo !== waiter.replyTo) {
      return false;
    }
    onMatch();
    waiter.resolve(message);
    return true;
  }
  wait(options: ReplyWaitOptions): Promise<Message> {
    if (this.waiter) {
      throw new Error("Already waiting for a reply");
    }
    if (options.signal?.aborted === true) {
      throw new Error("Cancelled");
    }
    return new Promise((resolve, reject) => {
      const { from, replyTo, signal } = options;
      const timeout = setTimeout(() => {
        this.reject(
          new RecoveryError(
            "reply_timeout",
            `No reply from "${from}" within ${Math.max(1, Math.round(this.timeoutMs / 60000))} minute(s)`,
          ),
        );
      }, this.timeoutMs);
      timeout.unref();
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter?.replyTo === replyTo) {
          this.waiter = null;
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  async transact(activeClient: IntercomTransport, transaction: AskTransaction): Promise<Message> {
    const { to, questionId, options, signal, onSent } = transaction;
    const reply = this.wait({ from: to, replyTo: questionId, signal });
    // A delivery failure may reject before its reply branch is joined.
    reply.catch(() => {
      // The transaction joins this branch after settling delivery.
    });
    try {
      if (signal?.aborted === true) {
        throw new Error("Cancelled");
      }
      const result = await activeClient.send(to, {
        ...options,
        messageId: questionId,
        expectsReply: true,
      });
      if (!result.accepted) {
        throw new AskDeliveryError(result);
      }
      this.lifecycle.markActivity();
      onSent(result);
      return await reply;
    } catch (error) {
      if (this.isWaitingFor(questionId)) {
        this.reject(asError(error));
      }
      try {
        await reply;
      } catch {
        // Preserve the delivery failure rather than its cleanup rejection.
      }
      throw error;
    }
  }
}
