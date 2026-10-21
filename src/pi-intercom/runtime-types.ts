import type { Attachment, Message, MessageDelivery, QueueMode, SessionInfo } from "./types.ts";

export interface InboundMessageEntry {
  readonly from: SessionInfo;
  readonly message: Message;
  readonly replyCommand?: string;
  readonly bodyText: string;
}
export interface PendingInboundMessage extends InboundMessageEntry {
  readonly flushDelivery: "auto" | "passive" | "steer";
  readonly stage: "queued" | "native";
  readonly receivedAt: number;
}
export type InboundCheckpoint =
  | { readonly entry: PendingInboundMessage }
  | {
      readonly messageId: string;
      readonly stage: PendingInboundMessage["stage"] | "discarded" | "reply-retired";
    };
export type RequestedDelivery = MessageDelivery | "auto";
export type InboundDelivery = "trigger" | "followUp" | "steer" | "passive";
export type IntercomSessionScope = "project" | "all";
export interface ToolResultLike {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}
export interface IntercomToolParams {
  readonly action: "list" | "send" | "ask" | "reply" | "pending" | "status" | "last";
  readonly scope?: IntercomSessionScope;
  readonly to?: string;
  readonly message?: string;
  readonly attachments?: readonly Attachment[];
  readonly replyTo?: string;
  readonly delivery?: MessageDelivery;
  readonly queueMode?: QueueMode;
  readonly threadId?: string;
  readonly passive?: boolean;
  readonly entryId?: string;
  readonly offset?: number;
  readonly limit?: number;
}
export const RECIPIENT_TURN_FAILED_ATTACHMENT = "pi-intercom-recipient-turn-failure";
export const INBOUND_CHECKPOINT_TYPE = "intercom_delivery";
