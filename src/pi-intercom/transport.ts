import type { IntercomClient } from "./broker/client.ts";
/** Consumer operations deliberately omit the socket owner's EventEmitter mutation surface. */
export type IntercomTransport = Readonly<
  Pick<
    IntercomClient,
    | "send"
    | "isConnected"
    | "sessionId"
    | "supportsTopics"
    | "listSessions"
    | "updatePresence"
    | "updateTopics"
  >
>;
