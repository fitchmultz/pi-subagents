import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { once } from "node:events";
import { createMessageReader, writeFrame } from "../../src/pi-intercom/broker/framing.ts";
import { agentObservationSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { NativeJournal } from "../../src/shared/native-journal.ts";
import { errorMessage, isRecord } from "../../src/shared/unknown.ts";

const FRAME_BYTES = 256 * 1024;

export interface LiveBlock {
  readonly type: string;
  text?: string;
  id?: string;
  name?: string;
  args?: unknown;
}
export interface ViewedTool {
  readonly id: string;
  name?: string;
  args?: unknown;
  rev: number;
  partial?: unknown;
  partials: number;
  end?: { readonly isError: boolean; readonly result: unknown };
}
export interface Settled {
  readonly seq: number;
  readonly entry: string | null;
  readonly key: number | null;
  readonly tool: string | null;
}
export interface ViewerOptions {
  readonly token: string;
  readonly rootId: string;
  readonly sessionId: string;
  readonly journal: string;
  readonly level?: "detail" | "activity";
}

/** Test-owned consumer of the actor's push-only observation endpoint. It never writes commands. */
export class ObservationViewer {
  snapshot?: Record<string, unknown>;
  activity?: unknown;
  message?: { readonly key: number; ended: boolean; blocks: LiveBlock[] } | undefined;
  /** Baselines received after the first: live state was rebuilt from the journal leaf. */
  resyncs = 0;
  private seq = 0;
  /** The last live content shown for each message before its journal entry took over. */
  readonly shown = new Map<number, LiveBlock[]>();
  readonly tools = new Map<string, ViewedTool>();
  readonly finishedTools = new Map<string, ViewedTool>();
  /** Handovers since the current baseline. */
  readonly settled: Settled[] = [];
  readonly errors: string[] = [];
  readonly frameSizes: number[] = [];
  frames = 0;
  closed = false;
  readonly socket: net.Socket;
  private readonly options: ViewerOptions;
  private readonly waiters = new Set<() => void>();
  private constructor(socket: net.Socket, options: ViewerOptions) {
    this.socket = socket;
    this.options = options;
  }
  static async connect(options: ViewerOptions): Promise<ObservationViewer> {
    const socketPath = agentObservationSocketPath(options.token);
    const directory = fs.lstatSync(path.dirname(socketPath));
    const endpoint = fs.lstatSync(socketPath);
    const uid = process.getuid?.();
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o777) !== 0o700 ||
      directory.uid !== uid ||
      !endpoint.isSocket() ||
      (endpoint.mode & 0o777) !== 0o600 ||
      endpoint.uid !== uid
    ) {
      throw new Error(`Unsafe observation endpoint ${socketPath}`);
    }
    const socket = net.createConnection(socketPath);
    await once(socket, "connect");
    const viewer = new ObservationViewer(socket, options);
    socket.on(
      "data",
      createMessageReader(
        (message) => {
          viewer.receive(message);
        },
        (error) => {
          viewer.errors.push(error.message);
        },
        FRAME_BYTES,
      ),
    );
    socket.on("close", () => {
      viewer.closed = true;
      viewer.wake();
    });
    socket.on("error", (error) => {
      viewer.errors.push(`socket: ${error.message}`);
    });
    const { token, rootId, sessionId, level = "detail" } = options;
    writeFrame(socket, JSON.stringify({ t: "hello", v: 1, token, rootId, sessionId, level }));
    return viewer;
  }
  /** Stop reading; the kernel and the actor's socket buffer fill up. */
  pause(): void {
    this.socket.pause();
  }
  resume(): void {
    this.socket.resume();
  }
  close(): void {
    this.socket.destroy();
  }
  /** Re-evaluates after each frame, so readiness is observed rather than slept on. */
  async until(check: () => boolean, reason: string, timeout = 30_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!check()) {
      if (this.closed || Date.now() > deadline) {
        throw new Error(`${reason}: ${this.closed ? "viewer closed" : "timed out"}`);
      }
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, 100);
        this.waiters.add(wake);
      });
    }
  }
  liveText(type = "text"): string {
    return this.message?.blocks.find((block) => block.type === type)?.text ?? "";
  }
  private wake(): void {
    for (const waiter of this.waiters) {
      waiter();
    }
  }
  private receive(frame: unknown): void {
    this.frames++;
    this.frameSizes.push(Buffer.byteLength(JSON.stringify(frame)));
    try {
      this.apply(frame);
    } catch (error) {
      this.errors.push(errorMessage(error));
    }
    this.wake();
  }
  private apply(frame: unknown): void {
    if (!isRecord(frame)) {
      throw new Error("Frame is not an object");
    }
    if (frame.t === "snapshot") {
      this.baseline(frame);
      return;
    }
    if (this.snapshot === undefined) {
      throw new Error("Frame before snapshot");
    }
    if (frame.t === "activity") {
      this.activity = frame.activity;
      return;
    }
    if (frame.t !== "delta" || !Array.isArray(frame.settled) || !Array.isArray(frame.tools)) {
      throw new Error(`Unknown frame ${JSON.stringify(frame).slice(0, 200)}`);
    }
    for (const item of frame.settled) {
      this.settle(settlement(item));
    }
    for (const item of frame.tools) {
      this.tool(item);
    }
    if (frame.message !== undefined) {
      this.liveMessage(frame.message);
    }
  }
  private baseline(frame: Record<string, unknown>): void {
    if (
      frame.v !== 1 ||
      frame.generation !== this.options.token ||
      frame.rootId !== this.options.rootId ||
      frame.sessionId !== this.options.sessionId ||
      typeof frame.seq !== "number"
    ) {
      throw new Error(`Unexpected snapshot ${JSON.stringify(frame)}`);
    }
    if (this.snapshot !== undefined) {
      // A new baseline: everything no longer live is durable through its leaf.
      this.resyncs++;
      this.message = undefined;
      this.tools.clear();
      this.settled.length = 0;
    }
    this.seq = frame.seq;
    this.snapshot = frame;
    this.activity = frame.activity;
  }
  private settle(item: Settled): void {
    const { seq, entry, key, tool } = item;
    if (seq !== this.seq + 1) {
      throw new Error(`Settlement gap ${String(this.seq)} -> ${String(seq)}`);
    }
    this.seq = seq;
    // A live item may hand over only to an already durable, complete-LF journal entry.
    if (entry !== null && !durable(this.options.journal, entry)) {
      throw new Error(`Settlement ${String(seq)} names non-durable entry ${entry}`);
    }
    this.settled.push(item);
    if (key !== null && this.message?.key === key) {
      this.shown.set(key, this.message.blocks);
      this.message = undefined;
    }
    // A published result retires its call and every call it made through ctx.executeTool().
    for (const [id, viewed] of tool === null ? [] : [...this.tools]) {
      if (id === tool || id.startsWith(`${String(tool)}/`)) {
        this.finishedTools.set(id, viewed);
        this.tools.delete(id);
      }
    }
  }
  private tool(item: unknown): void {
    if (!isRecord(item) || typeof item.id !== "string") {
      throw new Error("Malformed tool");
    }
    let tool = this.tools.get(item.id);
    if (tool === undefined) {
      if (typeof item.name !== "string" || !("args" in item)) {
        throw new Error(`Tool ${item.id} update before its start`);
      }
      tool = { id: item.id, name: item.name, args: item.args, rev: 0, partials: 0 };
      this.tools.set(item.id, tool);
    }
    if (isRecord(item.partial)) {
      if (typeof item.partial.rev !== "number" || item.partial.rev <= tool.rev) {
        throw new Error(`Tool ${item.id} progress did not advance`);
      }
      tool.rev = item.partial.rev;
      tool.partial = item.partial.value;
      tool.partials++;
    }
    if (isRecord(item.end)) {
      tool.end = { isError: item.end.isError === true, result: item.end.result };
    }
  }
  private liveMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.key !== "number" || !Array.isArray(value.blocks)) {
      throw new Error("Malformed message");
    }
    if (value.reset === true) {
      this.message = { key: value.key, ended: false, blocks: [] };
    }
    const message = this.message;
    if (message?.key !== value.key) {
      throw new Error(`Message ${String(value.key)} changed without reset`);
    }
    message.ended = value.ended === true;
    if (typeof value.count === "number") {
      message.blocks.length = Math.min(message.blocks.length, value.count);
    }
    for (const item of value.blocks) {
      const [index, block] = parseBlock(item);
      message.blocks[index] = this.applyBlock(message.blocks.at(index), block);
    }
  }
  /** Offset zero starts or replaces a block; any other offset must continue it exactly. */
  private applyBlock(current: LiveBlock | undefined, next: LiveBlock & { offset?: number }) {
    const { offset, ...block } = next;
    if (offset === undefined || offset === 0) {
      return block;
    }
    if (current?.type !== block.type || current.text?.length !== offset) {
      const length = String(current?.text?.length);
      throw new Error(`Append at ${String(offset)} does not continue ${length}`);
    }
    return { ...current, text: `${current.text}${block.text ?? ""}` };
  }
}

