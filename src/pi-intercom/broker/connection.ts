import net from "node:net";
import { errorMessage } from "../../shared/unknown.ts";
import { getBrokerSocketPath, isOwnedBrokerSocket } from "./paths.ts";
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
  const socketPath = getBrokerSocketPath();
  if (!isOwnedBrokerSocket(socketPath)) {
    throw new Error(`Intercom broker socket is unavailable: ${socketPath}`);
  }
  return await connectSocket(socketPath);
}

interface ConnectionHandlers {
  readonly message: (message: unknown) => void;
  readonly error: (error: Readonly<Error>) => void;
  readonly closed: (error: Readonly<Error>, expected: boolean) => void;
}

type ConnectionPhase =
  | { readonly kind: "acquired" | "active" | "failed" | "closed" }
  | {
      readonly kind: "registering";
      readonly resolve: () => void;
      readonly reject: (error: Readonly<Error>) => void;
      readonly timer: NodeJS.Timeout;
    }
  | { readonly kind: "closing"; readonly task: Promise<void>; readonly registered: boolean };

/** One socket owns registration, read/error listeners, and graceful shutdown. */
export class BrokerConnection {
  private phase: ConnectionPhase = { kind: "acquired" };
  private failure: Readonly<Error> | null = null;
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
      const timer = setTimeout(() => this.failRegistration(new Error("Connection timeout")), 10000);
      timer.unref();
      this.phase = { kind: "registering", resolve, reject, timer };
      try {
        writeMessage(this.socket, registration);
      } catch (error) {
        this.failRegistration(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  }

  confirmRegistration(): void {
    const pending = this.takeRegistration();
    if (pending !== undefined) {
      this.phase = { kind: "active" };
      pending.resolve();
    }
  }

  private takeRegistration() {
    const pending = this.phase;
    if (pending.kind !== "registering") {
      return;
    }
    clearTimeout(pending.timer);
    this.phase = { kind: "acquired" };
    return pending;
  }

  private failRegistration(error: Readonly<Error>): void {
    const pending = this.takeRegistration();
    if (this.phase.kind !== "closing") {
      this.phase = { kind: "failed" };
    }
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
    const closing = this.phase.kind === "closing";
    const pending = this.takeRegistration();
    this.phase = { kind: "closed" };
    this.socket.off("data", this.reader);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    pending?.reject(new Error("Connection closed before registration"));
    this.handlers.closed(this.failure ?? new Error("Client disconnected"), closing);
  };

  private get registered(): boolean {
    return this.phase.kind === "active" || (this.phase.kind === "closing" && this.phase.registered);
  }

  isActive(): boolean {
    return (
      this.phase.kind === "active" &&
      !this.socket.destroyed &&
      !this.socket.writableEnded &&
      this.socket.writable
    );
  }

  disconnect(): Promise<void> {
    const phase = this.phase;
    if (phase.kind === "closing") {
      return phase.task;
    }
    if (phase.kind === "closed") {
      return Promise.resolve();
    }
    const pending = this.takeRegistration();
    pending?.reject(new Error("Client disconnected before registration"));
    this.failure = null;
    const task = new Promise<void>((resolve) => {
      const finish = () => {
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
    });
    this.phase = { kind: "closing", task, registered: phase.kind === "active" };
    try {
      if (phase.kind === "active" || phase.kind === "registering") {
        writeMessage(this.socket, { type: "unregister" });
        this.socket.end();
      } else {
        this.socket.destroy();
      }
    } catch {
      this.socket.destroy();
    }
    return task;
  }
}
