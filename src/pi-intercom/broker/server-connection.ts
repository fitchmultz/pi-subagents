import type net from "node:net";
import { randomUUID } from "node:crypto";
import { createMessageReader } from "./framing.ts";
import { assertMainParent } from "./targets.ts";
import { isSessionRegistration, type SessionInfo } from "../types.ts";
import type { UnknownRecord } from "../../shared/unknown.ts";

export function registeredSessionInfo(
  msg: UnknownRecord,
  sessions: ReadonlyMap<string, { readonly info: SessionInfo }>,
): SessionInfo {
  if (!isSessionRegistration(msg.session)) {
    throw new Error("Invalid register message");
  }
  assertMainParent(msg.session, sessions);
  const requestedId =
    typeof msg.requestedId === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(msg.requestedId)
      ? msg.requestedId
      : undefined;
  const id = requestedId !== undefined && !sessions.has(requestedId) ? requestedId : randomUUID();
  return {
    ...msg.session,
    id,
    guardedDelivery: msg.guardedDelivery === 1 ? msg.session.guardedDelivery : undefined,
    lastSeen: msg.session.lastSeen ?? Date.now(),
  };
}

type ClientMessageHandler = (
  socket: net.Socket,
  message: unknown,
  sessionId: string | null,
  registered: (id: string | null) => void,
) => void;

/** A server connection owns its registration identity until the socket closes. */
export function acceptBrokerConnection(
  socket: net.Socket,
  handleMessage: ClientMessageHandler,
  disconnected: (sessionId: string) => void,
): void {
  let sessionId: string | null = null;
  socket.on(
    "data",
    createMessageReader(
      (message) =>
        handleMessage(socket, message, sessionId, (id) => {
          sessionId = id;
        }),
      (error) => {
        socket.destroy(error);
      },
    ),
  );
  socket.on("close", () => {
    if (sessionId !== null) {
      disconnected(sessionId);
    }
  });
  socket.on("error", (error: Error) => {
    console.error("Socket error:", error);
  });
}