/** The actor keeps appending; a snapshot read that raced an append is simply retaken. */
function durable(journal: string, entry: string): boolean {
  for (let attempt = 1; ; attempt++) {
    try {
      return new NativeJournal(journal, "live").byId.has(entry);
    } catch (error) {
      if (attempt >= 100 || !errorMessage(error).startsWith("Journal changed while indexing")) {
        throw error;
      }
    }
  }
}
function settlement(item: unknown): Settled {
  if (!Array.isArray(item) || item.length !== 4) {
    throw new Error("Malformed settlement");
  }
  const [seq, entry, key, tool] = item as unknown[];
  if (
    typeof seq !== "number" ||
    (entry !== null && typeof entry !== "string") ||
    (key !== null && typeof key !== "number") ||
    (tool !== null && typeof tool !== "string")
  ) {
    throw new Error("Malformed settlement");
  }
  return { seq, entry, key, tool };
}
function parseBlock(item: unknown): [number, LiveBlock & { offset?: number }] {
  if (!Array.isArray(item)) {
    throw new Error("Malformed block");
  }
  const [index, type, first, second, args] = item as unknown[];
  if (typeof index !== "number" || typeof type !== "string") {
    throw new Error("Malformed block");
  }
  if (type === "toolCall" && typeof first === "string" && typeof second === "string") {
    return [index, { type, id: first, name: second, args }];
  }
  if (type !== "toolCall" && typeof first === "number" && typeof second === "string") {
    return [index, { type, offset: first, text: second }];
  }
  throw new Error(`Malformed ${type} block`);
}
