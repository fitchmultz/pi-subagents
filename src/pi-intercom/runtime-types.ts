import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  Attachment,
  Message,
  MessageDelivery,
  QueueMode,
  SessionInfo,
  TopicUpdate,
} from "./types.ts";

export interface ChildOrchestratorMetadata {
  readonly orchestratorTarget: string;
  readonly runId: string;
  readonly agent: string;
  readonly index: string;
  readonly sessionName?: string;
}
export interface SubagentCompletion {
  readonly completionId?: string;
  readonly runId: string;
  readonly status: string;
  readonly children: readonly {
    readonly agent: string;
    readonly index: number;
    readonly status: string;
    readonly intercomTarget: string;
  }[];
}
export interface InboundMessageEntry {
  readonly from: SessionInfo;
  readonly message: Message;
  readonly replyCommand?: string;
  readonly bodyText: string;
  readonly subagentCompletion?: SubagentCompletion & { readonly ownerSessionId: string };
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
export type ContactSupervisorReason = "need_decision" | "progress_update" | "interview_request";
export type IntercomSessionScope = "project" | "all";
export interface ToolResultLike {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}
export interface ContactSupervisorToolParams {
  readonly reason: ContactSupervisorReason;
  readonly message?: string;
  readonly interview?: unknown;
}
export interface IntercomToolParams {
  readonly action:
    | "list"
    | "send"
    | "ask"
    | "reply"
    | "pending"
    | "status"
    | "subscribe"
    | "unsubscribe"
    | "publish"
    | "topics";
  readonly scope?: IntercomSessionScope;
  readonly to?: string;
  readonly message?: string;
  readonly attachments?: readonly Attachment[];
  readonly replyTo?: string;
  readonly delivery?: MessageDelivery;
  readonly queueMode?: QueueMode;
  readonly threadId?: string;
  readonly passive?: boolean;
  readonly topic?: string;
  readonly event?: TopicUpdate["event"];
  readonly resource?: string;
  readonly ownership?: TopicUpdate["ownership"];
  readonly awaitRelease?: boolean;
}
export type ToolRenderTheme = ExtensionContext["ui"]["theme"];
export interface ToolRenderContext {
  readonly args?: unknown;
  readonly isError?: boolean;
  readonly expanded?: boolean;
}
export const RECIPIENT_TURN_FAILED_ATTACHMENT = "pi-intercom-recipient-turn-failure";
export const INBOUND_CHECKPOINT_TYPE = "intercom_delivery";
export const TOPICS_UNAVAILABLE =
  "Intercom topics are unavailable while an older broker is still running. Direct messaging and active sessions are unchanged. Let its sessions close normally; after it exits, reconnect with the updated package and retry. Nothing was stopped or restarted.";
