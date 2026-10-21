import type net from "node:net";
import { createMessageReader } from "./framing.ts";

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
