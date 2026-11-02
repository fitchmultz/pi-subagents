import "../support/isolated-home.ts";
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Duplex } from "node:stream";
import { useFakeTimers } from "sinon";
import { WakeState } from "../../src/pi-intercom/bridge-wake-state.ts";
import { Mailbox } from "../../src/pi-intercom/bridge-mailbox.ts";
import { exec, start, stop } from "../support/intercom-bridge.ts";

// SQLite owns admission accounting; HTTPS/broker lifecycle is covered in wake-budget/delivery.
nodeTest(
  "pre-quota native state reserves one unknown-use hour, persists across reopen and clock rollback",
  () => {
    const root = mkdtempSync("/tmp/pib-migrate-");
    chmodSync(root, 0o700);
    const clock = useFakeTimers({ now: 1800000000000, toFake: ["Date"] });
    let state: WakeState | undefined;
    try {
      const legacy = new Mailbox(root, "AA".repeat(32), true);
      legacy.close();
      state = new WakeState(root);
      assert.equal(
        state.reserve("first-url"),
        1800003600000,
        "prior audit has no reliable attempt timestamps",
      );
      state.close();
      state = new WakeState(root);
      clock.setSystemTime(1799999999000);
      assert.equal(
        state.reserve("rotated-url"),
        1800000000000,
        "rollback cannot expire prior reservations early",
      );
      clock.setSystemTime(1800003599999);
      assert.equal(state.reserve("second-bot"), 1800003600000);
      clock.setSystemTime(1800003600000);
      assert.equal(
        state.reserve("second-bot"),
        undefined,
        "budget expiry admits pending recovery without another hour delay",
      );
      state.close();
      state = new WakeState(root);
      assert.equal(
        state.reserve("second-bot"),
        1800003630000,
        "crash uncertainty survives reopen before POST",
      );
    } finally {
      state?.close();
      clock.restore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

nodeTest(
  "stopped-helper audit preflight preserves known remaining quota plus unknown attempt reservations",
  async () => {
    const root = mkdtempSync("/tmp/pib-history-");
    chmodSync(root, 0o700);
    let state: WakeState | undefined;
    try {
      new Mailbox(root, "AB".repeat(32), true).close();
      const stopped = spawnSync(process.execPath, ["-e", ""]);
      assert.equal(stopped.status, 0);
      const now = Date.now();
      const audit = join(root, "audit.jsonl");
      writeFileSync(
        audit,
        ["accepted", "http_rejected", "transport_unconfirmed"]
          .map((result) =>
            JSON.stringify({
              timestamp: new Date(now - 20000).toISOString(),
              event: "wake_delivery",
              result,
            }),
          )
          .join("\n"),
        { mode: 0o600 },
      );
      await exec(process.execPath, [
        resolve(import.meta.dirname, "../../scripts/intercom-bridge-wake-preflight.mjs"),
        "--state-dir",
        root,
        "--audit",
        audit,
        "--complete-since",
        new Date(now - 3601000).toISOString(),
        "--stopped-at",
        new Date(now).toISOString(),
        "--stopped-pid",
        String(stopped.pid),
        "--unknown-attempts",
        "2",
      ]);
      state = new WakeState(root);
      for (let index = 0; index < 15; index++) {
        assert.equal(
          state.reserve(`url-${index}`),
          undefined,
          "known remaining capacity wakes without first-hour hold",
        );
      }
      assert.ok(
        typeof state.reserve("twenty-first") === "number",
        "three recorded plus two unknown plus fifteen new attempts exhaust allowance",
      );
      state.close();
      state = new WakeState(root);
      assert.ok(
        typeof state.reserve("restart-url") === "number",
        "preflight is consumed only at initial ledger creation",
      );
    } finally {
      state?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

nodeTest("existing empty or unreadable quota ledger is never initialized as zero usage", () => {
  const root = mkdtempSync("/tmp/pib-ledger-");
  chmodSync(root, 0o700);
  const path = join(root, "wake-quota.sqlite");
  try {
    writeFileSync(path, "", { mode: 0o600 });
    assert.throws(() => new WakeState(root), /wake_meta/);
    chmodSync(path, 0o644);
    assert.throws(() => new WakeState(root), /mode 0600/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

nodeTest(
  "version-1 history gains a single conservative completion window without resetting batches",
  () => {
    const root = mkdtempSync("/tmp/pib-v1-");
    const now = 1800000000000;
    const clock = useFakeTimers({ now, toFake: ["Date"] });
    let state: WakeState | undefined;
    try {
      const path = join(root, "wake-quota.sqlite");
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE wake_meta(singleton INTEGER PRIMARY KEY,version INTEGER,clock INTEGER);
      INSERT INTO wake_meta VALUES(1,1,${now});
      CREATE TABLE wake_attempts(sequence INTEGER PRIMARY KEY,attemptedAt INTEGER NOT NULL);
      CREATE TABLE wake_batches(bucket TEXT PRIMARY KEY,due INTEGER,backoff INTEGER);
      INSERT INTO wake_batches VALUES('retained',${now + 30000},30000);`);
      for (let index = 0; index < 20; index++) {
        db.prepare("INSERT INTO wake_attempts(attemptedAt) VALUES(?)").run(now - 3599000);
      }
      db.close();
      chmodSync(path, 0o600);
      state = new WakeState(root);
      const migrated = new DatabaseSync(path);
      try {
        const batch = migrated.prepare("SELECT due,backoff FROM wake_batches").get();
        assert.equal(batch?.due, now + 30000);
        assert.equal(batch.backoff, 30000);
        assert.throws(
          () => migrated.prepare("INSERT INTO wake_attempts(attemptedAt) VALUES(?)").run(now),
          /CHECK constraint failed/,
          "an old listener cannot keep inserting pre-send-only timestamps",
        );
      } finally {
        migrated.close();
      }
      assert.equal(state.reserve("rotated"), now + 3600000);
      state.close();
      clock.setSystemTime(now + 1800000);
      state = new WakeState(root);
      assert.equal(state.reserve("another-listener"), now + 3600000, "reopen cannot reseed usage");
      clock.setSystemTime(now + 3599999);
      assert.equal(state.reserve("another-listener"), now + 3600000);
      clock.setSystemTime(now + 3600000);
      assert.equal(
        state.reserve("another-listener"),
        undefined,
        "retained work eventually resumes",
      );
    } finally {
      state?.close();
      clock.restore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

nodeTest(
  "a live shared listener never ages out open attempts; SIGKILL recovery retains one full hour",
  async () => {
    const root = mkdtempSync("/tmp/pib-owner-");
    const now = 1800000000000;
    const clock = useFakeTimers({ now, toFake: ["Date"] });
    let state: WakeState | undefined;
    const child = start(
      "test/fixtures/intercom-wake-window.ts",
      ["hold", root, String(now)],
      process.env,
    );
    try {
      await child.wait(/owner_holding_twenty/);
      state = new WakeState(root);
      clock.setSystemTime(now + 3600000);
      assert.equal(state.reserve("other-listener"), now + 3630000, "live owner has no expiry");
      const exited = once(child.child, "close");
      child.child.kill("SIGKILL");
      await exited;
      assert.equal(
        state.reserve("other-listener"),
        now + 7200000,
        "abandoned attempts count from observed owner exit, not reservation",
      );
      state.close();
      clock.setSystemTime(now + 7199999);
      state = new WakeState(root);
      assert.equal(state.reserve("new-listener"), now + 7200000);
      clock.setSystemTime(now + 7200000);
      assert.equal(state.reserve("new-listener"), undefined);
    } finally {
      await stop(child.child);
      state?.close();
      clock.restore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

nodeTest(
  "failed completion writes remain open and retry durably before a subsequent reservation",
  () => {
    const root = mkdtempSync("/tmp/pib-settle-");
    const now = 1800000000000;
    const clock = useFakeTimers({ now, toFake: ["Date"] });
    const state = new WakeState(root);
    const path = join(root, "wake-quota.sqlite");
    try {
      assert.equal(state.reserve("first"), undefined);
      clock.setSystemTime(now + 500);
      chmodSync(path, 0o644);
      assert.throws(() => state.settle(), /mode 0600/);
      assert.throws(() => state.reserve("second"), /mode 0600/);
      chmodSync(path, 0o600);
      clock.setSystemTime(now + 3600000);
      assert.equal(state.reserve("second"), undefined);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const rows = db.prepare("SELECT settledAt FROM wake_attempts ORDER BY sequence").all();
        assert.equal(rows.length, 2, "failed completion cannot drop the original slot");
        const [retriedRow, openRow] = rows;
        assert.ok(retriedRow !== undefined && openRow !== undefined, "expected two attempt rows");
        assert.equal(retriedRow.settledAt, now + 3600000, "retry uses the later durable bound");
        assert.equal(openRow.settledAt, null, "new attempt is still open before transport settles");
      } finally {
        db.close();
      }
    } finally {
      chmodSync(path, 0o600);
      state.close();
      clock.restore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

nodeTest(
  "shared recovery cannot reap a listener between owner-file creation and native lock acquisition",
  async (t) => {
    const root = mkdtempSync("/tmp/pib-owner-publish-");
    const observer = new WakeState(root);
    const originalFiles = readdirSync(root);
    const child = start(
      "test/fixtures/intercom-wake-window.ts",
      ["publish", root],
      process.env,
      true,
    );
    try {
      const gate = child.child.stdio[3];
      assert.ok(gate instanceof Duplex);
      await child.wait(/owner_before_lock/);
      const created = readdirSync(root).filter((name) => !originalFiles.includes(name));
      assert.equal(created.length, 1, "the new listener has published exactly one owner file");
      let failure: unknown;
      try {
        observer.reserve("existing-listener");
      } catch (error) {
        failure = error;
      }
      const [createdFile] = created;
      assert.ok(createdFile !== undefined, "expected one created owner file");
      const retained = readdirSync(root).includes(createdFile);
      t.diagnostic(
        JSON.stringify({ ownerRetained: retained, peerAdmitted: !(failure instanceof Error) }),
      );
      gate.end(Buffer.from([1]));
      await child.wait(/owner_admitted/);
      assert.ok(retained, "a concurrent listener must not reap the initializing owner");
      assert.ok(failure instanceof Error, "the ledger lock fails closed during owner publication");
      assert.equal(
        Reflect.get(failure, "errcode"),
        5,
        "actual SQLite BUSY, not a missing owner file or fabricated admission",
      );
    } finally {
      await stop(child.child);
      observer.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

nodeTest(
  "failed owner-publication COMMIT closes its OS lock and removes only its unpublished owner",
  async () => {
    const root = mkdtempSync("/tmp/pib-owner-commit-");
    const observer = new WakeState(root);
    const originalOwners = readdirSync(root).filter((name) => name.endsWith(".lock"));
    const child = start(
      "test/fixtures/intercom-wake-window.ts",
      ["publish", root],
      process.env,
      true,
    );
    const reader = new DatabaseSync(join(root, "wake-quota.sqlite"), { readOnly: true });
    try {
      const gate = child.child.stdio[3];
      assert.ok(gate instanceof Duplex);
      await child.wait(/owner_before_lock/);
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM wake_attempts").get();
      const exited = once(child.child, "close");
      gate.end(Buffer.from([1]));
      await exited;
      assert.equal(child.child.exitCode, 1, "the real blocked FULL COMMIT fails startup closed");
      assert.match(child.output(), /database is locked/);
      assert.ok(!child.output().includes("owner_admitted"));
      assert.deepEqual(
        readdirSync(root).filter((name) => name.endsWith(".lock")),
        originalOwners,
        "a failed COMMIT cannot leave a live orphan owner lock or remove the other listener",
      );
      reader.exec("COMMIT");
      assert.equal(
        observer.reserve("existing-listener"),
        undefined,
        "retained listener still works",
      );
    } finally {
      await stop(child.child);
      reader.close();
      observer.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
