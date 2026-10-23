import type { Socket } from "node:net";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { writeFrame } from "../pi-intercom/broker/framing.ts";
import { NAME_CHARS, type LiveState, type LiveTool } from "./observation-state.ts";

export const FRAME_BYTES = 256 * 1024 - 4;
const MAX_BUFFERED = 1024 * 1024;
const ENVELOPE_BYTES = 192;
/** Blocks past this index stay journal-only; `count` still reports the native length. */
const BLOCKS = 256;
type Block = AssistantMessage["content"][number];
export type Level = "detail" | "activity";

function short(value: string): string {
  return JSON.stringify(value.length > NAME_CHARS ? value.slice(0, NAME_CHARS) : value);
}

/** Pre-serialized pieces keep arbitrary values bounded before the frame exists. */
class Frame {
  readonly settled: string[] = [];
  readonly tools: string[] = [];
  readonly blocks: string[] = [];
  full = false;
  private bytes = ENVELOPE_BYTES;
  room(): number {
    return FRAME_BYTES - this.bytes;
  }
  take(json: string, bytes = Buffer.byteLength(json)): boolean {
    if (this.bytes + bytes + 1 > FRAME_BYTES) {
      this.full = true;
      return false;
    }
    this.bytes += bytes + 1;
    return true;
  }
  stop(): void {
    this.full = true;
  }
}

/** One viewer's position in one native content block. Text is sent as offset-addressed appends. */
class BlockCursor {
  readonly ref: Block;
  private type: Block["type"];
  private sent = 0;
  private announced = false;
  private args?: unknown;
  constructor(block: Block) {
    this.ref = block;
    this.type = block.type;
  }
  next(index: number, frame: Frame, state: LiveState): string | undefined {
    const block = this.ref;
    if (block.type !== this.type) {
      // An in-place type replacement restarts the block from offset zero.
      this.type = block.type;
      this.sent = 0;
      this.announced = false;
    }
    if (block.type === "toolCall") {
      if (this.announced && this.args === block.arguments) {
        return undefined;
      }
      const item = `[${index},"toolCall",${short(block.id)},${short(block.name)},${state.project(block.arguments)}]`;
      this.announced = frame.take(item);
      this.args = block.arguments;
      return this.announced ? item : undefined;
    }
    const text = block.type === "text" ? block.text : block.thinking;
    return this.text(`[${index},"${block.type}",`, text, frame);
  }
  private text(head: string, text: string, frame: Frame): string | undefined {
    if (text.length < this.sent) {
      this.sent = 0;
      this.announced = false;
    }
    if (this.announced && text.length === this.sent) {
      return undefined;
    }
    const prefix = `${head}${this.sent},`;
    const budget = frame.room() - prefix.length - 2;
    let end = Math.min(text.length, this.sent + Math.max(0, budget));
    while (end >= this.sent) {
      const json = JSON.stringify(text.slice(this.sent, end));
      const bytes = Buffer.byteLength(json);
      if (bytes <= budget) {
        frame.take(json, prefix.length + bytes + 1);
        if (end < text.length) {
          // The rest of this block needs another frame; keep this viewer dirty.
          frame.stop();
        }
        this.sent = end;
        this.announced = true;
        return `${prefix}${json}]`;
      }
      // Escapes and multibyte text exceed one byte per code unit; shrink proportionally.
      end = this.sent + Math.floor(((end - this.sent) * budget) / bytes) - 8;
    }
    frame.stop();
    return undefined;
  }
}

