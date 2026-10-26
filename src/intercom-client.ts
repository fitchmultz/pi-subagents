import {
  IntercomClient as BrokerClient,
  type IntercomClientOptions as BrokerOptions,
} from "./pi-intercom/broker/client.ts";
import {
  isDeliveryGuard,
  type DeliveryGuard,
  type LastMessageQuery,
  type LastMessageResult,
  type ReceiptQuery,
  type ReceiptResult,
  type SendOptions,
  type SendResult,
  type SessionInfo,
} from "./pi-intercom/types.ts";
import { isRecord } from "./shared/unknown.ts";

export type {
  ContextTarget,
  DeliveryGuard,
  LastMessageQuery,
  LastMessageResult,
  MessageDelivery,
  NativeReceipt,
  PublicationReplyHint,
  ReceiptQuery,
  ReceiptResult,
  SendResult,
  SessionInfo,
} from "./pi-intercom/types.ts";

export type GuardedSendOptions = Omit<
  SendOptions,
  "messageId" | "guard" | "expectsReply" | "replyTo" | "human" | "topic" | "passive" | "delivery"
> & {
  readonly messageId: string;
  readonly guard: DeliveryGuard;
  readonly expectsReply: false;
  readonly delivery: "queue" | "steer" | "passive";
};

export interface IntercomClientOptions extends BrokerOptions {
  readonly spawn: false;
  readonly session: Omit<
    SessionInfo,
    "id" | "guardedDelivery" | "applicationGuard" | "topics" | "subscriptions"
  >;
  readonly requestedId?: string;
  readonly onError?: (error: Readonly<Error>) => void;
}

export interface IntercomClient {
  readonly sessionId: string | null;
  readonly isConnected: () => boolean;
  readonly listSessions: () => Promise<readonly SessionInfo[]>;
  readonly send: (to: string, options: GuardedSendOptions) => Promise<SendResult>;
  readonly last: (to: string, query?: LastMessageQuery) => Promise<LastMessageResult>;
  readonly receipt: (to: string, query: ReceiptQuery) => Promise<ReceiptResult>;
  readonly disconnect: () => Promise<void>;
}

function requireNoSpawn(value: unknown): void {
  if (value !== false) {
    throw new Error("The supported Intercom client requires spawn:false.");
  }
}

function guardedSend(to: string, input: unknown): boolean {
  return (
    isRecord(input) &&
    isDeliveryGuard(input.guard) &&
    to === input.guard.peerId &&
    typeof input.messageId === "string" &&
    input.expectsReply === false &&
    input.delivery !== undefined
  );
}

/** Connect to an existing native broker. No Pi runtime, broker spawn or automatic retry. */
export async function connectIntercom(options: IntercomClientOptions): Promise<IntercomClient> {
  requireNoSpawn(options.spawn);
  const client = new BrokerClient(options);
  client.on("error", (error: Readonly<Error>) => options.onError?.(error));
  try {
    await client.connect(options.session, options.requestedId);
  } catch (error) {
    await client.disconnect();
    throw error;
  }
  return Object.freeze({
    get sessionId() {
      return client.sessionId;
    },
    isConnected: () => client.isConnected(),
    listSessions: () => client.listSessions(),
    async send(to: string, input: GuardedSendOptions) {
      if (!guardedSend(to, input)) {
        throw new Error(
          "An exact guarded nonblocking send with an original message ID is required.",
        );
      }
      return await client.send(to, input);
    },
    last: (to: string, query?: LastMessageQuery) => client.last(to, query),
    receipt: (to: string, query: ReceiptQuery) => client.receipt(to, query),
    disconnect: () => client.disconnect(),
  });
}
