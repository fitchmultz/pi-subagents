import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { Static } from "typebox";
import { agentObservationSocketPath } from "../pi-intercom/broker/paths.ts";
import { createMessageReader, writeFrame } from "../pi-intercom/broker/framing.ts";
import type { ObservationIdentity } from "./observation.ts";
import type { Launch } from "./contracts.ts";
export type Watch = { launch: Launch; identity?: ObservationIdentity | undefined };
import { Assert, Type } from "./typebox.ts";

const activitySchema = Type.Object({
  phase: Type.String(),
  tools: Type.Array(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
});
const nullableString = Type.Union([Type.String(), Type.Null()]);
const settlementSchema = Type.Tuple([
  Type.Number(),
  Type.String(),
  Type.Union([Type.Number(), Type.Null()]),
  nullableString,
]);
const blockSchema = Type.Union([
  Type.Tuple([
    Type.Integer({ minimum: 0, maximum: 255 }),
    Type.Union([Type.Literal("text"), Type.Literal("thinking")]),
    Type.Integer({ minimum: 0 }),
    Type.String(),
  ]),
  Type.Tuple([
    Type.Integer({ minimum: 0, maximum: 255 }),
    Type.Literal("toolCall"),
    Type.String(),
    Type.String(),
    Type.Unknown(),
  ]),
]);
const messageSchema = Type.Object({
  key: Type.Number(),
  reset: Type.Boolean(),
  ended: Type.Boolean(),
  count: Type.Number(),
  blocks: Type.Array(blockSchema),
});
const toolSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  args: Type.Optional(Type.Unknown()),
  partial: Type.Optional(Type.Object({ rev: Type.Number(), value: Type.Unknown() })),
  end: Type.Optional(Type.Object({ result: Type.Unknown(), isError: Type.Boolean() })),
});
const frameSchema = Type.Union([
  Type.Object({
    t: Type.Literal("snapshot"),
    v: Type.Literal(1),
    generation: Type.String(),
    rootId: Type.String(),
    sessionId: Type.String(),
    seq: Type.Number(),
    leafId: nullableString,
    activity: activitySchema,
  }),
  Type.Object({ t: Type.Literal("activity"), activity: activitySchema }),
  Type.Object({
    t: Type.Literal("delta"),
    settled: Type.Array(settlementSchema),
    tools: Type.Array(toolSchema),
    message: Type.Optional(messageSchema),
  }),
]);
export interface ViewedBlock {
  type: "text" | "thinking" | "toolCall";
  text?: string;
  id?: string;
  name?: string;
  args?: unknown;
}
export interface ViewedTool {
  id: string;
  name: string;
  args?: unknown;
  partial?: unknown;
  end?: { result: unknown; isError: boolean };
}

type ChannelPhase =
  | { readonly kind: "empty" }
  | { readonly kind: "current"; readonly client: ObservationClient }
  | {
      readonly kind: "connecting";
      readonly previous: ObservationClient | undefined;
      readonly client: ObservationClient;
    };

export class ObservationChannel {
  private phase: ChannelPhase = { kind: "empty" };
  private readonly changed: () => void;
  constructor(changed: () => void) {
    this.changed = changed;
  }
  get current(): ObservationClient | undefined {
    const phase = this.phase;
    switch (phase.kind) {
      case "empty":
        return;
      case "current":
        return phase.client;
      case "connecting":
        return phase.previous;
      default: {
        const exhaustive: never = phase;
        return exhaustive;
      }
    }
  }
  get connecting(): boolean {
    return this.phase.kind === "connecting";
  }
  private retain(client: ObservationClient | undefined): void {
    this.phase = client === undefined ? { kind: "empty" } : { kind: "current", client };
  }
  connect(identity: ObservationIdentity): void {
    if (this.connecting || this.current?.connected === true) {
      return;
    }
    const client = new ObservationClient(identity, "detail", () => {
      const phase = this.phase;
      const pending = phase.kind === "connecting" ? phase.client : undefined;
      if (pending !== client && this.current !== client) {
        return;
      }
      if (phase.kind === "connecting" && phase.client === client) {
        if (client.connected) {
          this.retain(client);
        } else if (client.closed) {
          this.retain(phase.previous);
        }
      }
      this.changed();
    });
    this.phase = { kind: "connecting", previous: this.current, client };
  }
  pause(): void {
    const current = this.current;
    current?.close();
    if (this.phase.kind === "connecting") {
      this.phase.client.close();
    }
    this.retain(current);
  }
  clear(): void {
    this.pause();
    this.phase = { kind: "empty" };
  }
}

