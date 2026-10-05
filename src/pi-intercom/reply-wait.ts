import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import type { Message } from "./types.ts";
import type { IntercomClient, SendResult } from "./broker/client.ts";
import type { IntercomTransport } from "./transport.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { RECIPIENT_TURN_FAILED_ATTACHMENT } from "./runtime-types.ts";
import { asError } from "./validation.ts";
import { AskDeliveryError } from "./tool-results.ts";
import {
  cancelSupervisorQuestion,
  readQuestionState,
  saveQuestionAnswer,
  type SupervisorQuestion,
} from "../runs/shared/supervisor-questions.ts";

interface ReplyWaiter {
  readonly from: string;
  readonly replyTo: string;
  readonly question?: ReadonlyInput<SupervisorQuestion>;
  readonly retryNotification?: () => void;
  readonly resolve: (message: Message) => void;
  readonly reject: (error: Readonly<Error>) => void;
}
export interface ReplyWaitOptions {
  readonly from: string;
  readonly replyTo: string;
  readonly signal?: AbortSignal;
  readonly question?: ReadonlyInput<SupervisorQuestion>;
}
export interface AskTransaction {
  readonly to: string;
  readonly questionId: string;
  readonly options: Parameters<IntercomClient["send"]>[1];
  readonly signal?: AbortSignal;
  readonly onSent: (result: SendResult) => void;
}
/** Owns the single blocking wait, abort listener, timeout and durable polling. */
export class ReplyWait {
  private waiter: ReplyWaiter | null = null;
  private readonly pi: ExtensionAPI;
  private readonly lifecycle: Lifecycle;
  private readonly timeoutMs: number;
  constructor(pi: ExtensionAPI, lifecycle: Lifecycle, timeoutMs: number) {
    this.pi = pi;
    this.lifecycle = lifecycle;
    this.timeoutMs = timeoutMs;
  }
  get waiting(): boolean {
    return this.waiter !== null;
  }
  get durable(): boolean {
    return this.waiter?.question !== undefined;
  }
  isWaitingFor(id: string): boolean {
    return this.waiter?.replyTo === id;
  }
  retarget(id: string, from: string): void {
    if (this.waiter?.replyTo === id) {
      this.waiter = { ...this.waiter, from };
    }
  }
  clearRetry(id: string): void {
    if (this.waiter?.replyTo === id) {
      this.waiter = { ...this.waiter, retryNotification: undefined };
    }
  }
  retry(id: string, retryNotification: () => void): void {
    if (this.waiter?.replyTo === id) {
      this.waiter = { ...this.waiter, retryNotification };
    }
  }
  reject(error: Readonly<Error>): void {
    this.waiter?.reject(error);
  }
  peerDisconnected(id: string): void {
    if (this.waiter?.from === id && !this.waiter.question) {
      this.reject(new Error(`Reply peer disconnected before answering: ${id}`));
    }
  }
  receive(
    sender: { readonly id: string; readonly name?: string },
    message: Message,
    onMatch: () => void,
  ): boolean {
    const { id: from, name } = sender;
    const waiter = this.waiter;
    if (!waiter) {
      return false;
    }
    const senderTarget = name !== undefined && name !== "" ? name : from;
    if (
      (senderTarget.toLowerCase() !== waiter.from.toLowerCase() && from !== waiter.from) ||
      message.replyTo !== waiter.replyTo
    ) {
      return false;
    }
    onMatch();
    waiter.resolve(message);
    return true;
  }
  private poll(question: ReadonlyInput<SupervisorQuestion>, replyTo: string): void {
    try {
      const saved = readQuestionState(question);
      if (saved.state === "cancelled") {
        this.lifecycle.live()?.abort();
        this.reject(new Error("Cancelled"));
        return;
      }
      if (saved.answer) {
        this.waiter?.resolve({
          id: replyTo,
          replyTo,
          timestamp: saved.answer.answeredAt,
          content: { text: saved.answer.message },
        });
      } else {
        this.waiter?.retryNotification?.();
      }
    } catch (error) {
      this.reject(asError(error));
    }
  }
  private saveAnswer(
    question: ReadonlyInput<SupervisorQuestion> | undefined,
    message: Message,
  ): boolean {
    if (!question) {
      return true;
    }
    if (
      message.content.attachments?.some(
        (attachment) => attachment.name === RECIPIENT_TURN_FAILED_ATTACHMENT,
      ) === true
    ) {
      this.pi.appendEntry("intercom_question_notification_error", {
        questionId: question.questionId,
        error: message.content.text,
      });
      return false;
    }
    saveQuestionAnswer(question, message.content.text);
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
      const { from, replyTo, signal, question } = options;
      const timeout = question
        ? undefined
        : setTimeout(() => {
            this.reject(
              new Error(
                `No reply from "${from}" within ${Math.max(1, Math.round(this.timeoutMs / 60000))} minute(s)`,
              ),
            );
          }, this.timeoutMs);
      timeout?.unref();
      const poll = question
        ? setInterval(() => {
            this.poll(question, replyTo);
          }, 250)
        : undefined;
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(poll);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter?.replyTo === replyTo) {
          this.waiter = null;
        }
      };
      const onAbort = () => {
        try {
          if (question) {
            cancelSupervisorQuestion(question);
          }
        } finally {
          cleanup();
          reject(new Error("Cancelled"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = {
        from,
        replyTo,
        question,
        resolve: (message) => {
          try {
            if (!this.saveAnswer(question, message)) {
              return;
            }
            cleanup();
            resolve(message);
          } catch (error) {
            cleanup();
            reject(asError(error));
          }
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
    // Delivery may reject before the reply is joined; the transaction owns both branches.
    reply.catch(() => {
      /* The original error is propagated below after cleanup. */
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
        /* Preserve the delivery failure rather than its cleanup rejection. */
      }
      throw error;
    }
  }
}
export type ReplyWaitHandle = Readonly<ReplyWait>;
