import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, readSync, writeSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Mailbox } from "../../src/pi-intercom/bridge-mailbox.ts";
import { WakeDeliveries } from "../../src/pi-intercom/bridge-wake.ts";
import { WakeState } from "../../src/pi-intercom/bridge-wake-state.ts";
import { isRecord } from "../../src/shared/unknown.ts";
import { numberValue, record } from "../support/assertions.ts";

const [mode, root = "", cert = "", key = ""] = process.argv.slice(2);
const hour = 3600000;

async function until(predicate: () => boolean): Promise<void> {
  const end = performance.now() + 15000;
  while (!predicate()) {
    assert.ok(performance.now() < end, "owner reached the next durable/transport boundary");
    // oxlint-disable-next-line no-await-in-loop
    await delay(5);
  }
}

function reader(): void {
  const db = new DatabaseSync(root, { readOnly: true });
  db.exec("BEGIN");
  db.prepare("SELECT count(*) FROM wake_attempts").get();
  writeSync(1, "reader_held\n");
  while (Date.now() < Number(cert)) {
    // Hold a real SQLite SHARED lock across the owner's FULL COMMIT deadline.
  }
  db.exec("COMMIT");
  db.close();
}

async function window(): Promise<void> {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  Date.now = () => realNow() + offset;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const arrivals: number[] = [];
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    arrivals.push(Date.now());
    req.resume();
    // Settlement, not just a post-COMMIT timestamp, must bound the entire wire attempt.
    setTimeout(
      () => {
        res.writeHead(202);
        res.end();
      },
      arrivals.length === 1 ? 250 : 0,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const deliveries = new WakeDeliveries(stateDir, () => true);
  const boxes: Mailbox[] = [];
  const ids: string[] = [];
  const rows = (sql: string) => {
    const db = new DatabaseSync(join(stateDir, "wake-quota.sqlite"), { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const send = (box: Mailbox) => {
    const id = randomUUID();
    assert.equal(
      box.add({
        from: { id: "sender", name: "sender", cwd: root, model: "fixture" },
        message: { id, timestamp: Date.now(), content: { text: "cold actionable request" } },
      }),
      "stored",
    );
    deliveries.changed();
    return id;
  };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // Different URLs share admission, allowing twenty attempts after one real ACK grace.
    for (let index = 0; index < 20; index++) {
      const fingerprint256 = index.toString(16).padStart(64, "0");
      deliveries.session(
        {
          fingerprint256,
          name: `bot-${index}`,
          cwd: root,
          wake: {
            envFile: join(root, "unused.env"),
            url: `https://127.0.0.1:${address.port}/${index}`,
            key: "fixture",
          },
        },
        Date.now() + 86400000,
      );
      const box = new Mailbox(stateDir, fingerprint256, true);
      boxes.push(box);
      ids.push(send(box));
    }
    const due = numberValue(rows("SELECT MIN(due) AS due FROM wake_batches")[0].due);
    child = spawn(
      process.execPath,
      [import.meta.filename, "reader", join(stateDir, "wake-quota.sqlite"), String(due + 700)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(child, "close");
    let output = "";
    assert.ok(child.stdout);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await until(() => output.includes("reader_held"));
    assert.ok(realNow() < due, "reader acquired before the first reservation");
    await until(() => arrivals.length === 20);
    await exited;
    const first = numberValue(
      rows("SELECT attemptedAt FROM wake_attempts ORDER BY sequence LIMIT 1")[0].attemptedAt,
    );
    assert.ok(arrivals[0] - first >= 650, "real COMMIT contention precedes TLS wire arrival");
    for (const [index, box] of boxes.entries()) {
      assert.deepEqual(record(box.ack([ids[index]])).acked, [ids[index]]);
    }
    deliveries.changed();
    // Only idle time is jumped; both clocks advance normally during COMMIT, TLS and dispatch.
    offset += first + hour - 2300 - Date.now();
    send(boxes[0]);
    await until(() => arrivals.length === 21);
    const span = arrivals[20] - arrivals[0];
    const trailing = arrivals.filter((at) => at > arrivals[20] - hour).length;
    console.log(JSON.stringify({ commitLag: arrivals[0] - first, wireSpan: span, trailing }));
    assert.ok(span >= hour, `twenty-first wire POST arrived after only ${span}ms`);
    assert.ok(trailing <= 20, "no more than twenty actual POSTs in a trailing hour");
  } finally {
    child?.kill("SIGKILL");
    await deliveries.stop();
    for (const box of boxes) {
      box.close();
    }
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    Date.now = realNow;
  }
}

if (mode === "reader") {
  reader();
} else if (mode === "hold") {
  Date.now = () => Number(cert);
  const state = new WakeState(root);
  for (let index = 0; index < 20; index++) {
    assert.equal(state.reserve(`listener-${index}`), undefined);
  }
  writeSync(1, "owner_holding_twenty\n");
  await delay(60000);
  state.close();
} else if (mode === "publish") {
  // Pause the real native lock call after its file exists, without supplying lock/admission results.
  // oxlint-disable-next-line typescript/unbound-method -- re-bound to the native receiver below.
  const nativeExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (sql === "BEGIN EXCLUSIVE") {
      writeSync(1, "owner_before_lock\n");
      // A pipe queues an early release; SIGCONT can arrive before SIGSTOP and be lost.
      const byte = Buffer.alloc(1);
      for (;;) {
        try {
          assert.equal(readSync(3, byte, 0, 1, null), 1, "owner gate closed without release");
          assert.equal(byte[0], 1);
          break;
        } catch (error) {
          if (!isRecord(error) || error.code !== "EAGAIN") {
            throw error;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    }
    nativeExec.call(this, sql);
  };
  const state = new WakeState(root);
  assert.equal(state.reserve("new-listener"), undefined);
  writeSync(1, "owner_admitted\n");
  await delay(60000);
  state.close();
} else {
  await window();
}
