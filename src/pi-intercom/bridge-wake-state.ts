import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { privateDatabase, privateFile, stateDirectory } from "./bridge-storage.ts";
import { readBridgeFile } from "./bridge-files.ts";
import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import { object } from "./bridge-protocol.ts";
import { WakeOwner, WAKE_OWNER_FILE, stoppedWakeOwner } from "./bridge-wake-owner.ts";

const HOUR_MS = 3600000;
const LIMIT = 20;
const RETRY_MS = 30000;
const MAX_BACKOFF_MS = 300000;
const FILE = "wake-quota.sqlite";
const ATTEMPTS = `CREATE TABLE wake_attempts(
  sequence INTEGER PRIMARY KEY, attemptedAt INTEGER NOT NULL,
  settledAt INTEGER, owner TEXT,
  CHECK(settledAt IS NOT NULL OR owner IS NOT NULL))`;

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid durable wake state.");
  }
  return value;
}

/** One helper ledger, independent of identity, certificate, URL and credential rotation. */
export class WakeState {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly stateDir: string;
  private readonly inode: number;
  private readonly device: number;
  private readonly owner: WakeOwner;
  private finishing = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.path = join(stateDir, FILE);
    const { db, created } = privateDatabase(stateDir, FILE);
    this.db = db;
    const stat = lstatSync(this.path);
    this.inode = stat.ino;
    this.device = stat.dev;
    try {
      if (created) {
        this.initialize();
      }
      this.verify();
      this.migrate();
      this.owner = this.createOwner();
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private verify(): void {
    const db = this.db;
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
      throw new Error("Wake ledger is corrupt.");
    }
    const meta = db.prepare("SELECT version, clock FROM wake_meta WHERE singleton=1").get();
    if (!meta || (meta.version !== 1 && meta.version !== 2)) {
      throw new Error("Unsupported wake ledger.");
    }
    integer(meta.clock);
    this.verifyAttempts(meta.version);
    for (const row of db.prepare("SELECT due, backoff FROM wake_batches").all()) {
      integer(row.due);
      const backoff = integer(row.backoff);
      if ((backoff !== 0 && backoff < RETRY_MS) || backoff > MAX_BACKOFF_MS) {
        throw new Error("Invalid wake retry state.");
      }
    }
  }

  private createOwner(): WakeOwner {
    let owner: WakeOwner | undefined;
    try {
      // Recovery holds this same ledger lock: it cannot reap a file before its owner locks it.
      return this.transaction(() => {
        owner = new WakeOwner(this.stateDir);
        return owner;
      });
    } catch (error) {
      owner?.close();
      throw error;
    }
  }

  private verifyAttempts(version: number): void {
    for (const row of this.db.prepare("SELECT attemptedAt FROM wake_attempts").all()) {
      integer(row.attemptedAt);
    }
    if (version !== 2) {
      return;
    }
    for (const row of this.db
      .prepare("SELECT attemptedAt, settledAt, owner FROM wake_attempts")
      .all()) {
      if (row.settledAt !== null) {
        if (integer(row.settledAt) < integer(row.attemptedAt)) {
          throw new Error("Invalid wake completion time.");
        }
      } else if (typeof row.owner !== "string" || !WAKE_OWNER_FILE.test(row.owner)) {
        throw new Error("Invalid open wake attempt.");
      }
    }
  }

