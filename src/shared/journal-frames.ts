import * as fs from "node:fs";
import {
  JsonProjection,
  type Projection,
  type ProjectionLimits,
  type StringChunk,
  type KeyLimit,
} from "./json-projection.ts";
import { errorMessage, isRecord, type UnknownRecord } from "./unknown.ts";

export interface JournalRecord {
  readonly value: UnknownRecord;
  readonly start: number;
  readonly end: number;
}
export type JournalPolicy = "strict" | "live" | "inspect";
export interface JournalOptions {
  readonly policy?: JournalPolicy;
  readonly requireNewline?: boolean;
  readonly start?: number;
  readonly end?: number;
  readonly malformed?: (start: number, end: number, error: unknown) => void;
  readonly stringChunk?: StringChunk;
  readonly keys?: KeyLimit;
  readonly limits?: ProjectionLimits;
}

/** Byte-framed JSONL. Publication framing is independent of malformed-record tolerance. */
export class JournalFrames {
  private projection: JsonProjection;
  private decoder = new TextDecoder("utf8", { fatal: true });
  private error: unknown;
  private failed = false;
  private nonblank = false;
  private start: number;
  offset: number;
  private readonly policy: JournalPolicy;
  private readonly requireNewline: boolean;
  private readonly select: Projection;
  private readonly record: (record: JournalRecord) => void;
  private readonly options: JournalOptions;
  constructor(
    select: Projection,
    record: (record: JournalRecord) => void,
    options: JournalOptions = {},
  ) {
    this.select = select;
    this.record = record;
    this.options = options;
    this.policy = options.policy ?? "strict";
    this.requireNewline = options.requireNewline ?? this.policy === "live";
    this.start = options.start ?? 0;
    this.offset = this.start;
    this.projection = this.newProjection();
  }
  private newProjection(): JsonProjection {
    return new JsonProjection(
      this.select,
      this.options.stringChunk,
      this.options.keys,
      this.options.limits,
    );
  }
  private part(bytes: Buffer): void {
    if (!this.nonblank && bytes.some((byte) => ![9, 10, 13, 32].includes(byte))) {
      this.nonblank = true;
    }
    if (!this.failed) {
      try {
        this.projection.write(this.decoder.decode(bytes, { stream: true }));
      } catch (error) {
        this.failed = true;
        this.error = error;
      }
    }
  }
  private finishRecord(end: number): JournalRecord | undefined {
    if (!this.nonblank || this.failed) {
      return undefined;
    }
    try {
      this.projection.write(this.decoder.decode());
      const value = this.projection.finish();
      if (!isRecord(value)) {
        throw new SyntaxError("JSONL records must be objects");
      }
      return { value, start: this.start, end };
    } catch (error) {
      this.failed = true;
      this.error = error;
      return undefined;
    }
  }
  private commit(end: number): void {
    const start = this.start;
    const record = this.finishRecord(end);
    const failed = this.failed;
    const error = this.error;
    if (failed && this.policy !== "inspect") {
      throw new SyntaxError(`Invalid JSONL record at byte ${start}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    this.start = end;
    this.projection = this.newProjection();
    this.decoder = new TextDecoder("utf8", { fatal: true });
    this.error = undefined;
    this.failed = false;
    this.nonblank = false;
    if (failed) {
      this.options.malformed?.(start, end, error);
    } else if (record) {
      this.record(record);
    }
  }
  write(bytes: Buffer): void {
    const offset = this.offset;
    this.offset += bytes.length;
    let from = 0;
    for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, from)) {
      this.part(bytes.subarray(from, newline));
      this.commit(offset + newline + 1);
      from = newline + 1;
    }
    this.part(bytes.subarray(from));
  }
  finish(): number {
    if (this.requireNewline) {
      if (this.policy === "strict" && this.nonblank) {
        throw new SyntaxError(`Unpublished JSONL record at byte ${this.start}: newline required`);
      }
    } else if (this.offset > this.start) {
      this.commit(this.offset);
    }
    return this.start;
  }
}

export function scanJournal(
  file: string | number,
  select: Projection,
  record: (record: JournalRecord) => void,
  options: JournalOptions = {},
): number {
  const fd = typeof file === "number" ? file : fs.openSync(file, "r");
  try {
    const end = Math.min(options.end ?? Infinity, fs.fstatSync(fd).size);
    const frames = new JournalFrames(select, record, options);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let offset = options.start ?? 0; offset < end;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (count === 0) {
        throw new Error("Journal truncated while reading");
      }
      frames.write(buffer.subarray(0, count));
      offset += count;
    }
    return frames.finish();
  } finally {
    if (typeof file !== "number") {
      fs.closeSync(fd);
    }
  }
}

/** Compact owner reads never hydrate transcript arrays or historical output strings. */
export function readJsonProjection(file: string, select: Projection): UnknownRecord {
  // ponytail: selected frozen schemas and acceptance values fit their consumer's
  // heap, including arbitrary property names; discarded owner messages do not.
  const fd = fs.openSync(file, "r");
  const decoder = new TextDecoder("utf8", { fatal: true });
  const projection = new JsonProjection(select, undefined, () => Infinity);
  try {
    const end = fs.fstatSync(fd).size;
    const bytes = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < end;) {
      const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, end - offset), offset);
      if (count === 0) {
        throw new Error("JSON file truncated while reading");
      }
      projection.write(decoder.decode(bytes.subarray(0, count), { stream: true }));
      offset += count;
    }
    projection.write(decoder.decode());
    const value = projection.finish();
    if (!isRecord(value)) {
      throw new SyntaxError("Owner records must be objects");
    }
    return value;
  } catch (error) {
    throw new SyntaxError(
      `Invalid JSON file ${file}: ${error instanceof Error ? error.toString() : errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    fs.closeSync(fd);
  }
}
