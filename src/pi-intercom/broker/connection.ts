import net from "node:net";
import { errorMessage } from "../../shared/unknown.ts";
import { getBrokerSocketPath, getLegacyBrokerSocketPath, isOwnedBrokerSocket } from "./paths.ts";
import { createMessageReader, writeMessage } from "./framing.ts";

function connectSocket(socketPath: string, timeoutMs = 500): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const finish = (error?: Readonly<Error>) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = () => finish();
    const onError = (error: Readonly<Error>) => finish(error);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    const timeout = setTimeout(
      () => finish(new Error(`Connection timeout: ${socketPath}`)),
      timeoutMs,
    );
    timeout.unref();
  });
}

export async function connectBrokerSocket(): Promise<net.Socket> {
  const preferred = getBrokerSocketPath();
  const legacy = getLegacyBrokerSocketPath();
  const candidates = [preferred, ...(legacy !== preferred ? [legacy] : [])];
  let lastError: Error | undefined;
  for (const candidate of candidates) {
    if (!isOwnedBrokerSocket(candidate)) {
      continue;
    }
    try {
      // Preferred and legacy sockets must be tried in order, never connected concurrently.
      // oxlint-disable-next-line no-await-in-loop
      return await connectSocket(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(errorMessage(error));
    }
  }
  throw lastError ?? new Error(`Intercom broker socket is unavailable: ${preferred}`);
}

interface ConnectionHandlers {
  readonly message: (message: unknown) => void;
  readonly error: (error: Readonly<Error>) => void;
  readonly closed: (error: Readonly<Error>, expected: boolean) => void;
}

/** One socket owns registration, read/error listeners, and graceful shutdown. */
export class BrokerConnection {
  private registered = false;
  private closing = false;
  private failure: Readonly<Error> | null = null;
  private registration: {
    readonly resolve: () => void;
    readonly reject: (error: Readonly<Error>) => void;
  } | null = null;
  private registrationTimer: NodeJS.Timeout | null = null;
  private readonly reader: (data: Buffer) => void;

  readonly socket: net.Socket;
  private readonly handlers: ConnectionHandlers;

  constructor(socket: net.Socket, handlers: ConnectionHandlers) {
    this.socket = socket;
    this.handlers = handlers;
    this.reader = createMessageReader(handlers.message, (error) => this.protocolError(error));
    socket.on("data", this.reader);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  start(registration: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.registration = { resolve, reject };
      this.registrationTimer = setTimeout(
        () => this.failRegistration(new Error("Connection timeout")),
        10000,
      );
      this.registrationTimer.unref();
      try {
        writeMessage(this.socket, registration);
      } catch (error) {
        this.failRegistration(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  }

  confirmRegistration(): void {
    this.registered = true;
    const pending = this.registration;
    this.clearRegistration();
    pending?.resolve();
  }

  private clearRegistration(): void {
    if (this.registrationTimer) {
      clearTimeout(this.registrationTimer);
    }
    this.registrationTimer = null;
    this.registration = null;
  }

  private failRegistration(error: Readonly<Error>): void {
    const pending = this.registration;
    this.clearRegistration();
    this.failure = error;
    this.socket.destroy();
    pending?.reject(error);
  }

  private protocolError(error: Readonly<Error>): void {
    const failure = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
    if (!this.registered) {
      this.failRegistration(failure);
      return;
    }
    this.failure = failure;
    this.handlers.error(failure);
    this.socket.destroy();
  }

  private readonly onError = (error: Readonly<Error>): void => {
    if (!this.registered) {
      this.failRegistration(error);
      return;
    }
    this.failure = error;
    this.handlers.error(error);
  };

  private readonly onClose = (): void => {
    const pending = this.registration;
    this.clearRegistration();
    this.socket.off("data", this.reader);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    pending?.reject(new Error("Connection closed before registration"));
    this.handlers.closed(this.failure ?? new Error("Client disconnected"), this.closing);
  };

  isActive(): boolean {
    return (
      this.registered &&
      !this.closing &&
      !this.socket.destroyed &&
      !this.socket.writableEnded &&
      this.socket.writable
    );
  }

  disconnect(): Promise<void> {
    this.closing = true;
    this.failure = null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.socket.off("close", finish);
        this.socket.off("error", onError);
        resolve();
      };
      const onError = () => {
        this.socket.destroy();
      };
      const timeout = setTimeout(() => {
        this.socket.destroy();
      }, 2000);
      this.socket.once("close", finish);
      this.socket.once("error", onError);
      try {
        writeMessage(this.socket, { type: "unregister" });
        this.socket.end();
      } catch {
        this.socket.destroy();
      }
    });
  }
}