/** Per-viewer cursors. Each accepted frame advances them exactly once; nothing is resent. */
export class Viewer {
  blocked = false;
  readonly socket: Socket;
  readonly level: Level;
  activitySeen = -1;
  private activity = "";
  private seen = -1;
  private key = 0;
  private count = 0;
  private ended = false;
  private blocks: BlockCursor[] = [];
  private readonly tools = new Map<string, { readonly rev: number; readonly ended: boolean }>();
  private settled = 0;
  private evicted = 0;
  constructor(socket: Socket, level: Level) {
    this.socket = socket;
    this.level = level;
  }
  /** A baseline: the journal through `head`'s leaf plus every current live item, resent. */
  snapshot(state: LiveState, head: string, activity: string): string {
    this.settled = state.settled;
    this.evicted = state.evicted;
    this.seen = -1;
    this.key = 0;
    this.blocks = [];
    this.tools.clear();
    this.activity = activity;
    this.activitySeen = state.activityVersion;
    return `${head},"activity":${this.activity},"seq":${state.settled}}`;
  }
  /** Missed settlements or evicted live items can only be recovered from a new baseline. */
  stale(state: LiveState): boolean {
    const oldest = state.settlements[0]?.seq ?? state.settled + 1;
    return this.evicted !== state.evicted || this.settled + 1 < oldest;
  }
  wants(state: LiveState): boolean {
    return this.level === "detail" && !this.blocked && this.seen !== state.version;
  }
  delta(state: LiveState): string | undefined {
    const frame = new Frame();
    this.settle(frame, state);
    for (const tool of state.tools.values()) {
      this.tool(tool, frame, state);
    }
    for (const id of this.tools.keys()) {
      if (!state.tools.has(id)) {
        this.tools.delete(id);
      }
    }
    const message = this.message(frame, state);
    if (!frame.full) {
      this.seen = state.version;
    }
    if (frame.settled.length + frame.tools.length === 0 && message === undefined) {
      return undefined;
    }
    const fields = [
      `"t":"delta"`,
      `"settled":[${frame.settled.join(",")}]`,
      `"tools":[${frame.tools.join(",")}]`,
    ];
    return `{${[...fields, ...(message === undefined ? [] : [`"message":${message}`])].join(",")}}`;
  }
  private settle(frame: Frame, state: LiveState): void {
    for (const settlement of state.settlements) {
      if (settlement.seq <= this.settled) {
        continue;
      }
      // Settlements stay in order: one that does not fit holds back every later one.
      if (!frame.take(settlement.json)) {
        return;
      }
      frame.settled.push(settlement.json);
      this.settled = settlement.seq;
    }
  }
  private tool(tool: LiveTool, frame: Frame, state: LiveState): void {
    if (frame.full) {
      return;
    }
    const fields = this.toolFields(tool, state);
    const item = `{"id":${JSON.stringify(tool.id)},${fields.join(",")}}`;
    if (fields.length > 0 && frame.take(item)) {
      frame.tools.push(item);
      this.tools.set(tool.id, { rev: tool.rev, ended: tool.ended !== undefined });
    }
  }
  private toolFields(tool: LiveTool, state: LiveState): string[] {
    const cursor = this.tools.get(tool.id);
    const fields: string[] = [];
    if (cursor === undefined) {
      fields.push(`"name":${short(tool.name)}`, `"args":${tool.projectedArgs(state.project)}`);
    }
    if (tool.rev > (cursor?.rev ?? 0)) {
      fields.push(`"partial":{"rev":${tool.rev},"value":${tool.projectedPartial(state.project)}}`);
    }
    if (tool.ended !== undefined && cursor?.ended !== true) {
      const result = tool.projectedResult(state.project);
      fields.push(`"end":{"isError":${tool.ended.isError},"result":${result}}`);
    }
    return fields;
  }
  private message(frame: Frame, state: LiveState): string | undefined {
    const live = state.message;
    if (live === undefined) {
      return undefined;
    }
    const reset = this.key !== live.key;
    if (reset) {
      this.key = live.key;
      this.blocks = [];
      this.count = 0;
      this.ended = false;
    }
    const content = live.message.content;
    const changed = reset || content.length !== this.count || live.ended !== this.ended;
    this.count = content.length;
    this.ended = live.ended;
    const limit = Math.min(content.length, BLOCKS);
    this.blocks.length = Math.min(this.blocks.length, limit);
    for (let index = 0; index < limit && !frame.full; index++) {
      const item = this.cursor(index, content[index]).next(index, frame, state);
      if (item !== undefined) {
        frame.blocks.push(item);
      }
    }
    if (!changed && frame.blocks.length === 0) {
      return undefined;
    }
    // An ended message stays live until its session entry is found and handed over.
    return `{"key":${live.key},"reset":${reset},"ended":${live.ended},"count":${content.length},"blocks":[${frame.blocks.join(",")}]}`;
  }
  private cursor(index: number, block: Block): BlockCursor {
    const existing = this.blocks.at(index);
    if (existing?.ref === block) {
      return existing;
    }
    // A replaced native block is resent from offset zero.
    const cursor = new BlockCursor(block);
    this.blocks[index] = cursor;
    return cursor;
  }
  activityFrame(state: LiveState, activity: string): string | undefined {
    if (this.blocked) {
      return undefined;
    }
    this.activitySeen = state.activityVersion;
    if (this.activity === activity) {
      return undefined;
    }
    this.activity = activity;
    return `{"t":"activity","activity":${activity}}`;
  }
  /** `false` from Node means accepted but buffered: wait for drain, never resend. */
  write(json: string): number {
    this.blocked = !writeFrame(this.socket, json, FRAME_BYTES);
    const buffered = this.socket.writableLength;
    if (buffered > MAX_BUFFERED) {
      this.socket.destroy();
    }
    return buffered;
  }
}
