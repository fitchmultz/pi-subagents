import type { DatabaseSync } from "node:sqlite";
import { privateDatabase } from "./bridge-storage.ts";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import { normalizeMessage, normalizeSessionInfo, type Message, type SessionInfo } from "./types.ts";
import {
  Fault,
  INBOX_BYTES,
  INBOX_COUNT,
  fingerprint as certificateFingerprint,
} from "./bridge-protocol.ts";

export interface Envelope {
  readonly from: SessionInfo;
  readonly message: Message;
}

interface Entry extends Envelope {
  readonly sequence: number;
  readonly bytes: number;
  readonly receivedAt: number;
  readonly acked: number;
}

export interface InboxPage {
  readonly messages: readonly Envelope[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}
export interface PendingNotification extends Envelope {
  readonly receivedAt: number;
  readonly acknowledged: boolean;
}
export interface NotificationPage extends InboxPage {
  readonly messages: readonly PendingNotification[];
}

function database(stateDir: string, fingerprint: string): DatabaseSync {
  const { db } = privateDatabase(stateDir, `${certificateFingerprint(fingerprint)}.sqlite`);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        envelope TEXT,
        bytes INTEGER NOT NULL,
        ask INTEGER NOT NULL,
        receivedAt INTEGER NOT NULL,
        acked INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS unread ON mailbox(sequence) WHERE acked=0;
      CREATE INDEX IF NOT EXISTS asks ON mailbox(ask) WHERE ask=1 AND acked=0;
      CREATE INDEX IF NOT EXISTS notifications ON mailbox(sequence) WHERE notified=0;
      CREATE TABLE IF NOT EXISTS losses (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        count INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO losses VALUES(1, 0);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function decode(value: unknown): Envelope {
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : undefined;
  const from = isRecord(raw) ? normalizeSessionInfo(raw.from) : null;
  const message = isRecord(raw) ? normalizeMessage(raw.message) : null;
  if (!from || !message) {
    throw new Fault(507, "mailbox_storage_failed", "Stored mailbox entry is invalid.");
  }
  return { from, message };
}

/** Persistent payloads leave only ID tombstones after acknowledgement, preventing replay resurrection. */
export class Mailbox {
  private readonly db?: DatabaseSync;
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private sequence = 0;
  private failure?: Fault;
  private admissionFailed = false;
  private readonly notifications: boolean;

  constructor(stateDir: string | undefined, fingerprint: string, notifications = false) {
    try {
      this.db = stateDir === undefined ? undefined : database(stateDir, fingerprint);
    } catch {
      throw new Fault(507, "mailbox_storage_failed", "Cannot open private mailbox storage.");
    }
    this.notifications = notifications;
  }
  get persistent(): boolean {
    return this.db !== undefined;
  }
  private stored<T>(action: () => T): T {
    if (this.failure) {
      throw this.failure;
    }
    try {
      return action();
    } catch (error) {
      throw error instanceof Fault
        ? error
        : new Fault(507, "mailbox_storage_failed", "Mailbox storage operation failed.");
    }
  }
  add(envelope: Envelope): "stored" | "duplicate" | "lost" {
    if (!this.db) {
      return this.addVolatile(envelope);
    }
    const db = this.db;
    return this.stored(() => {
      try {
        const payload = JSON.stringify(envelope);
        const inserted = db
          .prepare(
            "INSERT OR IGNORE INTO mailbox(id,envelope,bytes,ask,receivedAt,notified) VALUES(?,?,?,?,?,?)",
          )
          .run(
            envelope.message.id,
            payload,
            Buffer.byteLength(payload),
            envelope.message.expectsReply === true ? 1 : 0,
            Date.now(),
            this.notifications ? 0 : 1,
          );
        this.admissionFailed = false;
        return inserted.changes === 0 ? "duplicate" : "stored";
      } catch {
        this.admissionFailed = true;
        try {
          db.prepare(
            "UPDATE losses SET count=MIN(count+1,9007199254740991) WHERE singleton=1",
          ).run();
        } catch {
          this.failure = new Fault(
            507,
            "mailbox_storage_failed",
            "Mailbox admission and loss recording failed; loss count is not durable.",
            { lossRecorded: false },
          );
          throw this.failure;
        }
        return "lost";
      }
    });
  }
  private addVolatile(envelope: Envelope): "stored" | "duplicate" | "lost" {
    if (this.entries.has(envelope.message.id)) {
      return "duplicate";
    }
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (this.entries.size >= INBOX_COUNT || this.bytes + bytes > INBOX_BYTES) {
      return "lost";
    }
    this.entries.set(envelope.message.id, {
      ...envelope,
      bytes,
      sequence: ++this.sequence,
      receivedAt: Date.now(),
      acked: 0,
    });
    this.bytes += bytes;
    return "stored";
  }
  get(id: string): Envelope | undefined {
    if (!this.db) {
      return this.entries.get(id);
    }
    const db = this.db;
    return this.stored(() => {
      const row = db.prepare("SELECT envelope FROM mailbox WHERE id=? AND acked=0").get(id);
      return row ? decode(row.envelope) : undefined;
    });
  }
  remove(id: string): void {
    if (this.db) {
      const db = this.db;
      this.stored(() =>
        db
          .prepare(
            "UPDATE mailbox SET acked=1, envelope=CASE WHEN notified=1 THEN NULL ELSE envelope END, bytes=CASE WHEN notified=1 THEN 0 ELSE bytes END WHERE id=?",
          )
          .run(id),
      );
      return;
    }
    const entry = this.entries.get(id);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(id);
    }
  }
  ack(ids: readonly string[]): UnknownRecord {
    const acked: string[] = [];
    for (const id of ids) {
      const entry = this.get(id);
      if (entry) {
        this.notificationAccepted(id);
        this.remove(id);
        acked.push(id);
      }
    }
    return { acked };
  }
  page(after: number, limit: number): InboxPage {
    return this.readPage(after, limit, false);
  }
  pendingNotifications(after = 0, limit = INBOX_COUNT): NotificationPage {
    return this.readPage(after, limit, true);
  }
  notificationAccepted(id: string): void {
    const db = this.db;
    if (db) {
      this.stored(() =>
        db
          .prepare(
            "UPDATE mailbox SET notified=1, envelope=CASE WHEN acked=1 THEN NULL ELSE envelope END, bytes=CASE WHEN acked=1 THEN 0 ELSE bytes END WHERE id=?",
          )
          .run(id),
      );
    }
  }
  private readPage(after: number, limit: number, notifications: true): NotificationPage;
  private readPage(after: number, limit: number, notifications: false): InboxPage;
  private readPage(after: number, limit: number, notifications: boolean): InboxPage {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > INBOX_COUNT
    ) {
      throw new Fault(400, "invalid_input", "Invalid mailbox page bounds.");
    }
    return this.stored(() => {
      const candidates = this.candidates(after, limit, notifications);
      const messages: (Envelope & {
        readonly receivedAt?: number;
        readonly acknowledged?: boolean;
      })[] = [];
      let bytes = 0;
      let cursor = after;
      let hasMore = false;
      for (const candidate of candidates) {
        const row = indexRow(candidate);
        if (messages.length === limit || (messages.length > 0 && bytes + row.bytes > INBOX_BYTES)) {
          hasMore = true;
          break;
        }
        const envelope = decode(
          isRecord(candidate) && typeof candidate.envelope === "string"
            ? candidate.envelope
            : JSON.stringify(candidate),
        );
        messages.push(
          notifications
            ? { ...envelope, receivedAt: row.receivedAt, acknowledged: row.acked === 1 }
            : envelope,
        );
        bytes += row.bytes;
        cursor = row.sequence;
      }
      return { messages, nextCursor: String(cursor), hasMore };
    });
  }
  private candidates(after: number, limit: number, notifications: boolean) {
    if (this.db) {
      return this.db
        .prepare(
          `SELECT sequence,bytes,receivedAt,acked,envelope FROM mailbox WHERE ${notifications ? "notified=0" : "acked=0"} AND sequence>? ORDER BY sequence LIMIT ?`,
        )
        .iterate(after, limit + 1);
    }
    return notifications
      ? []
      : [...this.entries.values()].filter((entry) => entry.sequence > after).slice(0, limit + 1);
  }
  status(volatileLosses: number): UnknownRecord {
    const db = this.db;
    const lostMessages = db
      ? this.stored(() => db.prepare("SELECT count FROM losses WHERE singleton=1").get()?.count)
      : volatileLosses;
    if (typeof lostMessages !== "number") {
      throw new Fault(507, "mailbox_storage_failed", "Stored loss counter is invalid.");
    }
    return {
      lostMessages,
      overflow: lostMessages > 0,
      storageError: this.persistent && lostMessages > 0,
    };
  }
  presence(): { readonly pendingAsks: number; readonly acceptsAsks: boolean } {
    const db = this.db;
    if (!db) {
      return {
        pendingAsks: [...this.entries.values()].filter(
          (entry) => entry.message.expectsReply === true,
        ).length,
        acceptsAsks: this.entries.size < INBOX_COUNT && this.bytes < INBOX_BYTES,
      };
    }
    return this.stored(() => {
      const pendingAsks = db
        .prepare("SELECT COUNT(*) AS count FROM mailbox WHERE ask=1 AND acked=0")
        .get()?.count;
      if (typeof pendingAsks !== "number") {
        throw new Fault(507, "mailbox_storage_failed", "Stored ask counter is invalid.");
      }
      return { pendingAsks, acceptsAsks: !this.admissionFailed };
    });
  }
  close(): number {
    this.db?.close();
    const discarded = this.entries.size;
    this.entries.clear();
    this.bytes = 0;
    return discarded;
  }
}

function indexRow(row: unknown) {
  if (!isRecord(row)) {
    throw new Fault(507, "mailbox_storage_failed", "Stored mailbox index is invalid.");
  }
  const { sequence, bytes, receivedAt, acked } = row;
  if (
    typeof sequence !== "number" ||
    typeof bytes !== "number" ||
    typeof receivedAt !== "number" ||
    typeof acked !== "number"
  ) {
    throw new Fault(507, "mailbox_storage_failed", "Stored mailbox index is invalid.");
  }
  return { sequence, bytes, receivedAt, acked };
}
