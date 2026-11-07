import { errorMessage } from "../../shared/unknown.ts";
import {
  compactTopicMessage,
  normalizeMessage,
  type Message,
  type MessageDelivery,
  type SendOptions,
} from "../types.ts";
import { validateIntercomMessageSize } from "./framing.ts";

export class SendError extends Error {
  readonly outcome: {
    readonly kind: "not-sent" | "unconfirmed";
    readonly messageId: string;
  };
  constructor(outcome: SendError["outcome"], cause: Readonly<Error>) {
    super(cause.message, { cause });
    this.outcome = outcome;
  }
}

function messageDelivery(options: SendOptions): MessageDelivery | undefined {
  if (options.delivery !== undefined) {
    return options.delivery;
  }
  if (options.passive === true) {
    return "passive";
  }
  return options.expectsReply === true ? undefined : "steer";
}

interface SendPacket {
  readonly type: "send";
  readonly to: string;
  readonly message: ReturnType<typeof compactTopicMessage>;
}

export function sendPacket(input: {
  readonly to: string;
  readonly messageId: string;
  readonly options: SendOptions;
  readonly topicsSupported: boolean;
}): SendPacket {
  const { to, messageId, options, topicsSupported } = input;
  try {
    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      guard: options.guard,
      replyHint: options.replyHint,
      ...(options.human ? { human: options.human } : {}),
      ...(options.topic ? { topic: options.topic } : {}),
      delivery: messageDelivery(options),
      queueMode: options.queueMode,
      threadId: options.threadId,
      passive: options.passive,
      content: { text: options.text, attachments: options.attachments },
    };
    if ((options.guard || options.replyHint) && normalizeMessage(message) === null) {
      throw new Error("Invalid message format");
    }
    const packet: SendPacket = {
      type: "send",
      to,
      message: topicsSupported ? compactTopicMessage(message) : message,
    };
    const invalid = validateIntercomMessageSize(packet);
    if (invalid !== null) {
      throw invalid;
    }
    return packet;
  } catch (error) {
    throw new SendError(
      { kind: "not-sent", messageId },
      error instanceof Error ? error : new Error(errorMessage(error)),
    );
  }
}
