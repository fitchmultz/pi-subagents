import * as fs from "node:fs";
import { JournalFrames, type JournalPolicy, type JournalRecord } from "./journal-frames.ts";
import type { Projection, StringChunk } from "./json-projection.ts";
import { nativeProjection } from "./journal-projections.ts";
import { isRecord, recordAt, type UnknownRecord } from "./unknown.ts";

/** A selected journal entry is not a complete SDK SessionEntry or Message. */
export interface NativePreview extends UnknownRecord {
  readonly id: string;
  readonly type: string;
  readonly parentId?: string | null;
  readonly timestamp?: string;
}
export interface NativeRecord extends JournalRecord {
  readonly value: NativePreview;
}
function preview(
  record: JournalRecord,
  parent: string | null,
  legacy: boolean,
): NativeRecord | undefined {
  const entry = record.value;
  if (typeof entry.type !== "string") {
    return undefined;
  }
  const id = typeof entry.id === "string" ? entry.id : `legacy-${record.start}`;
  const parentId = legacy ? parent : entry.parentId;
  const value: NativePreview = {
    ...entry,
    type: entry.type,
    id,
    parentId: typeof parentId === "string" || parentId === null ? parentId : undefined,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
  };
  return { value, start: record.start, end: record.end };
}
function configurationModel(value: NativePreview): string | undefined {
  const message = recordAt(value, "message");
  const provider = value.type === "model_change" ? value.provider : message?.provider;
  const model = value.type === "model_change" ? value.modelId : message?.model;
  return typeof provider === "string" && typeof model === "string"
    ? `${provider}/${model}`
    : undefined;
}
export class NativeJournal {
  readonly records: NativeRecord[] = [];
  readonly byId = new Map<string, NativeRecord>();
  stamp: string;
  end: number;
  readonly file: string;
  private readonly identity: string;
  private offset = 0;
  private readonly frames: JournalFrames;
  constructor(
    file: string,
    policy: JournalPolicy = "inspect",
    requireNewline = policy === "live",
    options: { readBytes?: number; select?: Projection } = {},
  ) {
    this.file = file;
    let parent: string | null = null;
    this.frames = new JournalFrames(
      options.select ?? nativeProjection,
      (raw) => {
        const record = preview(raw, parent, this.records[0]?.value.version === 1);
        if (!record) {
          if (policy !== "inspect") {
            throw new SyntaxError(`Native record at byte ${raw.start} requires a type`);
          }
          return;
        }
        if (record.value.type !== "session") {
          parent = record.value.id;
        }
        this.records.push(record);
        this.byId.set(record.value.id, record);
      },
      { policy, requireNewline },
    );
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (policy === "live" ? fs.constants.O_NOFOLLOW : 0),
    );
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      this.stamp = journalStamp(stat);
      this.identity = `${stat.dev}:${stat.ino}`;
      this.end = Number(stat.size);
      this.index(fd, Math.min(this.end, options.readBytes ?? Infinity));
      this.checkInitial(stat, fs.fstatSync(fd, { bigint: true }), policy);
    } finally {
      fs.closeSync(fd);
    }
    if (this.records[0]?.value.type !== "session") {
      throw new Error("Not a readable native Pi session.");
    }
  }
  private checkInitial(before: fs.BigIntStats, after: fs.BigIntStats, policy: JournalPolicy): void {
    if (
      journalStamp(after) !== this.stamp &&
      (policy !== "live" ||
        after.size < before.size ||
        `${after.dev}:${after.ino}` !== this.identity)
    ) {
      throw new Error("Journal changed while indexing; refresh history.");
    }
  }
  private index(fd: number, end: number): void {
    const buffer = Buffer.allocUnsafe(65536);
    while (this.offset < end) {
      const count = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, end - this.offset),
        this.offset,
      );
      if (count === 0) {
        throw new Error("Journal truncated while reading");
      }
      this.frames.write(buffer.subarray(0, count));
      this.offset += count;
    }
    this.frames.finish();
  }
  get indexed(): boolean {
    return this.offset === this.end;
  }
  /** Incremental, LF-published indexing. Append work is budgeted independently of paint. */
  refresh(bytes = 256 * 1024): boolean {
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (`${stat.dev}:${stat.ino}` !== this.identity || Number(stat.size) < this.offset) {
        throw new Error("Native journal was replaced or truncated; reopen this conversation.");
      }
      if (journalStamp(stat) === this.stamp && this.indexed) {
        return false;
      }
      const previous = this.records.length;
      this.end = Number(stat.size);
      this.index(fd, Math.min(this.end, this.offset + bytes));
      this.stamp = journalStamp(stat);
      return previous !== this.records.length;
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Project one immutable, published record, including bounded slices of very large strings. */
  async project(
    record: NativeRecord,
    select: Projection,
    stringChunk?: StringChunk,
    signal?: AbortSignal,
  ): Promise<UnknownRecord> {
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let stream: fs.ReadStream | undefined;
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (`${stat.dev}:${stat.ino}` !== this.identity || Number(stat.size) < record.end) {
        throw new Error("Native journal was replaced or truncated.");
      }
      let value: UnknownRecord | undefined;
      const frames = new JournalFrames(
        select,
        (entry) => {
          value = entry.value;
        },
        { policy: "live", start: record.start, stringChunk },
      );
      stream = fs.createReadStream(this.file, {
        fd,
        start: record.start,
        end: record.end - 1,
        highWaterMark: 65536,
        signal,
      });
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) {
          throw new TypeError("Native journal reads require bytes.");
        }
        frames.write(chunk);
      }
      frames.finish();
      if (!value) {
        throw new Error("Native entry is not published.");
      }
      return value;
    } finally {
      if (stream) {
        stream.destroy();
      } else {
        fs.closeSync(fd);
      }
    }
  }
  branch(leaf?: string | null, endedAt?: number): NativeRecord[] {
    if (leaf === null) {
      return [];
    }
    const eligible =
      endedAt === undefined
        ? this.records
        : this.records.filter(
            (record) =>
              record.value.type === "session" ||
              Date.parse(record.value.timestamp ?? "") <= endedAt,
          );
    let current =
      leaf !== undefined && leaf !== ""
        ? this.byId.get(leaf)
        : eligible.findLast((record) => record.value.type !== "session");
    const path: NativeRecord[] = [];
    const seen = new Set<string>();
    const allowed = new Set(eligible.map((record) => record.value.id));
    while (current && current.value.type !== "session" && allowed.has(current.value.id)) {
      if (seen.has(current.value.id)) {
        throw new Error("Cyclic journal ancestry");
      }
      seen.add(current.value.id);
      path.push(current);
      const parentId = current.value.parentId;
      current = typeof parentId === "string" ? this.byId.get(parentId) : undefined;
    }
    return path.reverse();
  }
  body(record: NativeRecord): UnknownRecord {
    const fd = fs.openSync(this.file, "r");
    try {
      if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== this.stamp) {
        throw new Error("Journal changed; refresh before reading history.");
      }
      // ponytail: requested individual bodies must fit the consumer's heap;
      // metadata and previews remain bounded. Use pages for large output.
      const bytes = Buffer.alloc(record.end - record.start);
      if (fs.readSync(fd, bytes, 0, bytes.length, record.start) !== bytes.length) {
        throw new Error("Journal truncated");
      }
      const body: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
      if (!isRecord(body)) {
        throw new SyntaxError("Native journal body must be an object");
      }
      if (body.type !== "session") {
        body.id ??= record.value.id;
        body.parentId ??= record.value.parentId;
      }
      return body;
    } finally {
      fs.closeSync(fd);
    }
  }
  configuration(
    endedAt?: number,
    leaf?: string | null,
  ): {
    model?: string;
    thinking?: string;
    modelRecordedAt?: number;
  } {
    const result: ReturnType<NativeJournal["configuration"]> = {};
    let model: NativePreview | undefined;
    for (const { value } of this.branch(leaf, endedAt)) {
      if (value.type === "thinking_level_change" && typeof value.thinkingLevel === "string") {
        result.thinking = value.thinkingLevel;
      }
      if (
        value.type === "model_change" ||
        (value.type === "message" && recordAt(value, "message")?.role === "assistant")
      ) {
        model = value;
      }
    }
    if (model) {
      result.model = configurationModel(model);
      result.modelRecordedAt = Date.parse(model.timestamp ?? "");
    }
    return result;
  }
}
/** Native v3 writers append after attachment; loading older formats can rewrite in place.
 * Outside prefix edits followed by same-inode growth are not an append-only operation.
 */
export function nativeAppend(
  before: fs.BigIntStats,
  after: fs.BigIntStats,
  header: UnknownRecord | undefined,
): boolean {
  return (
    header?.type === "session" &&
    header.version === 3 &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    after.size > before.size
  );
}
export function journalStamp(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
