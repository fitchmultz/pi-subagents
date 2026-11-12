import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertRecord } from "./assertions.ts";
import type { UnknownRecord } from "../../src/shared/unknown.ts";

/** Schedule real process overlap without replacing filesystem or spawn operations. */
export class NativeDebugger {
  private readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: UnknownRecord) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly pauses: UnknownRecord[] = [];
  private waiter: ((value: UnknownRecord) => void) | undefined;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const raw: unknown = event.data;
      if (typeof raw !== "string") {
        throw new Error("Expected inspector text frame");
      }
      const value: unknown = JSON.parse(raw);
      assertRecord(value);
      if (typeof value.id === "number") {
        const request = this.pending.get(value.id);
        this.pending.delete(value.id);
        if (value.error !== undefined) {
          request?.reject(new Error(JSON.stringify(value.error)));
        } else {
          assertRecord(value.result);
          request?.resolve(value.result);
        }
      } else if (value.method === "Debugger.paused") {
        assertRecord(value.params);
        if (this.waiter === undefined) {
          this.pauses.push(value.params);
        } else {
          this.waiter(value.params);
          this.waiter = undefined;
        }
      }
    });
  }

  static async connect(endpoint: string): Promise<NativeDebugger> {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Inspector connection failed")), {
        once: true,
      });
    });
    const inspector = new NativeDebugger(socket);
    await inspector.call("Debugger.enable");
    return inspector;
  }

  call(method: string, params: UnknownRecord = {}): Promise<UnknownRecord> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  pause(): Promise<UnknownRecord> {
    const paused = this.pauses.shift();
    return paused === undefined
      ? new Promise((resolve) => {
          this.waiter = resolve;
        })
      : Promise.resolve(paused);
  }

  async before(file: string, operation: string): Promise<string> {
    // Locate an actual statement for the native debugger, not a source-code assertion.
    const lineNumber = readFileSync(file, "utf8")
      .split("\n")
      .findIndex((line) => line.includes(operation));
    const result = await this.call("Debugger.setBreakpointByUrl", {
      url: pathToFileURL(file).href,
      lineNumber,
    });
    if (typeof result.breakpointId !== "string") {
      throw new Error("Missing native breakpoint");
    }
    return result.breakpointId;
  }

  async resume(breakpoint: string): Promise<void> {
    await this.call("Debugger.removeBreakpoint", { breakpointId: breakpoint });
    await this.call("Debugger.resume");
  }

  close(): void {
    this.socket.close();
  }
}
