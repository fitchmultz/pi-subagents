import * as fs from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { JournalFrames } from "../shared/journal-reader.ts";
import { HistoryIndexError } from "./types.ts";
import { type HistoryStore, safeText, type SourceRow } from "./store.ts";
import { previewProjection, previewLimits, allowed } from "./preview.ts";
import { TextChunks } from "./text-chunks.ts";
import { AnswerTexts } from "./answer-texts.ts";
import { object } from "./values.ts";
import { identity, stamp, openSource, requireSource } from "./source-file.ts";
export { identity, stamp } from "./source-file.ts";
import { number, text } from "./rows.ts";
import { stageEntry, publishTools, type IngestRecord } from "./entry-ingestion.ts";
export { previewProjection, previewLimits, compactEntry } from "./preview.ts";

/** One physical source, incremental byte framing and short row/cursor publication transactions. */
export class SourceIngest {
  private readonly fd: number;
  private readonly initial: fs.BigIntStats;
  private source: SourceRow;
  private readonly prefix: Hash = createHash("sha256");
  private recordDigest: Hash = createHash("sha256");
  private verifyAt = 0;
  private position: number;
  private readonly frames: JournalFrames;
  private text = new TextChunks();
  private answerTexts = new AnswerTexts();
  private buffer = Buffer.alloc(0);
  private record?: IngestRecord;
  private stagedEntry?: number;
  private textCursor = 0;
  private malformed = false;
  private complexity = false;
  private phase: "verify" | "read" | "text" | "done";
  private closed = false;
  private headerSeen: boolean;
  private readonly store: Readonly<HistoryStore>;
  readonly id: string;
  constructor(store: Readonly<HistoryStore>, source: SourceRow, force = false) {
    this.store = store;
    this.id = source.id;
    const opened = openSource(store, source.id);
    this.source = opened.source;
    this.fd = opened.fd;
    this.initial = opened.initial;
    this.position = this.source.cursor;
    this.headerSeen = this.source.cursor > 0;
    this.phase = this.source.cursor > 0 ? "verify" : "read";
    if (!force && this.source.stamp === stamp(this.initial)) {
      this.phase = "done";
    }
    try {
      if (this.phase !== "done") {
        store.run("UPDATE sources SET state='indexing',error=NULL WHERE id=?", this.id);
      }
      this.frames = new JournalFrames(
        previewProjection,
        (record) => {
          this.record = {
            ...record,
            value: object(record.value),
            digest: this.recordDigest.copy().digest("hex"),
          };
        },
        {
          policy: "inspect",
          start: this.source.cursor,
          malformed: (_start, _end, error) => {
            this.malformed = true;
            this.complexity =
              error instanceof RangeError ||
              (error instanceof HistoryIndexError && error.code === "RECORD_COMPLEXITY");
          },
          stringChunk: (keys, chunk) => {
            this.text.write(keys, chunk);
            this.answerTexts.write(keys, chunk);
          },
          requireNewline: true,
          limits: previewLimits,
        },
      );
    } catch (error) {
      fs.closeSync(this.fd);
      store.endIngest();
      throw error;
    }
  }
  private published(end: number, work?: () => void): void {
    this.store.transaction(() => {
      const current = this.store.source(this.id);
      if (
        !current ||
        current.generation !== this.source.generation ||
        current.cursor !== this.source.cursor
      ) {
        throw new HistoryIndexError(
          "SOURCE_CHANGED",
          "Another writer advanced this source; reconcile before replaying.",
        );
      }
      work?.();
      this.store.run(
        "UPDATE sources SET cursor=?,prefix_digest=?,identity=? WHERE id=?",
        end,
        this.prefix.copy().digest("hex"),
        identity(this.initial),
        this.id,
      );
      this.store.bump();
    });
    this.source = { ...this.source, cursor: end };
    this.recordDigest = createHash("sha256");
    this.text = new TextChunks();
    this.answerTexts = new AnswerTexts();
    this.store.run("DELETE FROM pending_text");
    this.record = undefined;
    this.malformed = false;
    this.complexity = false;
  }
  private finishRecord(end: number): void {
    this.text.flush(this.store, true);
    if (this.malformed) {
      if (!this.headerSeen) {
        throw new Error("Malformed native session header.");
      }
      this.published(end, () => {
        this.store.run(
          "UPDATE sources SET malformed=malformed+1,complexity=complexity+? WHERE id=?",
          this.complexity ? 1 : 0,
          this.id,
        );
      });
      return;
    }
    const record = this.record;
    if (!record) {
      this.published(end);
      return;
    }
    const value = record.value;
    if (!this.headerSeen) {
      this.publishHeader(record);
      return;
    }
    if (value.type === "session") {
      throw new Error("Unexpected session header inside a native source.");
    }
    const nativeId = typeof value.id === "string" ? value.id : null;
    const id = nativeId ?? `legacy-${record.start}`;
    if (
      this.store.get(
        "SELECT rowid FROM entries WHERE source_id=? AND generation=? AND id=?",
        this.id,
        this.source.generation,
        id,
      )
    ) {
      this.published(end, () => {
        this.store.run("UPDATE sources SET malformed=malformed+1 WHERE id=?", this.id);
      });
      return;
    }
    this.stagedEntry = stageEntry(this.store, this.source, record);
    this.textCursor = 0;
    this.phase = "text";
  }
  private publishHeader(record: IngestRecord): void {
    const value = record.value;
    if (value.type !== "session") {
      throw new Error("Linked source does not have a native session header.");
    }
    const version = typeof value.version === "number" ? value.version : null;
    this.published(record.end, () => {
      this.store.run(
        "UPDATE sources SET session_id=?,header_digest=?,format_version=? WHERE id=?",
        typeof value.id === "string" ? value.id : null,
        record.digest,
        version,
        this.id,
      );
    });
    this.source = { ...this.source, format_version: version };
    this.headerSeen = true;
  }
  private verifyPrefix(): void {
    const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, this.source.cursor - this.verifyAt));
    const count = fs.readSync(this.fd, bytes, 0, bytes.length, this.verifyAt);
    if (count !== bytes.length) {
      throw new Error("Journal truncated during prefix verification.");
    }
    this.store.count("sourceBytesRead", count);
    this.prefix.update(bytes);
    this.verifyAt += count;
    if (this.verifyAt === this.source.cursor) {
      if (this.prefix.copy().digest("hex") !== this.source.prefix_digest) {
        this.store.resetSource(this.id);
        throw new HistoryIndexError(
          "SOURCE_CHANGED",
          "Journal prefix changed; a new physical generation was scheduled.",
        );
      }
      this.phase = "read";
    }
  }
  private indexText(): void {
    const record = this.record;
    const rowid = this.stagedEntry;
    if (!record || rowid === undefined) {
      throw new HistoryIndexError("CORRUPT", "Missing staged entry.");
    }
    const chunks = this.store.all(
      "SELECT rowid,* FROM pending_text WHERE rowid>? ORDER BY rowid LIMIT 32",
      this.textCursor,
    );
    if (chunks.length > 0) {
      this.store.transaction(() => {
        for (const chunk of chunks) {
          if (!allowed(record.value, text(chunk, "field"))) {
            continue;
          }
          const body = safeText(text(chunk, "text"), 1_048_576);
          const id = this.store.run(
            "INSERT INTO documents(entry_rowid,field,text_start,text_end,preview) VALUES (?,?,?,?,?)",
            rowid,
            text(chunk, "field"),
            number(chunk, "position"),
            number(chunk, "end_position"),
            safeText(body, 512),
          ).lastInsertRowid;
          this.store.run("INSERT INTO corpus(rowid,text) VALUES (?,?)", id, body);
        }
      });
      const last = chunks.at(-1);
      if (last) {
        this.textCursor = number(last, "rowid");
      }
      return;
    }
    const value = record.value;
    const answers = this.answerTexts.fingerprints(
      value,
      typeof value.id === "string" ? value.id : `legacy-${record.start}`,
    );
    this.published(record.end, () => {
      if (
        this.store.run(
          "UPDATE entries SET published=1 WHERE rowid=? AND source_id=? AND generation=? AND published=0",
          rowid,
          this.id,
          this.source.generation,
        ).changes !== 1
      ) {
        throw new HistoryIndexError(
          "SOURCE_CHANGED",
          "Staged entry disappeared before publication; reconcile before advancing the source.",
        );
      }
      for (const [digest, item] of answers) {
        this.store.run("INSERT OR IGNORE INTO answers VALUES (?,?,?)", rowid, digest, item);
      }
      publishTools(this.store, this.source, rowid, value);
    });
    this.stagedEntry = undefined;
    this.phase = "read";
  }
  /** Each pump reads <=64 KiB or indexes <=32 chunks, then returns to the IPC event loop. */
  step(): boolean {
    if (this.phase === "done") {
      this.close();
      return true;
    }
    if (this.phase === "text") {
      this.indexText();
      return false;
    }
    if (this.phase === "verify") {
      this.verifyPrefix();
      return false;
    }
    if (this.buffer.length === 0) {
      const remaining = Number(this.initial.size) - this.position;
      if (remaining <= 0) {
        return this.finish();
      }
      const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const count = fs.readSync(this.fd, bytes, 0, bytes.length, this.position);
      if (count !== bytes.length) {
        throw new Error("Journal truncated during ingestion.");
      }
      this.store.count("sourceBytesRead", count);
      this.position += count;
      this.buffer = bytes;
    }
    const newline = this.buffer.indexOf(10);
    const bytes = newline < 0 ? this.buffer : this.buffer.subarray(0, newline + 1);
    this.recordDigest.update(bytes);
    this.prefix.update(bytes);
    this.frames.write(bytes);
    this.text.flush(this.store);
    this.buffer = this.buffer.subarray(bytes.length);
    if (newline >= 0) {
      this.finishRecord(this.frames.offset);
    }
    return false;
  }
  private finish(): boolean {
    this.frames.finish();
    const now = fs.statSync(this.source.path, { bigint: true });
    if (
      identity(now) !== identity(this.initial) ||
      now.size < this.initial.size ||
      (now.size === this.initial.size && stamp(now) !== stamp(this.initial))
    ) {
      this.store.resetSource(this.id);
      throw new HistoryIndexError(
        "SOURCE_CHANGED",
        "Journal changed during ingestion; retrying its new generation.",
      );
    }
    const { malformed, complexity } = requireSource(this.store, this.id);
    this.store.run(
      "UPDATE sources SET identity=?,stamp=?,checked_at=?,state=?,error=? WHERE id=?",
      identity(this.initial),
      stamp(this.initial),
      Date.now(),
      this.sourceState(malformed),
      malformed > 0
        ? `${malformed} malformed, duplicate or over-budget LF-published records were skipped.${complexity > 0 ? ` ${complexity} exceeded bounded history structure/text budgets.` : ""}`
        : null,
      this.id,
    );
    this.phase = "done";
    this.close();
    return true;
  }
  private sourceState(malformed: number): string {
    if (malformed > 0) {
      return "degraded";
    }
    return this.source.cursor < Number(this.initial.size) ? "partial" : "current";
  }
  close(): void {
    if (!this.closed) {
      fs.closeSync(this.fd);
      this.store.endIngest();
      this.closed = true;
    }
  }
}