  private initialize(): void {
    // Timestamped legacy outcomes omit crash-before-log attempts. Verified preflight may provide
    // complete history plus a bounded unknown reservation; absent proof reserves the full hour.
    const legacy = readdirSync(this.stateDir).some(
      (name) => name !== FILE && (name.endsWith(".sqlite") || name.startsWith("presence-")),
    );
    const now = Date.now();
    const attempts = this.history(now) ?? (legacy ? Array<number>(LIMIT).fill(now) : []);
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE wake_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, clock INTEGER NOT NULL);
      ${ATTEMPTS};
      CREATE TABLE wake_batches(bucket TEXT PRIMARY KEY, due INTEGER NOT NULL, backoff INTEGER NOT NULL);`);
    this.db.prepare("INSERT INTO wake_meta VALUES(1,2,?)").run(now);
    const insert = this.db.prepare("INSERT INTO wake_attempts(attemptedAt,settledAt) VALUES(?,?)");
    for (const timestamp of attempts) {
      insert.run(timestamp, timestamp);
    }
    this.db.exec("COMMIT");
  }

  private migrate(): void {
    this.transaction(() => {
      if (this.db.prepare("SELECT version FROM wake_meta").get()?.version !== 1) {
        return;
      }
      // V1 timestamps precede COMMIT/connect/TLS, so none prove when a POST finished.
      // Stop all old writers before upgrading; the new CHECK also denies their old INSERT shape.
      const now = Math.max(
        Date.now(),
        integer(this.db.prepare("SELECT clock FROM wake_meta").get()?.clock),
      );
      this.db.exec(`ALTER TABLE wake_attempts RENAME TO wake_attempts_v1; ${ATTEMPTS};`);
      this.db
        .prepare(`INSERT INTO wake_attempts(sequence,attemptedAt,settledAt)
        SELECT sequence,attemptedAt,MAX(attemptedAt,?) FROM wake_attempts_v1`)
        .run(now);
      this.db.exec("DROP TABLE wake_attempts_v1");
      this.db.prepare("UPDATE wake_meta SET version=2,clock=?").run(now);
    });
  }

  private history(now: number): number[] | undefined {
    const path = join(this.stateDir, "wake-history.json");
    let input: unknown;
    try {
      privateFile(path);
      input = JSON.parse(readBridgeFile(path, true, 1024 * 1024).toString("utf8"));
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    const raw = object(input, ["coveredSince", "stoppedAt", "attempts", "unknownAttempts"]);
    const coveredSince = integer(raw.coveredSince);
    const stoppedAt = integer(raw.stoppedAt);
    const unknownAttempts = integer(raw.unknownAttempts);
    if (
      coveredSince > stoppedAt - HOUR_MS ||
      stoppedAt > now ||
      unknownAttempts > LIMIT ||
      !isUnknownArray(raw.attempts) ||
      raw.attempts.length > 10000
    ) {
      throw new Error("Invalid legacy wake history; never reset prior usage.");
    }
    const attempts = raw.attempts.map(integer);
    if (attempts.some((timestamp) => timestamp < coveredSince || timestamp > stoppedAt)) {
      throw new Error("Attempt outside attested history coverage.");
    }
    return attempts
      .filter((timestamp) => timestamp > now - HOUR_MS)
      .concat(Array<number>(unknownAttempts).fill(now));
  }

  private validate(): void {
    stateDirectory(this.stateDir);
    privateFile(this.path);
    const stat = lstatSync(this.path);
    if (stat.ino !== this.inode || stat.dev !== this.device) {
      throw new Error("Wake ledger was replaced.");
    }
  }

  deadline(bucket: string): number {
    this.validate();
    const existing = this.db.prepare("SELECT due FROM wake_batches WHERE bucket=?").get(bucket);
    if (existing) {
      return integer(existing.due);
    }
    // First observation occurs only after mailbox FULL commit, never at the pre-write receivedAt.
    // Keep this grace durable too: new arrivals/reload/restart cannot restart an existing deadline.
    this.db
      .prepare("INSERT OR IGNORE INTO wake_batches VALUES(?,?,0)")
      .run(bucket, Date.now() + 2000);
    return integer(this.db.prepare("SELECT due FROM wake_batches WHERE bucket=?").get(bucket)?.due);
  }

  retire(bucket: string): void {
    this.validate();
    this.db.prepare("DELETE FROM wake_batches WHERE bucket=?").run(bucket);
  }

  /** Persist quota and uncertainty BEFORE dispatch. Returning a deadline means no attempt admitted. */
  reserve(bucket: string): number | undefined {
    this.retrySettlement();
    return this.transaction(() => this.reservation(bucket));
  }

  retrySettlement(): void {
    if (this.finishing) {
      this.settle();
    }
  }

  private transaction<T>(action: () => T): T {
    this.validate();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** A failed settlement stays open and must be retried before this owner can dispatch again. */
  settle(): void {
    this.finishing = true;
    this.transaction(() => this.finishOwner(this.owner.name));
    this.finishing = false;
  }

  private finishOwner(owner: string): void {
    const now = Math.max(
      Date.now(),
      integer(this.db.prepare("SELECT clock FROM wake_meta").get()?.clock),
    );
    this.db
      .prepare(`UPDATE wake_attempts SET settledAt=MAX(attemptedAt,?)
      WHERE owner=? AND settledAt IS NULL`)
      .run(now, owner);
    this.db.prepare("UPDATE wake_meta SET clock=?").run(now);
  }

  private recover(): void {
    const names = new Set(readdirSync(this.stateDir).filter((name) => WAKE_OWNER_FILE.test(name)));
    for (const row of this.db
      .prepare("SELECT DISTINCT owner FROM wake_attempts WHERE settledAt IS NULL")
      .all()) {
      if (typeof row.owner !== "string") {
        throw new Error("Invalid open wake owner.");
      }
      names.add(row.owner);
    }
    for (const name of names) {
      if (name !== this.owner.name && stoppedWakeOwner(this.stateDir, name)) {
        // The owner cannot send again. Unknown outcomes retain a full hour from this observation.
        this.finishOwner(name);
        rmSync(join(this.stateDir, name), { force: true });
      }
    }
  }

  private reservation(bucket: string): number | undefined {
    this.recover();
    const clock = integer(
      this.db.prepare("SELECT clock FROM wake_meta WHERE singleton=1").get()?.clock,
    );
    const now = Date.now();
    if (now < clock) {
      return clock;
    }
    const row = this.db.prepare("SELECT due, backoff FROM wake_batches WHERE bucket=?").get(bucket);
    if (row && integer(row.due) > now) {
      return integer(row.due);
    }
    this.db.prepare("DELETE FROM wake_attempts WHERE settledAt<=?").run(now - HOUR_MS);
    const attempts = this.db
      .prepare("SELECT settledAt FROM wake_attempts ORDER BY settledAt")
      .all();
    if (attempts.length >= LIMIT) {
      const oldest = attempts.find((attempt) => attempt.settledAt !== null);
      // Only open/unknown attempts have no expiry yet; revisit on the existing recovery backoff.
      return oldest ? integer(oldest.settledAt) + HOUR_MS : now + RETRY_MS;
    }
    const backoff = row
      ? Math.max(RETRY_MS, Math.min(integer(row.backoff) * 2, MAX_BACKOFF_MS))
      : RETRY_MS;
    this.db
      .prepare("INSERT INTO wake_attempts(attemptedAt,owner) VALUES(?,?)")
      .run(now, this.owner.name);
    this.db.prepare("UPDATE wake_meta SET clock=? WHERE singleton=1").run(now);
    this.db
      .prepare("INSERT OR REPLACE INTO wake_batches VALUES(?,?,?)")
      .run(bucket, now + backoff, backoff);
    return;
  }

  close(): void {
    try {
      this.settle();
    } finally {
      this.db.close();
      this.owner.close();
    }
  }
}
