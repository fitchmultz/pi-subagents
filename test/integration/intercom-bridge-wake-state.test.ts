import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { useFakeTimers } from "sinon";
import { WakeState } from "../../src/pi-intercom/bridge-wake-state.ts";
import { Mailbox } from "../../src/pi-intercom/bridge-mailbox.ts";
import { exec } from "../support/intercom-bridge.ts";

// SQLite owns admission accounting; HTTPS/broker lifecycle is covered in wake-budget/delivery.
test("pre-quota native state reserves one unknown-use hour, persists across reopen and clock rollback", () => {
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
});

test("stopped-helper audit preflight preserves known remaining quota plus unknown attempt reservations", async () => {
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
});

test("existing empty or unreadable quota ledger is never initialized as zero usage", () => {
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