/** A selected read-only peer. Destruction closes its own socket, never native execution. */
export class ObservationClient {
  activity = "Connecting";
  model = "";
  thinking = "";
  private phase: "connecting" | "awaiting-baseline" | "ready" | "closing" | "closed" = "connecting";
  revision = 0;
  leaf?: string | null;
  message?: { key: number; ended: boolean; blocks: ViewedBlock[] } | undefined;
  readonly tools = new Map<string, ViewedTool>();
  private readonly handovers: Array<Static<typeof settlementSchema>> = [];
  private seq = 0;
  private chars = 0;
  private readonly socket: net.Socket;
  private readonly identity: ObservationIdentity;
  private readonly changed: () => void;
  constructor(identity: ObservationIdentity, level: "activity" | "detail", changed: () => void) {
    this.identity = identity;
    this.changed = changed;
    const file = agentObservationSocketPath(identity.token);
    const directory = fs.lstatSync(path.dirname(file));
    const endpoint = fs.lstatSync(file);
    const uid = process.getuid?.();
    if (
      !directory.isDirectory() ||
      directory.uid !== uid ||
      (directory.mode & 0o777) !== 0o700 ||
      !endpoint.isSocket() ||
      endpoint.uid !== uid ||
      (endpoint.mode & 0o777) !== 0o600
    ) {
      throw new Error("Unsafe child observation endpoint.");
    }
    this.socket = net.createConnection(file);
    this.socket.on("connect", () => {
      if (this.phase !== "connecting") {
        return;
      }
      this.phase = "awaiting-baseline";
      writeFrame(this.socket, JSON.stringify({ t: "hello", v: 1, ...identity, level }));
    });
    this.socket.on(
      "data",
      createMessageReader(
        (frame) => {
          try {
            this.receive(frame);
          } catch {
            this.close();
          }
        },
        () => {
          this.close();
        },
        256 * 1024,
      ),
    );
    this.socket.on("error", () => {
      this.close();
    });
    this.socket.on("close", () => {
      this.phase = "closed";
      this.changed();
    });
  }
  get connected(): boolean {
    return this.phase === "ready";
  }
  get closed(): boolean {
    return this.phase === "closing" || this.phase === "closed";
  }
  private receive(value: unknown): void {
    if (this.closed) {
      return;
    }
    Assert(frameSchema, value);
    if (value.t === "snapshot") {
      this.baseline(value);
    } else if (this.phase !== "ready") {
      throw new Error("Observation before baseline.");
    } else if (value.t === "delta") {
      this.delta(value);
    }
    if (value.t !== "delta") {
      this.activity = [value.activity.phase, ...value.activity.tools].join(" · ");
      this.model = value.activity.model ?? this.model;
      this.thinking = value.activity.thinking ?? this.thinking;
    }
    this.revision++;
    this.changed();
  }
  private baseline(value: Extract<Static<typeof frameSchema>, { t: "snapshot" }>): void {
    const { token, rootId, sessionId } = this.identity;
    if (value.generation !== token || value.rootId !== rootId || value.sessionId !== sessionId) {
      throw new Error("Foreign child observation.");
    }
    this.leaf = value.leafId;
    this.seq = value.seq;
    this.phase = "ready";
    this.message = undefined;
    this.tools.clear();
    this.handovers.length = 0;
    this.chars = 0;
  }
  private delta(value: Extract<Static<typeof frameSchema>, { t: "delta" }>): void {
    for (const item of value.settled) {
      if (item[0] !== this.seq + 1) {
        throw new Error("Invalid handover sequence.");
      }
      this.seq = item[0];
      this.leaf = item[1];
      this.handovers.push(item);
    }
    if (this.handovers.length > 256) {
      throw new Error("Journal handover stalled.");
    }
    for (const item of value.tools) {
      const tool = this.tools.get(item.id) ?? {
        id: item.id,
        name: item.name ?? "tool",
        args: item.args,
      };
      if (item.partial) {
        tool.partial = item.partial.value;
      }
      if (item.end) {
        tool.end = item.end;
      }
      this.tools.set(item.id, tool);
    }
    if (this.tools.size > 256) {
      throw new Error("Too many live tools.");
    }
    this.assistant(value.message);
  }
  private assistant(value: Static<typeof messageSchema> | undefined): void {
    if (!value) {
      return;
    }
    if (value.reset) {
      this.message = { key: value.key, ended: false, blocks: [] };
      this.chars = 0;
    }
    const message = this.message;
    if (message?.key !== value.key) {
      throw new Error("Assistant changed without reset.");
    }
    message.ended = value.ended;
    message.blocks.length = Math.min(message.blocks.length, value.count);
    for (const item of value.blocks) {
      const [index, type, first, second] = item;
      if (type === "toolCall") {
        message.blocks[index] = { type, id: first, name: second, args: item[4] };
      } else {
        message.blocks[index] = this.append(message.blocks[index], type, first, second);
      }
    }
  }
  private append(
    current: ViewedBlock | undefined,
    type: "text" | "thinking",
    offset: number,
    text: string,
  ): ViewedBlock {
    const previous = offset === 0 ? "" : current?.text;
    if (previous === undefined || previous.length !== offset) {
      throw new Error("Assistant append gap.");
    }
    this.chars += text.length;
    if (this.chars > 1024 * 1024) {
      throw new Error("Live content awaits journal publication.");
    }
    return { type, text: previous + text };
  }
  /** Retire live state only after its exact journal entries have been indexed. */
  settle(has: (entry: string) => boolean): boolean {
    while (this.handovers.length > 0 && has(this.handovers[0]?.[1] ?? "")) {
      const item = this.handovers.shift();
      if (item) {
        this.retire(item[2], item[3]);
      }
    }
    return (
      this.handovers.length === 0 &&
      (this.leaf === undefined || this.leaf === null || has(this.leaf))
    );
  }
  private retire(key: number | null, tool: string | null): void {
    if (key !== null && this.message?.key === key) {
      this.message = undefined;
    }
    for (const id of this.tools.keys()) {
      if (tool !== null && (id === tool || id.startsWith(`${tool}/`))) {
        this.tools.delete(id);
      }
    }
  }
  close(): void {
    if (!this.closed) {
      this.phase = "closing";
      this.socket.destroy();
    }
  }
}
