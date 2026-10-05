import * as fs from "node:fs";
import { scanJournal, type JournalPolicy, type JournalRecord } from "./journal-frames.ts";
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
  readonly stamp: string;
  readonly end: number;
  readonly file: string;
  constructor(file: string, policy: JournalPolicy = "inspect", requireNewline = policy === "live") {
    this.file = file;
    const fd = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      this.stamp = journalStamp(stat);
      this.end = Number(stat.size);
      let parent: string | null = null;
      scanJournal(
        fd,
        nativeProjection,
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
        { policy, requireNewline, end: this.end },
      );
      if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== this.stamp) {
        throw new Error("Journal changed while indexing; refresh history.");
      }
    } finally {
      fs.closeSync(fd);
    }
    if (this.records[0]?.value.type !== "session") {
      throw new Error("Not a readable native Pi session.");
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
export function journalStamp(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
