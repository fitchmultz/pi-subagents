import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import koffi from "koffi";
import { OwnedProcesses, run } from "../../scripts/compat-process.mjs";
import { processSnapshot } from "../../scripts/compat-process-observation.mjs";
import { readChildProcessIdentity } from "../../src/shared/post-exit-stdio-guard.ts";

// The keeper owns its fixture roots, even when actual CI launches it in WORK.
// Preserve enclosing OWNER tokens so leaked fixtures remain visible upstream.
delete process.env.PI_COMPAT_GUARDIAN_ROOT;
delete process.env.PI_COMPAT_GUARDIAN_PID;

const runner = new URL("../../scripts/compat-process.mjs", import.meta.url).href;
const suiteRunner = new URL("../../scripts/run-tests.mjs", import.meta.url).pathname;
const brokerSpawn = new URL("../../src/pi-intercom/broker/spawn.ts", import.meta.url).href;
const agentDirectory = new URL("../../src/pi-intercom/agent-dir.ts", import.meta.url).href;

// Independent public-SDK fixture observation, not the owner's query/decoder.
let fixtureNative;
function nativeAPI() {
  fixtureNative ??= {
    pidinfo: koffi
      .load("/usr/lib/libproc.dylib")
      .func("int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)"),
    getsid: koffi.load("/usr/lib/libSystem.B.dylib").func("int getsid(int pid)"),
    sysctl: koffi
      .load("/usr/lib/libSystem.B.dylib")
      .func(
        "int sysctl(int *name, unsigned int namelen, void *oldp, size_t *oldlenp, void *newp, size_t newlen)",
      ),
    listpids: koffi
      .load("/usr/lib/libproc.dylib")
      .func("int proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize)"),
  };
  return fixtureNative;
}
/** @param {unknown} value @returns {number} */
function fixtureInteger(value) {
  assert.equal(typeof value, "number");
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    assert.fail("Invalid native fixture integer");
  }
  return value;
}
function fixtureIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      const uids = readFileSync(`/proc/${pid}/status`, "utf8").match(
        /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m,
      );
      assert.ok(uids, "Kernel status publishes actual process credentials");
      return {
        pid,
        uid: Number(uids[2]),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        sid: Number(fields[3]),
        identity: fields[19],
        exited: ["Z", "X"].includes(fields[0]),
      };
    } catch (error) {
      assert.equal(error.code, "ENOENT");
      return;
    }
  }
  const data = Buffer.alloc(136);
  if (fixtureInteger(nativeAPI().pidinfo(pid, 3, 1, data, data.length)) !== 136) {
    return;
  }
  assert.equal(data.readUInt32LE(12), pid);
  return {
    pid,
    uid: data.readUInt32LE(20),
    ppid: data.readUInt32LE(16),
    pgid: data.readUInt32LE(100),
    sid: fixtureInteger(nativeAPI().getsid(pid)),
    identity: data.subarray(120, 136).toString("base64"),
    exited: data.readUInt32LE(4) === 5,
    status: data.readUInt32LE(4),
  };
}
function fixtureEnvironmentVisible(pid, token) {
  const mib = new Int32Array([1, 49, pid]);
  const size = Buffer.alloc(8);
  if (token === "" || fixtureInteger(nativeAPI().sysctl(mib, 3, null, size, null, 0)) !== 0) {
    return false;
  }
  const length = Number(size.readBigUInt64LE());
  assert.ok(length >= 4 && length <= 1048576);
  const raw = Buffer.alloc(length);
  return (
    fixtureInteger(nativeAPI().sysctl(mib, 3, raw, size, null, 0)) === 0 &&
    raw.includes(Buffer.from(token))
  );
}
function assertNativeArgumentVector(pid, argv, firstEnvironmentEntry) {
  const mib = new Int32Array([1, 49, pid]);
  const size = Buffer.alloc(8);
  assert.equal(fixtureInteger(nativeAPI().sysctl(mib, 3, null, size, null, 0)), 0);
  const length = Number(size.readBigUInt64LE());
  assert.ok(length >= 4 && length <= 1048576);
  const raw = Buffer.alloc(length);
  assert.equal(fixtureInteger(nativeAPI().sysctl(mib, 3, raw, size, null, 0)), 0);
  assert.equal(raw.readInt32LE(0), argv.length, "Actual kernel argc matches the supplied vector");
  const expected = Buffer.from([...argv, firstEnvironmentEntry].join("\0") + "\0");
  assert.equal(
    raw.includes(expected),
    true,
    "Actual native argv bytes precede the FIRST environment entry, including empty arguments",
  );
}

function nativeFixture(pid, token = "", pauseFirst = false) {
  const entries = (Array.isArray(pid) ? pid : [pid]).map((candidate) => {
    const entry = fixtureIdentity(candidate);
    if (entry) {
      entry.environmentVisible =
        process.platform === "darwin" && fixtureEnvironmentVisible(candidate, token);
      entry.paused = false;
    }
    return entry;
  });
  const first = entries[0];
  if (pauseFirst && first?.environmentVisible) {
    const current = fixtureIdentity(first.pid);
    if (
      current?.identity === first.identity &&
      current.uid === process.getuid() &&
      !current.exited
    ) {
      process.kill(current.pid, osConstants.signals.SIGSTOP);
      const stopped = fixtureIdentity(current.pid);
      first.paused = stopped?.identity === first.identity && stopped.status === 4;
    }
  }
  return Array.isArray(pid) ? entries : entries[0];
}
async function publishedNativeObserver(guardianPid, token, pauseFirst) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const data = Buffer.alloc(4096);
    const bytes = fixtureInteger(nativeAPI().listpids(6, guardianPid, data, data.length));
    assert.ok(bytes >= 0 && bytes < data.length && bytes % 4 === 0);
    for (let offset = 0; offset < bytes; offset += 4) {
      const pid = data.readInt32LE(offset);
      const helper = nativeFixture(pid, token, pauseFirst);
      if (
        helper?.environmentVisible &&
        !helper.exited &&
        helper.sid === guardianPid &&
        (!pauseFirst || helper.paused)
      ) {
        const children = Buffer.alloc(4096);
        const childBytes = fixtureInteger(nativeAPI().listpids(6, pid, children, children.length));
        assert.equal(childBytes, 0, "The actual native query helper has no observer subprocesses");
        return helper;
      }
    }
    // Observe actual native children; elapsed time is not readiness.
    // oxlint-disable-next-line no-await-in-loop
    await delay(1);
  }
  assert.fail("Missing actual same-SID Node/native query helper");
}

async function publishedNativeGuardian(parentPid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let pids;
    if (process.platform === "linux") {
      pids = readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .map(Number);
    } else {
      const data = Buffer.alloc(4096);
      const bytes = fixtureInteger(nativeAPI().listpids(6, parentPid, data, data.length));
      assert.ok(bytes >= 0 && bytes < data.length && bytes % 4 === 0);
      pids = Array.from({ length: bytes / 4 }, (_, index) => data.readInt32LE(index * 4));
    }
    for (const pid of pids) {
      const entry = fixtureIdentity(pid);
      if (
        entry?.ppid === parentPid &&
        entry.uid === process.getuid() &&
        entry.sid === pid &&
        entry.pgid === pid &&
        !entry.exited
      ) {
        return entry;
      }
    }
    // Observe the actual live launch before allowing its caller to disconnect.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
  assert.fail("Missing actual native NO-WORK guardian launch");
}

async function terminateNativeFixture(entry) {
  if (entry !== undefined) {
    signalNativeFixture(entry, "SIGKILL");
    const deadline = Date.now() + 5000;
    while (fixturePresent(entry.pid)) {
      assert.ok(Date.now() < deadline, `Fixture ${entry.pid} did not exit`);
      // Reaping needs the actual child event loop, not a guessed sleep.
      // oxlint-disable-next-line no-await-in-loop
      await delay(20);
    }
    assert.throws(() => process.kill(entry.pid, 0), { code: "ESRCH" });
    console.log(
      `Native fixture absence: ${JSON.stringify({ pid: entry.pid, uid: entry.uid, identity: entry.identity, errno: "ESRCH" })}`,
    );
  }
}
function signalNativeFixture(entry, signal) {
  const current = fixtureIdentity(entry.pid);
  if (current?.identity !== entry.identity || current.uid !== process.getuid() || current.exited) {
    return false;
  }
  try {
    process.kill(entry.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
    return false; // The authenticated incarnation can exit before delivery.
  }
}

function authenticatedGuardianConsumer(consumer, guardian) {
  return (
    consumer &&
    !consumer.exited &&
    consumer.uid === guardian.uid &&
    consumer.sid === guardian.sid &&
    consumer.environmentVisible
  );
}

async function terminateNativeGuardian(guardian, token) {
  if (process.platform !== "darwin" || !guardian) {
    await terminateNativeFixture(guardian);
    return;
  }
  const consumers = [];
  const errors = await collectFixtureTeardown([
    async () => {
      if (!signalNativeFixture(guardian, "SIGSTOP")) {
        return;
      }
      const deadline = Date.now() + 5000;
      while (true) {
        const current = fixtureIdentity(guardian.pid);
        if (
          current?.identity !== guardian.identity ||
          current.uid !== guardian.uid ||
          current.exited
        ) {
          return; // Gone incarnation is not a failed stop or new signal authority.
        }
        if (current.status === 4) {
          break;
        }
        assert.ok(Date.now() < deadline, "Fixture guardian did not actually stop");
        // Only an observed stopped producer cannot launch another rescue query.
        // oxlint-disable-next-line no-await-in-loop
        await delay(1);
      }
      const data = Buffer.alloc(4096);
      const bytes = fixtureInteger(nativeAPI().listpids(6, guardian.pid, data, data.length));
      assert.ok(bytes >= 0 && bytes < data.length && bytes % 4 === 0);
      for (let offset = 0; offset < bytes; offset += 4) {
        const consumer = nativeFixture(data.readInt32LE(offset), token);
        // Ordinary protected WORK and exited/zombie children are not query
        // authentication failures. Their separately registered fixtures are reaped below.
        if (authenticatedGuardianConsumer(consumer, guardian)) {
          consumers.push(consumer);
        }
      }
      console.log(`Native guardian consumers: ${JSON.stringify(consumers)}`);
    },
    () => terminateNativeFixture(guardian),
    async () => {
      const consumerErrors = await collectFixtureTeardown(
        consumers.map((consumer) => () => terminateNativeFixture(consumer)),
      );
      if (consumerErrors.length > 0) {
        throw new AggregateError(consumerErrors, "Native guardian consumer reaping failed");
      }
    },
  ]);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Native guardian fallback failed");
  }
}

function fixturePresent(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert.equal(error.code, "ESRCH");
    return false;
  }
}

async function finishNativeOwner(owner, outcome, stopAttempted) {
  await outcome; // WORK return is not guardian release.
  if (!stopAttempted) {
    await owner.stop();
  }
}

async function collectFixtureTeardown(operations) {
  const errors = [];
  for (const operation of operations) {
    try {
      // Cleanup is ordered, but one failure must not strand the remaining fixtures.
      // oxlint-disable-next-line no-await-in-loop
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function reportFixtureTeardown(errors, originalFailure) {
  if (errors.length === 0) {
    return;
  }
  const error = new AggregateError(
    errors,
    "Native fixture teardown failed; retaining uncertain roots",
  );
  if (!originalFailure) {
    throw error;
  }
  console.error(error); // Report once; never replace the original caught Error.
}

for (const fast of [false, true]) {
  test(
    `native protected multi-generation descendants settle after ${fast ? "fast" : "published"} leader exit`,
    { skip: process.platform !== "darwin" },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ps-protected-session-proof-"));
      const ready = join(root, "ready.json");
      const release = join(root, "release");
      const command = `
        child=$(/bin/sh -c '/bin/sleep 180 </dev/null >/dev/null 2>&1 & printf "%s" "$!"')
        printf '{"parentPid":%s,"guardianPid":%s,"childPid":%s,"owners":"%s"}\\n' "$$" "\${PI_COMPAT_GUARDIAN_PID:-$$}" "$child" "$PI_COMPAT_PROCESS_OWNERS" > '${ready}.tmp'
        /bin/mv '${ready}.tmp' '${ready}'
        ${fast ? "" : `while [ ! -f '${release}' ]; do :; done`}
        exit 0`;
      const owner = new OwnedProcesses();
      const operation = fast
        ? owner.execute(
            "/bin/sh",
            ["-c", command],
            { quiet: true, detached: true },
            new AbortController().signal,
          )
        : run("/bin/sh", ["-c", command], { quiet: true, detached: true });
      const outcome = operation.then(
        (output) => ({ output }),
        (error) => ({ error }),
      );
      let owned;
      let foreign;
      let guardian;
      let token;
      let failure;
      let stopAttempted = false;
      try {
        const receipt = await published(ready);
        owned = nativeFixture(receipt.childPid);
        guardian = nativeFixture(receipt.guardianPid);
        assert.equal(typeof receipt.owners, "string");
        assert.ok(receipt.owners.length > 0);
        token = receipt.owners.split(",").at(-1);
        owned = nativeFixture(receipt.childPid, token);
        assert.ok(owned);
        assert.equal(owned.uid, process.getuid());
        assert.equal(owned.sid, receipt.guardianPid, "Actual private guardian reserves the SID");
        assert.equal(owned.exited, false);
        assert.ok(active(owned.pid));
        console.log(`Protected Apple environment visible: ${owned.environmentVisible}`);
        const env = { ...process.env };
        delete env.PI_COMPAT_PROCESS_OWNERS;
        const unrelated = spawn(
          process.execPath,
          [
            "-e",
            "setInterval(() => {}, 1000)",
            "--",
            `unrelated text PI_COMPAT_PROCESS_OWNERS=${receipt.owners}`,
          ],
          { detached: true, stdio: "ignore", env },
        );
        foreign = { child: unrelated, ...nativeFixture(unrelated.pid) };
        assert.equal(foreign.uid, process.getuid());
        assert.notEqual(foreign.sid, owned.sid);
        assert.ok(active(foreign.pid));
        writeFileSync(release, "release");
        if (fast) {
          assert.equal((await outcome).error, undefined);
          const orphan = nativeFixture(owned.pid);
          assert.equal(orphan.identity, owned.identity);
          assert.equal(orphan.ppid, 1);
          assert.equal(orphan.exited, false);
          stopAttempted = true;
          await owner.stop();
        } else {
          const result = await outcome;
          assert.equal(result.error, undefined);
        }
        assert.equal(
          active(owned.pid),
          false,
          "Reparented protected Apple descendant must quiesce",
        );
        assert.equal(
          active(foreign.pid),
          true,
          "Foreign same-UID SID with argv marker must survive",
        );
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const errors = await collectFixtureTeardown([
          () => writeFileSync(release, "fixture teardown"),
          () => (fast ? finishNativeOwner(owner, outcome, stopAttempted) : outcome),
          () => terminateNativeGuardian(guardian, token),
          () => terminateNativeFixture(owned),
          () => terminateNativeFixture(foreign),
        ]);
        if (errors.length === 0) {
          errors.push(
            ...(await collectFixtureTeardown([
              () => rmSync(root, { recursive: true, force: true }),
            ])),
          );
        }
        reportFixtureTeardown(errors, failure);
      }
    },
  );
}

test("an inherited private CI root settles synchronous and connected nested descendants", async () => {
  const root = mkdtempSync(join(tmpdir(), "ps-inherited-session-proof-"));
  const unicode = join(root, "é-雪");
  mkdirSync(unicode, { mode: 0o700 });
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = unicode;
  const ready = join(root, "ready.json");
  const release = join(root, "release");
  const finish = join(root, "finish");
  const nestedReady = join(root, "nested.json");
  const nestedCommand = `
      /bin/sleep 180 </dev/null >/dev/null 2>&1 &
      printf '{"pid":%s,"child":%s,"guardian":%s,"owners":"%s"}' "$$" "$!" "$PI_COMPAT_GUARDIAN_PID" "$PI_COMPAT_PROCESS_OWNERS" > '${nestedReady}'
      while :; do :; done`;
  writeFileSync(
    join(root, "actor.mjs"),
    `
      import { spawnSync } from "node:child_process";
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      import { OwnedProcesses, run } from ${JSON.stringify(runner)};
      const owner = new OwnedProcesses();
      owner.inherit();
      const launched = spawnSync("/bin/sh", ["-c", '/bin/sleep 180 </dev/null >/dev/null 2>&1 & printf "%s" "$!"'], { encoding: "utf8" });
      if (launched.status !== 0) throw new Error("Actual synchronous helper failed");
      const nested = run("/bin/sh", ["-c", ${JSON.stringify(nestedCommand)}], { quiet: true })
        .then(output => ({ output }), error => ({ error: {
          signal: error.signal, status: error.status, cleanupFailed: error.cleanupFailed ?? false
        } }));
      while (!existsSync(${JSON.stringify(nestedReady)})) await delay(10);
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: Number(launched.stdout), caller: process.pid, parent: Number(process.env.PI_COMPAT_GUARDIAN_PID ?? process.pid), guardianRoot: process.env.PI_COMPAT_GUARDIAN_ROOT, owners: owner.environment.PI_COMPAT_PROCESS_OWNERS, nested: JSON.parse(readFileSync(${JSON.stringify(nestedReady)}, "utf8")) }));
      while (!existsSync(${JSON.stringify(release)})) await delay(10);
      await owner.stop();
      writeFileSync(${JSON.stringify(join(root, "settled.json"))}, JSON.stringify({
        settled: true, caller: process.pid, nested: await nested }));
      while (!existsSync(${JSON.stringify(finish)})) await delay(10);
    `,
  );
  const operation = run(process.execPath, [join(root, "actor.mjs")], {
    quiet: true,
    detached: true,
  });
  const outcome = operation.then(
    (output) => ({ output }),
    (error) => ({ error }),
  );
  let owned;
  let caller;
  const nestedFixtures = [];
  try {
    const receipt = await published(ready);
    assert.equal(
      receipt.guardianRoot.startsWith(`${unicode}/pi-compat-guardians-`),
      true,
      "Actual owner TMPDIR creates the Unicode guardian capability path",
    );
    owned = nativeFixture(receipt.pid, receipt.owners.split(",").at(-1));
    assert.ok(owned);
    assert.equal(owned.uid, process.getuid());
    assert.equal(owned.sid, receipt.parent);
    assert.equal(owned.exited, false);
    assert.ok(active(owned.pid));
    caller = nativeFixture(receipt.caller);
    assert.equal(caller.sid, receipt.parent);
    assert.equal(caller.uid, process.getuid());
    for (const pid of [receipt.nested.guardian, receipt.nested.pid, receipt.nested.child]) {
      const entry = nativeFixture(pid);
      nestedFixtures.push(entry);
      assert.equal(entry.uid, process.getuid());
      assert.equal(entry.sid, receipt.nested.guardian);
      assert.equal(entry.exited, false);
    }
    assert.deepEqual(
      receipt.nested.owners.split(",").slice(0, -1),
      receipt.owners.split(","),
      "Actual nested run retains the borrowed caller's owner hierarchy",
    );
    writeFileSync(release, "release");
    const settlement = await published(join(root, "settled.json"));
    assert.equal(settlement.settled, true);
    assert.equal(settlement.caller, caller.pid);
    assert.equal(fixtureIdentity(caller.pid).identity, caller.identity);
    assert.equal(active(caller.pid), true, "Borrowed stop succeeds with its caller connected");
    assert.equal(settlement.nested.error.signal, "SIGTERM");
    assert.equal(settlement.nested.error.status, null);
    assert.equal(settlement.nested.error.cleanupFailed, false);
    for (const entry of nestedFixtures) {
      assert.equal(active(entry.pid), false, "Connected nested WORK and guardian actually exit");
      assert.throws(() => process.kill(entry.pid, 0), { code: "ESRCH" });
    }
    assert.equal(
      existsSync(receipt.guardianRoot),
      true,
      "Borrowed stop retains the enclosing root",
    );
    writeFileSync(finish, "connected caller may now exit");
    assert.equal((await outcome).error, undefined);
    assert.equal(
      active(owned.pid),
      false,
      "Inherited root must settle protected children before deletion",
    );
  } finally {
    writeFileSync(release, "fixture teardown");
    writeFileSync(finish, "fixture teardown");
    await outcome;
    await terminateNativeFixture(owned);
    for (const entry of [caller, ...nestedFixtures]) {
      // Reap only this independently authenticated nested fixture family.
      // oxlint-disable-next-line no-await-in-loop
      await terminateNativeFixture(entry);
    }
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("only exact environment receipts authorize owned-process cleanup", async () => {
  assert.throws(() => new OwnedProcesses({}, ""), /actual inherited UUID/);
  const root = mkdtempSync(join(tmpdir(), "ps-environment-proof-"));
  let owner = new OwnedProcesses();
  let token = owner.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1);
  // Select a genuinely issued UUID with a valid three-byte UTF8 alias whose
  // high-bit-masked ASCII spelling would impersonate part of that UUID.
  while (!/[a-f][0-9-]{2}/.test(token)) {
    owner = new OwnedProcesses();
    token = owner.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1);
  }
  const part = token.match(/[a-f][0-9-]{2}/)[0];
  const alias = token.replace(
    part,
    Buffer.from(part)
      .map((byte) => byte | 0x80)
      .toString("utf8"),
  );
  assert.equal(Buffer.from(alias).includes(Buffer.from(token)), false);
  assert.equal(
    Buffer.from(alias).toString("ascii"),
    token,
    "Fixture reaches ASCII high-bit masking, not ordinary text confusion",
  );
  const marker = `PI_COMPAT_PROCESS_OWNERS=${owner.environment.PI_COMPAT_PROCESS_OWNERS}`;
  const unownedEnv = { ...process.env };
  delete unownedEnv.PI_COMPAT_PROCESS_OWNERS;
  const children = [];
  try {
    const ownerFirst = {
      PI_COMPAT_PROCESS_OWNERS: owner.environment.PI_COMPAT_PROCESS_OWNERS,
      ...unownedEnv,
    };
    for (const [name, env, args, argv0] of [
      ["argv-only", unownedEnv, [marker]],
      [
        "environment-value-only",
        { ...unownedEnv, UNRELATED_NOTE: `unrelated value ${marker}` },
        [],
      ],
      [
        "unicode-owner-alias",
        { ...unownedEnv, PI_COMPAT_PROCESS_OWNERS: alias, UNRELATED_NOTE: marker },
        [token],
      ],
      ["owned", ownerFirst, []],
      ["owned-empty-argv0", ownerFirst, [], ""],
      ["owned-empty-arguments", ownerFirst, ["", "middle", "", ""]],
      ["owned-empty-argv0-and-arguments", ownerFirst, ["", "middle", "", ""], ""],
      ["argv-only-empty-arguments", unownedEnv, ["", marker, ""], ""],
      [
        "environment-value-only-empty-arguments",
        { ...unownedEnv, UNRELATED_NOTE: marker },
        ["", ""],
        "",
      ],
      [
        "unicode-owner-alias-empty-arguments",
        { ...unownedEnv, PI_COMPAT_PROCESS_OWNERS: alias, UNRELATED_NOTE: marker },
        ["", token, ""],
        "",
      ],
    ]) {
      const file = join(root, `${name}.json`);
      const script = `require("node:fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify({
            pid: process.pid, uid: process.getuid(), argv0: process.argv0,
            owners: process.env.PI_COMPAT_PROCESS_OWNERS ?? null, args: process.argv.slice(1),
            firstEnvironmentEntry: Object.keys(process.env)[0], note: process.env.UNRELATED_NOTE ?? null
          })); setInterval(() => {}, 1000);`;
      const child = spawn(process.execPath, ["-e", script, "--", ...args], {
        env,
        argv0,
        detached: true,
        stdio: "ignore",
      });
      const entry = {
        name,
        child,
        pid: child.pid,
        identity: readChildProcessIdentity(child.pid),
        native: fixtureIdentity(child.pid),
      };
      children.push(entry);
      // Actual fixture publication proves the owner key is absent/present before stop.
      // oxlint-disable-next-line no-await-in-loop
      const receipt = await published(file);
      assert.equal(receipt.pid, entry.pid);
      assert.equal(receipt.uid, process.getuid());
      assert.equal(receipt.argv0, argv0 ?? process.execPath);
      assert.equal(receipt.firstEnvironmentEntry, Object.keys(env)[0]);
      assert.equal(receipt.owners, env.PI_COMPAT_PROCESS_OWNERS ?? null);
      assert.deepEqual(receipt.args, args);
      assert.equal(receipt.note, env.UNRELATED_NOTE ?? null);
      assert.ok(entry.identity);
      assert.ok(active(entry.pid));
      if (process.platform === "darwin") {
        const native = nativeFixture(entry.pid);
        entry.native = native;
        assert.equal(native.uid, process.getuid());
        assert.equal(native.exited, false);
        const [key, value] = Object.entries(env)[0];
        assertNativeArgumentVector(
          entry.pid,
          [argv0 ?? process.execPath, "-e", script, "--", ...args],
          `${key}=${value}`,
        );
      }
    }
    if (process.platform === "darwin") {
      for (const entry of children) {
        const snapshot = processSnapshot(token, entry.pid, Date.now() + 3000);
        const ambiguous = entry.name.startsWith("argv-only");
        assert.equal(snapshot.uncertainties.length, ambiguous ? 1 : 0, entry.name);
        if (ambiguous) {
          assert.equal(snapshot.uncertainties[0].pid, entry.pid);
          assert.equal(snapshot.uncertainties[0].identity, entry.native.identity);
          assert.match(snapshot.uncertainties[0].message, /outside native environment boundary/);
        }
      }
      await assert.rejects(owner.stop(), (error) => {
        assert.match(error.cause.message, /Receipt outside native environment boundary/);
        return true;
      });
    } else {
      await owner.stop();
    }
    assert.equal(active(children[0].pid), true, "An argv marker is not an environment receipt");
    assert.equal(active(children[1].pid), true, "Text in another env value is not an owner key");
    assert.equal(
      active(children[2].pid),
      true,
      "A Unicode owner alias must not become an ASCII receipt",
    );
    for (const entry of children.slice(3)) {
      assert.equal(
        active(entry.pid),
        !entry.name.startsWith("owned"),
        `${entry.name}: only an actual environment receipt authorizes cleanup, even with empty argv entries`,
      );
    }
  } finally {
    for (const { child, pid, identity, native } of children) {
      assert.equal(child.pid, pid);
      assert.ok(identity);
      // Reap each independently authenticated fixture before proceeding.
      // oxlint-disable-next-line no-await-in-loop
      await terminateNativeFixture(native);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failAfterPublication of [false, true]) {
  test(
    failAfterPublication
      ? "late native fixture preserves a post-publication failure through genuine owner teardown"
      : "a live guardian covers a late protected fork that is orphaned before exec",
    { skip: process.platform !== "darwin" },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ps-late-protected-proof-"));
      const initial = join(root, "initial.json");
      const ready = join(root, "ready.json");
      const launch = join(root, "launch");
      const exec = join(root, "exec");
      const owner = new OwnedProcesses();
      const command = `
      /bin/sleep 0.01
      printf '{"pid":%s,"guardian":%s,"root":"%s"}\\n' "$$" "\${PI_COMPAT_GUARDIAN_PID:-$$}" "$PI_COMPAT_GUARDIAN_ROOT" > '${initial}'
      while [ ! -f '${launch}' ]; do :; done
      /bin/sh -c 'while [ ! -f "${exec}" ]; do :; done; exec /bin/sleep 180' </dev/null >/dev/null 2>&1 &
      printf '{"pid":%s,"owners":"%s"}\\n' "$!" "$PI_COMPAT_PROCESS_OWNERS" > '${ready}.tmp'
      /bin/mv '${ready}.tmp' '${ready}'`;
      const operation = owner.execute(
        "/bin/sh",
        ["-c", command],
        { quiet: true },
        new AbortController().signal,
      );
      const outcome = operation.then(
        (output) => ({ output }),
        (error) => ({ error }),
      );
      let owned;
      let guardian;
      let work;
      let first;
      let failure;
      let stopAttempted = false;
      let teardownComplete = false;
      const originalFailure = new Error("Intentional late fixture pre-transition failure");
      const exercise = async () => {
        try {
          first = await published(initial);
          guardian = nativeFixture(first.guardian);
          work = nativeFixture(first.pid);
          assert.equal(typeof first.root, "string");
          assert.ok(first.root.length > 0, "WORK publishes the actual nonempty receipt root");
          assert.equal(existsSync(first.root), true, "Actual receipt root exists at publication");
          assert.ok(active(first.pid), "Actual command is waiting before the late fork");
          writeFileSync(launch, "launch");
          const receipt = await published(ready);
          owned = nativeFixture(receipt.pid, receipt.owners.split(",").at(-1));
          assert.equal((await outcome).error, undefined);
          assert.ok(owned);
          assert.equal(owned.ppid, 1, "Child was orphaned before its exec");
          assert.equal(owned.sid, first.guardian);
          assert.equal(owned.exited, false);
          writeFileSync(exec, "exec");
          const deadline = Date.now() + 5000;
          while (
            spawnSync("/bin/ps", ["-p", String(owned.pid), "-o", "comm="], {
              encoding: "utf8",
            }).stdout.trim() !== "/bin/sleep"
          ) {
            assert.ok(Date.now() < deadline, "Orphan did not exec the protected Apple binary");
            // Observe actual native exec, not a guessed scheduling sleep.
            // oxlint-disable-next-line no-await-in-loop
            await delay(20);
          }
          const executed = nativeFixture(owned.pid, receipt.owners.split(",").at(-1));
          if (failAfterPublication) {
            console.log(
              `Native lifecycle publication: ${JSON.stringify({ case: "late", root: first.root, fixtures: [owned, work, guardian] })}`,
            );
            throw originalFailure;
          }
          assert.equal(executed.identity, owned.identity);
          assert.equal(executed.ppid, 1);
          assert.equal(executed.environmentVisible, false);
          stopAttempted = true;
          await owner.stop();
          assert.equal(active(owned.pid), false, "Late orphan-then-exec must quiesce");
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          const errors = await collectFixtureTeardown([
            () => writeFileSync(launch, "teardown"),
            () => writeFileSync(exec, "teardown"),
            async () => {
              await finishNativeOwner(owner, outcome, stopAttempted);
              if (failAfterPublication) {
                for (const entry of [owned, work, guardian]) {
                  assert.equal(
                    fixtureIdentity(entry.pid),
                    undefined,
                    "Real WORK and guardian absence precede fallback teardown",
                  );
                }
              }
            },
          ]);
          teardownComplete = errors.length === 0;
          reportFixtureTeardown(errors, failure);
        }
      };
      try {
        if (failAfterPublication) {
          await assert.rejects(exercise, (error) => {
            assert.equal(
              error,
              originalFailure,
              "Teardown preserves the exact pre-transition error",
            );
            return true;
          });
          failure = undefined; // assert.rejects consumed the intentional failure, not outer cleanup.
          assert.equal(teardownComplete, true, "Original error cannot hide a teardown failure");
          console.log(
            `Native lifecycle returned: ${JSON.stringify({ case: "late", root: first.root, rootPresent: existsSync(first.root), guardian: fixtureIdentity(guardian.pid) })}`,
          );
          assert.equal(
            fixtureIdentity(guardian.pid),
            undefined,
            "Genuine owner teardown releases the late guardian",
          );
          assert.equal(
            existsSync(first.root),
            false,
            "Only genuine settlement removes the healthy owner root",
          );
        } else {
          await exercise();
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const errors = await collectFixtureTeardown([
          () =>
            terminateNativeGuardian(
              guardian,
              owner.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1),
            ),
          () => terminateNativeFixture(owned),
          () => terminateNativeFixture(work),
        ]);
        if (teardownComplete && errors.length === 0) {
          errors.push(
            ...(await collectFixtureTeardown([
              () => rmSync(root, { recursive: true, force: true }),
            ])),
          );
        }
        reportFixtureTeardown(errors, failure);
      }
    },
  );
}

for (const [nested, failAfterPublication] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  test(
    failAfterPublication
      ? "nested native fixture preserves a post-publication failure through genuine owner teardown"
      : `unexpected ${nested ? "inner" : "direct"} guardian loss retains roots without false settlement`,
    { skip: process.platform !== "darwin" },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ps-guardian-loss-proof-"));
      const ready = join(root, "ready.json");
      const release = join(root, "release");
      const command = `
        /bin/sleep 180 </dev/null >/dev/null 2>&1 &
        printf '{"child":%s,"work":%s,"guardian":%s,"root":"%s","owners":"%s"}\\n' "$!" "$$" "$PI_COMPAT_GUARDIAN_PID" "$PI_COMPAT_GUARDIAN_ROOT" "$PI_COMPAT_PROCESS_OWNERS" > '${ready}.tmp'
        /bin/mv '${ready}.tmp' '${ready}'
        while [ ! -f '${release}' ]; do :; done`;
      writeFileSync(
        join(root, "actor.mjs"),
        `
        import { run } from ${JSON.stringify(runner)};
        import { existsSync, writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(join(root, "outer.json"))}, JSON.stringify({ pid: Number(process.env.PI_COMPAT_GUARDIAN_PID), work: process.pid, root: process.env.PI_COMPAT_GUARDIAN_ROOT }));
        try { await run("/bin/sh", ["-c", ${JSON.stringify(command)}], { quiet: true }); }
        catch (error) {
          writeFileSync(${JSON.stringify(join(root, "inner-failed.json"))}, JSON.stringify({ cleanupFailed: error.cleanupFailed }));
          process.exitCode = 23;
        }
        writeFileSync(${JSON.stringify(join(root, "consumer-returned.json"))}, JSON.stringify({ root: process.env.PI_COMPAT_GUARDIAN_ROOT, rootPresent: existsSync(process.env.PI_COMPAT_GUARDIAN_ROOT), pid: process.pid }));`,
      );
      const owner = new OwnedProcesses();
      const operation = nested
        ? owner.execute(
            process.execPath,
            [join(root, "actor.mjs")],
            { quiet: true },
            new AbortController().signal,
          )
        : owner.execute("/bin/sh", ["-c", command], { quiet: true }, new AbortController().signal);
      const outcome = operation.then(
        (output) => ({ output }),
        (error) => ({ error }),
      );
      const fixtures = [];
      let receipt;
      let outerGuardian;
      let outerPublication;
      let failure;
      let stopAttempted = false;
      let teardownComplete = false;
      const originalFailure = new Error("Intentional nested fixture pre-transition failure");
      const exercise = async () => {
        try {
          if (nested) {
            outerPublication = await published(join(root, "outer.json"));
            outerGuardian = nativeFixture(outerPublication.pid);
            fixtures.push(nativeFixture(outerPublication.work), outerGuardian);
          }
          receipt = await published(ready);
          const child = nativeFixture(receipt.child, receipt.owners.split(",").at(-1));
          const guardian = nativeFixture(receipt.guardian);
          fixtures.push(child, nativeFixture(receipt.work), guardian);
          assert.equal(typeof receipt.root, "string");
          assert.ok(receipt.root.length > 0, "WORK publishes the actual nonempty receipt root");
          assert.equal(existsSync(receipt.root), true, "Actual receipt root exists at publication");
          if (nested) {
            assert.equal(
              outerPublication.root,
              receipt.root,
              "Nested owners share the actual receipt root",
            );
          }
          if (failAfterPublication) {
            console.log(
              `Native lifecycle publication: ${JSON.stringify({ case: "nested", root: receipt.root, fixtures })}`,
            );
            throw originalFailure;
          }
          assert.ok(child && guardian);
          assert.equal(child.sid, guardian.pid);
          assert.equal(child.environmentVisible, false);
          assert.equal(guardian.sid, guardian.pid);
          await terminateNativeFixture(guardian);
          writeFileSync(release, "allow work exit");
          assert.ok((await outcome).error instanceof Error);
          if (nested) {
            assert.equal((await published(join(root, "inner-failed.json"))).cleanupFailed, true);
          }
          stopAttempted = true;
          await assert.rejects(owner.stop(), /guardian|quiesce/i);
          assert.equal(
            existsSync(receipt.root),
            true,
            "Unsettled private lifecycle receipts must survive",
          );
          assert.equal(active(child.pid), true, "Unproven protected SID must never become success");
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          const errors = await collectFixtureTeardown([
            () => writeFileSync(release, "teardown"),
            async () => {
              await finishNativeOwner(owner, outcome, stopAttempted);
              if (failAfterPublication) {
                const returned = await published(join(root, "consumer-returned.json"));
                assert.equal(
                  returned.root,
                  receipt.root,
                  "Consumer return witnesses the published receipt root",
                );
                assert.equal(
                  returned.rootPresent,
                  true,
                  "Inner consumer retains the real root through its return",
                );
                for (const entry of fixtures) {
                  assert.equal(
                    fixtureIdentity(entry.pid),
                    undefined,
                    "All native WORK/inner/outer lifetimes finish before fallback teardown",
                  );
                }
              }
            },
          ]);
          teardownComplete = errors.length === 0;
          reportFixtureTeardown(errors, failure);
        }
      };
      try {
        if (failAfterPublication) {
          await assert.rejects(exercise, (error) => {
            assert.equal(
              error,
              originalFailure,
              "Teardown preserves the exact pre-transition error",
            );
            return true;
          });
          failure = undefined; // assert.rejects consumed the intentional failure, not outer cleanup.
          assert.equal(teardownComplete, true, "Original error cannot hide a teardown failure");
          console.log(
            `Native lifecycle returned: ${JSON.stringify({ case: "nested", root: receipt.root, rootPresent: existsSync(receipt.root), guardian: fixtureIdentity(outerGuardian.pid) })}`,
          );
          assert.equal(
            fixtureIdentity(outerGuardian.pid),
            undefined,
            "Genuine owner teardown releases the outer guardian",
          );
          assert.equal(
            existsSync(receipt.root),
            false,
            "Healthy nested settlement removes its root",
          );
        } else {
          await exercise();
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const errors = await collectFixtureTeardown([
          () =>
            terminateNativeGuardian(
              outerGuardian,
              owner.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1),
            ),
          ...fixtures.map((entry) => () => terminateNativeFixture(entry)),
        ]);
        // A deliberately lost guardian never authenticates settlement. Retain
        // its uncertain receipt root even after independent fixture reaping.
        if (teardownComplete && errors.length === 0) {
          errors.push(
            ...(await collectFixtureTeardown([
              () => rmSync(root, { recursive: true, force: true }),
            ])),
          );
        }
        reportFixtureTeardown(errors, failure);
      }
    },
  );
}

for (const pauseQuery of [false, true]) {
  test(
    `overlapping outer cleanup and IPC-loss rescue ${pauseQuery ? "retry after a paused native query" : "settle with native query reaping"}`,
    { skip: process.platform !== "darwin" },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ps-guardian-rescue-proof-"));
      const ready = join(root, "ready.json");
      const writerReady = join(root, "writer.json");
      const termReady = join(root, "term.json");
      writeFileSync(
        join(root, "writer.mjs"),
        `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => writeFileSync(${JSON.stringify(termReady)}, JSON.stringify({ pid: process.pid })));
      writeFileSync(${JSON.stringify(writerReady)}, JSON.stringify({ pid: process.pid, directory: process.env.PI_COMPAT_GUARDIAN_DIRECTORY ?? null }));
      setInterval(() => {}, 1000);`,
      );
      const outer = new OwnedProcesses();
      const command = `
      '${process.execPath}' '${join(root, "writer.mjs")}' </dev/null >/dev/null 2>&1 &
      while [ ! -f '${writerReady}' ]; do :; done
      /bin/sleep 180 </dev/null >/dev/null 2>&1 &
      printf '{"child":%s,"work":%s,"guardian":%s,"root":"%s","owners":"%s"}\\n' "$!" "$$" "$PI_COMPAT_GUARDIAN_PID" "$PI_COMPAT_GUARDIAN_ROOT" "$PI_COMPAT_PROCESS_OWNERS" > '${ready}.tmp'
      /bin/mv '${ready}.tmp' '${ready}'
      while :; do :; done`;
      const wrapper = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { run } from ${JSON.stringify(runner)}; await run("/bin/sh", ["-c", ${JSON.stringify(command)}], { quiet: true });`,
        ],
        { detached: true, stdio: "ignore", env: outer.environment },
      );
      const wrapperIdentity = readChildProcessIdentity(wrapper.pid);
      const wrapperNative = nativeFixture(wrapper.pid);
      const exited = new Promise((resolve) => wrapper.once("exit", resolve));
      let receipt;
      let child;
      let guardian;
      let writer;
      let foreign;
      let work;
      let queryHelper;
      let failure;
      let stopAttempted = false;
      let settledProof = false;
      try {
        const writerReceipt = await published(writerReady);
        writer = nativeFixture(writerReceipt.pid);
        receipt = await published(ready);
        child = nativeFixture(receipt.child, receipt.owners.split(",").at(-1));
        guardian = nativeFixture(receipt.guardian);
        work = nativeFixture(receipt.work);
        assert.ok(child && guardian && wrapperIdentity);
        assert.equal(child.environmentVisible, false);
        assert.equal(child.sid, guardian.pid);
        assert.ok(active(wrapper.pid));
        assert.equal(readChildProcessIdentity(wrapper.pid), wrapperIdentity);
        assert.equal(fixtureIdentity(wrapper.pid).identity, wrapperNative.identity);
        assert.equal(fixtureIdentity(wrapper.pid).uid, process.getuid());
        assert.equal(
          writerReceipt.directory,
          null,
          "Ordinary work must not inherit guardian-internal authentication metadata",
        );
        assert.ok(writer && !writer.exited);
        const unowned = { ...process.env };
        delete unowned.PI_COMPAT_PROCESS_OWNERS;
        delete unowned.PI_COMPAT_GUARDIAN_DIRECTORY;
        const unrelated = spawn(
          process.execPath,
          [
            "-e",
            "setInterval(() => {}, 1000)",
            "--",
            `unrelated text PI_COMPAT_PROCESS_OWNERS=${outer.environment.PI_COMPAT_PROCESS_OWNERS}`,
          ],
          { detached: true, stdio: "ignore", env: unowned },
        );
        foreign = nativeFixture(unrelated.pid);
        assert.ok(foreign && !foreign.exited);
        assert.equal(signalNativeFixture(wrapperNative, "SIGKILL"), true);
        await exited;
        assert.equal(
          (await published(termReady)).pid,
          writer.pid,
          "Actual TERM receipt proves rescue has entered native cleanup",
        );
        const helper = await publishedNativeObserver(
          guardian.pid,
          outer.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1),
          pauseQuery,
        );
        queryHelper = helper;
        assert.equal(helper.uid, process.getuid());
        assert.equal(helper.sid, guardian.sid);
        assert.equal(helper.pgid, guardian.pgid);
        assert.equal(
          helper.environmentVisible,
          true,
          "Node query owner has the actual inherited receipt",
        );
        assert.equal(
          helper.paused,
          pauseQuery,
          "Native stopped state proves scheduler pause before the bounded query resumes",
        );
        const helperSignals = [];
        const originalKill = process.kill;
        process.kill = (pid, signal) => {
          if (pid === helper.pid && ["SIGTERM", "SIGKILL"].includes(signal)) {
            const current = fixtureIdentity(pid);
            if (
              current?.identity === helper.identity &&
              current.uid === helper.uid &&
              current.sid === helper.sid
            ) {
              helperSignals.push({
                pid,
                uid: current.uid,
                sid: current.sid,
                identity: current.identity,
                signal,
              });
            }
          }
          return originalKill(pid, signal);
        };
        let cleanupFailure;
        try {
          stopAttempted = true;
          await outer.stop();
        } catch (error) {
          cleanupFailure = error;
        } finally {
          process.kill = originalKill;
        }
        console.log(`Native outer query signal attempts: ${JSON.stringify(helperSignals)}`);
        assert.deepEqual(helperSignals, [], "Outer owner must not signal the actual rescue query");
        if (cleanupFailure) {
          throw cleanupFailure;
        }
        assert.equal(
          nativeFixture(helper.pid),
          undefined,
          "Completed or timed-out actual query helper was reaped",
        );
        assert.equal(active(writer.pid), false, "Role-stripped ordinary work remains stoppable");
        assert.equal(
          active(foreign.pid),
          true,
          "Unrelated argv-only foreign session must survive overlapping sweeps",
        );
        assert.equal(
          active(child.pid),
          false,
          "Protected Apple WORK remains stoppable in both rescue outcomes",
        );
        const files = readdirSync(receipt.root);
        assert.equal(files.length, 1);
        const state = join(receipt.root, files[0], "state.json");
        const deadline = Date.now() + 5000;
        while (JSON.parse(readFileSync(state, "utf8")).state !== "settled") {
          assert.ok(Date.now() < deadline, "Disconnected guardian did not prove settlement");
          // Observe the actual atomic lifecycle publication after real IPC loss.
          // oxlint-disable-next-line no-await-in-loop
          await delay(20);
        }
        const settled = JSON.parse(readFileSync(state, "utf8"));
        assert.equal(settled.pid, guardian.pid);
        assert.equal(settled.uid, guardian.uid);
        assert.equal(settled.identity, guardian.identity);
        assert.equal(active(child.pid), false);
        settledProof = true;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const errors = await collectFixtureTeardown([
          () => terminateNativeFixture(wrapperNative),
          () => finishNativeOwner(outer, exited, stopAttempted),
          () =>
            terminateNativeGuardian(
              guardian,
              outer.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1),
            ),
          ...[child, work, writer, queryHelper, foreign].map(
            (entry) => () => terminateNativeFixture(entry),
          ),
        ]);
        if (errors.length === 0) {
          errors.push(
            ...(await collectFixtureTeardown([
              () => {
                if (receipt && settledProof) {
                  rmSync(receipt.root, { recursive: true, force: true });
                }
              },
              () => rmSync(root, { recursive: true, force: true }),
            ])),
          );
        }
        reportFixtureTeardown(errors, failure);
      }
    },
  );
}

test("simultaneous sibling disconnect rescues settle their own native enclosures", async () => {
  const root = mkdtempSync(join(tmpdir(), "ps-sibling-rescue-proof-"));
  const outer = new OwnedProcesses();
  const commands = [0, 1].map(
    (index) => `
    /bin/sleep 180 </dev/null >/dev/null 2>&1 &
    printf '{"child":%s,"guardian":%s,"root":"%s","owners":"%s"}' "$!" "$PI_COMPAT_GUARDIAN_PID" "$PI_COMPAT_GUARDIAN_ROOT" "$PI_COMPAT_PROCESS_OWNERS" > '${root}/ready-${index}.json'
    while :; do :; done`,
  );
  const wrapper = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { run } from ${JSON.stringify(runner)};
       await Promise.all(${JSON.stringify(commands)}.map(command =>
         run("/bin/sh", ["-c", command], { quiet: true })));`,
    ],
    { detached: true, stdio: "ignore", env: outer.environment },
  );
  const wrapperNative = nativeFixture(wrapper.pid);
  const exited = new Promise((resolve) => wrapper.once("exit", resolve));
  const fixtures = [];
  const receipts = [];
  try {
    for (let index = 0; index < commands.length; index++) {
      // Both actual ready receipts must precede the single caller-loss transition.
      // oxlint-disable-next-line no-await-in-loop
      const receipt = await published(join(root, `ready-${index}.json`));
      receipts.push(receipt);
      const child = nativeFixture(receipt.child);
      const guardian = nativeFixture(receipt.guardian);
      fixtures.push(child, guardian);
      assert.equal(child.uid, process.getuid());
      assert.equal(child.sid, guardian.pid);
      assert.equal(guardian.sid, guardian.pid);
      assert.equal(child.exited, false);
      assert.equal(guardian.exited, false);
    }
    assert.notEqual(receipts[0].guardian, receipts[1].guardian);
    assert.notEqual(receipts[0].owners, receipts[1].owners);
    assert.equal(signalNativeFixture(wrapperNative, "SIGKILL"), true);
    await exited;
    await outer.stop();
    for (const [index, receipt] of receipts.entries()) {
      const guardian = fixtures[index * 2 + 1];
      const directory = readdirSync(receipt.root)[0];
      const settled = JSON.parse(readFileSync(join(receipt.root, directory, "state.json"), "utf8"));
      assert.equal(settled.pid, guardian.pid);
      assert.equal(settled.identity, guardian.identity);
      assert.equal(settled.uid, guardian.uid);
      assert.equal(settled.state, "settled");
      assert.equal(active(receipt.child), false);
      assert.equal(active(receipt.guardian), false);
    }
  } finally {
    for (const entry of [wrapperNative, ...fixtures]) {
      // Reap every independent sibling incarnation before deleting shared evidence.
      // oxlint-disable-next-line no-await-in-loop
      await terminateNativeFixture(entry);
    }
    await exited;
    for (const receipt of receipts) {
      rmSync(receipt.root, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("WORK restoring genuine guardian DIRECTORY and hash remains stoppable", async () => {
  for (const [copyHash, phase] of [
    [false, true],
    [true, true],
    [false, null],
    [true, "true"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "ps-false-support-proof-"));
    const ready = join(root, "ready.json");
    const holderReady = join(root, "holder.json");
    writeFileSync(
      join(root, "holder.mjs"),
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(holderReady)}, JSON.stringify({ pid: process.pid,
         owners: process.env.PI_COMPAT_PROCESS_OWNERS,
         directory: process.env.PI_COMPAT_GUARDIAN_DIRECTORY,
         hash: process.env.PI_COMPAT_BASELINE_HASH ?? null }));
       setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      join(root, "actor.mjs"),
      `import { spawn } from "node:child_process";
       import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
       import { join } from "node:path";
       import { setTimeout as delay } from "node:timers/promises";
       const root = process.env.PI_COMPAT_GUARDIAN_ROOT;
       const guardian = Number(process.env.PI_COMPAT_GUARDIAN_PID);
       const directory = readdirSync(root).map(name => join(root, name)).find(directory =>
         JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).pid === guardian);
       const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
       if (${JSON.stringify(phase)} === null) delete state.rescuing;
       else state.rescuing = ${JSON.stringify(phase)};
       writeFileSync(join(directory, "state.tmp"), JSON.stringify(state), { mode: 0o600 });
       renameSync(join(directory, "state.tmp"), join(directory, "state.json"));
       const env = { ...process.env, PI_COMPAT_GUARDIAN_DIRECTORY: directory };
       if (${copyHash} && state.baselineHash) env.PI_COMPAT_BASELINE_HASH = state.baselineHash;
       const holder = spawn(process.execPath, [${JSON.stringify(join(root, "holder.mjs"))}],
         { env, stdio: "ignore" });
       holder.unref();
       while (!existsSync(${JSON.stringify(holderReady)})) await delay(10);
       writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ root, guardian, directory,
         hash: state.baselineHash ?? null }));`,
    );
    const owner = new OwnedProcesses();
    let receipt;
    let holder;
    let guardian;
    try {
      // The command's actual close/status precedes cleanup of its same-SID child.
      // oxlint-disable-next-line no-await-in-loop
      await owner.execute(
        process.execPath,
        [join(root, "actor.mjs")],
        { quiet: true },
        new AbortController().signal,
      );
      // Observe this variant's actual readiness before cleanup or the next variant.
      // oxlint-disable-next-line no-await-in-loop
      receipt = await published(ready);
      // Read this child's publication before its native identity can authorize teardown.
      // oxlint-disable-next-line no-await-in-loop
      const publication = await published(holderReady);
      holder = nativeFixture(publication.pid);
      guardian = nativeFixture(receipt.guardian);
      assert.equal(holder.uid, process.getuid());
      assert.equal(holder.exited, false);
      assert.equal(holder.sid, guardian.pid);
      assert.equal(guardian.sid, guardian.pid);
      assert.equal(publication.owners, owner.environment.PI_COMPAT_PROCESS_OWNERS);
      assert.equal(publication.directory, receipt.directory);
      assert.equal(publication.hash, copyHash ? receipt.hash : null);
      assert.equal(existsSync(receipt.root), true);
      if (phase === true) {
        // This owner must settle before the next variant's baseline is captured.
        // oxlint-disable-next-line no-await-in-loop
        await owner.stop();
        assert.equal(active(holder.pid), false, "Forged rescue phase is not direct-WORK immunity");
        assert.equal(existsSync(receipt.root), false, "Deletion follows actual WORK quiescence");
      } else {
        // Invalid phase must fail closed before the next independent variant.
        // oxlint-disable-next-line no-await-in-loop
        await assert.rejects(owner.stop(), (error) => {
          assert.match(error.cause.message, /Invalid compatibility guardian receipt/);
          return true;
        });
        assert.equal(active(holder.pid), true, "Unknown phase must never infer safe signals");
        assert.equal(existsSync(receipt.root), true, "Missing or wrong-type phase retains roots");
      }
    } finally {
      // These fixtures are reaped before the next independent role variant.
      // oxlint-disable-next-line no-await-in-loop
      await terminateNativeFixture(holder);
      // The guardian must be reaped before removing this variant's roots.
      // oxlint-disable-next-line no-await-in-loop
      await terminateNativeFixture(guardian);
      if (receipt) {
        rmSync(receipt.root, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("startup timeout cannot launch a command after cleanup acknowledgment", async () => {
  const root = mkdtempSync(join(tmpdir(), "ps-startup-cancel-proof-"));
  try {
    const publication = join(root, "unexpected");
    await assert.rejects(
      run(
        process.execPath,
        ["-e", `require("node:fs").writeFileSync(${JSON.stringify(publication)}, "launched")`],
        { timeout: 1, quiet: true },
      ),
      (error) => {
        assert.equal(error.code, "ETIMEDOUT");
        assert.notEqual(error.cleanupFailed, true);
        return true;
      },
    );
    assert.equal(
      existsSync(publication),
      false,
      "Settled owner acknowledgment forbids a late start",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "ambiguous Darwin title rewriting retains roots without signalling the process",
  { skip: process.platform !== "darwin" },
  async () => {
    for (const [title, ownerFirst, ambiguous] of [
      ["rewritten", true, true],
      ["rewritten", false, true],
      ["d".repeat(600), true, true],
      ["d".repeat(600), false, false],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "ps-title-proof-"));
      const ready = join(root, "ready.json");
      const workReady = join(root, "work.json");
      writeFileSync(
        join(root, "daemon.cjs"),
        `process.title = ${JSON.stringify(title)};
         require("node:fs").writeFileSync(${JSON.stringify(ready)}, JSON.stringify({
           pid: process.pid, owners: process.env.PI_COMPAT_PROCESS_OWNERS,
           title: process.title }));
         setInterval(() => {}, 1000);`,
      );
      writeFileSync(
        join(root, "actor.mjs"),
        `import { spawn } from "node:child_process";
         import { existsSync, writeFileSync } from "node:fs";
         import { setTimeout as delay } from "node:timers/promises";
         const owners = process.env.PI_COMPAT_PROCESS_OWNERS;
         const base = { PATH: process.env.PATH, HOME: process.env.HOME, PROBE_VISIBLE: "1",
           EXTRA: "2", LAST: "3" };
         const env = ${ownerFirst} ? { PI_COMPAT_PROCESS_OWNERS: owners, ...base }
           : { ...base, PI_COMPAT_PROCESS_OWNERS: owners };
         const child = spawn(process.execPath, [${JSON.stringify(join(root, "daemon.cjs"))}],
           { env, detached: true, stdio: "ignore" });
         child.unref();
         while (!existsSync(${JSON.stringify(ready)})) await delay(10);
         writeFileSync(${JSON.stringify(workReady)}, JSON.stringify({
           root: process.env.PI_COMPAT_GUARDIAN_ROOT,
           guardian: Number(process.env.PI_COMPAT_GUARDIAN_PID) }));`,
      );
      const owner = new OwnedProcesses();
      let daemon;
      let guardian;
      let work;
      try {
        // Each actual detached daemon has its own owner/root lifetime.
        // oxlint-disable-next-line no-await-in-loop
        await owner.execute(
          process.execPath,
          [join(root, "actor.mjs")],
          { quiet: true },
          new AbortController().signal,
        );
        // Observe this daemon's actual publication before classifying its title.
        // oxlint-disable-next-line no-await-in-loop
        const receipt = await published(ready);
        // Its command publishes the actual private root before lifecycle assertions.
        // oxlint-disable-next-line no-await-in-loop
        work = await published(workReady);
        daemon = nativeFixture(receipt.pid);
        guardian = nativeFixture(work.guardian);
        assert.equal(receipt.owners, owner.environment.PI_COMPAT_PROCESS_OWNERS);
        assert.equal(daemon.uid, process.getuid());
        assert.equal(daemon.sid, daemon.pid);
        assert.equal(daemon.exited, false);
        assert.ok(receipt.title.length > 0);
        const snapshot = processSnapshot(
          receipt.owners.split(",").at(-1),
          daemon.pid,
          Date.now() + 3000,
        );
        assert.equal(snapshot.uncertainties.length, ambiguous ? 1 : 0);
        if (ambiguous) {
          assert.equal(snapshot.uncertainties[0].pid, daemon.pid);
          assert.equal(snapshot.uncertainties[0].identity, daemon.identity);
          assert.match(snapshot.uncertainties[0].message, /outside native environment boundary/);
          // Complete this variant's failed cleanup before teardown and the next cut.
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(owner.stop(), (error) => {
            assert.match(error.message, /retain private roots/);
            assert.match(error.cause.message, /Receipt outside native environment boundary/);
            return true;
          });
          assert.equal(existsSync(work.root), true);
          assert.equal(active(daemon.pid), true, "Ambiguity never authorizes a signal");
          assert.equal(fixtureIdentity(daemon.pid).identity, daemon.identity);
        } else {
          assert.equal(snapshot.processes[0].pid, daemon.pid);
          // Complete this variant's successful cleanup before capturing the next cut.
          // oxlint-disable-next-line no-await-in-loop
          await owner.stop();
          assert.equal(active(daemon.pid), false);
          assert.equal(existsSync(work.root), false);
        }
      } finally {
        // Reap only independently authenticated fixture incarnations.
        // oxlint-disable-next-line no-await-in-loop
        await terminateNativeFixture(daemon);
        // Reap this variant's guardian before deleting its root or starting another.
        // oxlint-disable-next-line no-await-in-loop
        await terminateNativeFixture(guardian);
        if (work) {
          rmSync(work.root, { recursive: true, force: true });
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

for (const title of ["rewritten", "d".repeat(600)]) {
  test(`actual command spawn receipt survives later ${title.length > 20 ? "full-capacity" : "short"} title rewriting`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ps-spawn-title-proof-"));
    const ready = join(root, "ready.json");
    const attempt = run(
      process.execPath,
      [
        "-e",
        `process.title = ${JSON.stringify(title)};
     require("node:fs").writeFileSync(${JSON.stringify(ready)}, JSON.stringify({
       pid: process.pid, uid: process.getuid(), owners: process.env.PI_COMPAT_PROCESS_OWNERS }));
     setInterval(() => {}, 1000);`,
      ],
      { quiet: true, timeout: 1000, detached: true },
    );
    const outcome = attempt.then(
      () => ({ success: true }),
      (error) => ({ error }),
    );
    let owned;
    try {
      const receipt = await published(ready);
      // The actual command is no longer a PGID leader; observe its native birth
      // independently rather than requiring the SDK's detached-leader helper.
      owned = nativeFixture(receipt.pid);
      assert.equal(receipt.uid, process.getuid());
      assert.equal(typeof receipt.owners, "string");
      assert.ok(receipt.owners.length > 0);
      assert.ok(owned.identity);
      assert.ok(active(owned.pid));
      const result = await outcome;
      assert.equal(result.error.code, "ETIMEDOUT");
      assert.notEqual(result.error.cleanupFailed, true);
      assert.equal(active(owned.pid), false, "Actual spawn admission survives mutable argv");
    } finally {
      await outcome;
      await terminateNativeFixture(owned);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [signal, leaderStatus] of [
  ["SIGINT", 0],
  ["SIGTERM", 0],
  ["SIGTERM", 23],
]) {
  test(`repeated ${signal} after leader status ${leaderStatus} preserves failure and quiesces`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cleanup-signal-proof-"));
    const writerReady = join(root, "writer-ready.json");
    const termReady = join(root, "term-ready.json");
    writeFileSync(
      join(root, "writer.mjs"),
      `import { writeFileSync } from "node:fs";
       process.on("SIGTERM", () => writeFileSync(${JSON.stringify(termReady)},
         JSON.stringify({ pid: process.pid })));
       writeFileSync(${JSON.stringify(writerReady)}, JSON.stringify({ pid: process.pid }));
       setInterval(() => {}, 20);`,
    );
    writeFileSync(
      join(root, "leader.mjs"),
      `import { spawn } from "node:child_process";
       import { existsSync } from "node:fs";
       import { setTimeout as delay } from "node:timers/promises";
       const writer = spawn(process.execPath, [${JSON.stringify(join(root, "writer.mjs"))}],
         { detached: true, stdio: "ignore" });
       writer.unref();
       while (!existsSync(${JSON.stringify(writerReady)})) await delay(10);
       process.exitCode = ${leaderStatus};`,
    );
    writeFileSync(
      join(root, "wrapper.mjs"),
      `import { run } from ${JSON.stringify(runner)};
       import { writeFileSync } from "node:fs";
       let tick = 0;
       const heartbeat = setInterval(() => writeFileSync(${JSON.stringify(root)} + "/tick-" + ++tick, ""), 20);
       try {
         await run(process.execPath, [${JSON.stringify(join(root, "leader.mjs"))}], { quiet: true });
         process.exitCode = 0;
       } catch (error) {
         writeFileSync(${JSON.stringify(join(root, "settled.json"))},
           JSON.stringify({ signal: error.signal ?? null, status: error.status ?? null,
             cleanupFailed: error.cleanupFailed ?? false }));
         process.exitCode = 23;
       } finally {
         clearInterval(heartbeat);
       }`,
    );
    const wrapper = spawn(process.execPath, [join(root, "wrapper.mjs")], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    wrapper.stderr.on("data", (data) => {
      stderr += data;
    });
    const exited = new Promise((resolve, reject) => {
      wrapper.once("error", reject);
      wrapper.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    const wrapperIdentity = readChildProcessIdentity(wrapper.pid);
    const wrapperNative = nativeFixture(wrapper.pid);
    let writer;
    try {
      const receipt = await published(writerReady);
      writer = nativeFixture(receipt.pid);
      const termReceipt = await published(termReady);
      assert.equal(termReceipt.pid, writer.pid, "Real TERM handler proves cleanup has begun");
      assert.ok(writer.identity);
      assert.ok(active(writer.pid));
      assert.ok(wrapperIdentity);
      assert.ok(active(wrapper.pid));
      assert.equal(fixtureIdentity(wrapper.pid).identity, wrapperNative.identity);
      assert.equal(fixtureIdentity(wrapper.pid).uid, process.getuid());
      const tick = Math.max(
        0,
        ...readdirSync(root)
          .filter((name) => name.startsWith("tick-"))
          .map((name) => Number(name.slice(5))),
      );
      assert.equal(signalNativeFixture(wrapperNative, signal), true);
      // Advancing fixture publication proves the wrapper's event loop survived the
      // first signal before the second is delivered; no fixture signal listener masks it.
      await publishedTick(root, tick + 2);
      assert.ok(active(wrapper.pid), "Wrapper must remain alive throughout cleanup");
      assert.equal(fixtureIdentity(wrapper.pid).identity, wrapperNative.identity);
      assert.equal(fixtureIdentity(wrapper.pid).uid, process.getuid());
      assert.equal(signalNativeFixture(wrapperNative, signal), true);
      const result = await exited;
      assert.equal(result.signal, null, stderr);
      assert.equal(result.code, 23, stderr);
      const settlement = await published(join(root, "settled.json"));
      assert.equal(settlement.signal, leaderStatus === 0 ? signal : null);
      assert.equal(settlement.status, leaderStatus === 0 ? null : leaderStatus);
      assert.equal(settlement.cleanupFailed, false);
      assert.equal(active(writer.pid), false, "The escaped TERM-resistant writer must quiesce");
    } finally {
      for (const entry of [writer, wrapperNative]) {
        // Reap each independently authenticated fixture before proceeding.
        // oxlint-disable-next-line no-await-in-loop
        await terminateNativeFixture(entry);
      }
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function fixtureArguments(pid) {
  const mib = new Int32Array([1, 49, pid]);
  const size = Buffer.alloc(8);
  assert.equal(fixtureInteger(nativeAPI().sysctl(mib, 3, null, size, null, 0)), 0);
  const capacity = Number(size.readBigUInt64LE());
  assert.ok(capacity >= 4 && capacity <= 1048576);
  const raw = Buffer.alloc(capacity);
  assert.equal(fixtureInteger(nativeAPI().sysctl(mib, 3, raw, size, null, 0)), 0);
  return raw.subarray(0, Number(size.readBigUInt64LE()));
}
function fixtureArgumentCount(pid) {
  if (process.platform === "linux") {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    if (raw.length === 0) {
      return 0; // execve can temporarily replace mm's argv extent; not readiness.
    }
    assert.equal(raw.at(-1), 0, "Actual kernel argv has its terminating NUL");
    return raw.filter((byte) => byte === 0).length;
  }
  return fixtureArguments(pid).readInt32LE(0);
}

async function nativeExecFixture(root, owner, binary, argv, environment, name) {
  const publication = join(root, `${name}.json`);
  const launcher = join(root, "native-exec");
  const child = spawn(
    launcher,
    [publication, binary, String(argv.length), ...argv, String(environment.length), ...environment],
    { env: owner.environment, detached: true, stdio: ["ignore", "ignore", "inherit", "pipe"] },
  );
  const native = nativeFixture(child.pid);
  try {
    assert.ok(native && native.uid === process.getuid() && !native.exited);
    const receipt = await published(publication);
    assert.equal(receipt.pid, child.pid);
    assert.equal(receipt.uid, native.uid);
    assert.equal(receipt.sid, native.sid);
    assert.equal(receipt.owners, owner.environment.PI_COMPAT_PROCESS_OWNERS);
    child.stdio[3].end("x"); // The C fixture reads exactly one acknowledgement byte.
    const targetReady = environment.find((entry) => entry.startsWith("FIXTURE_READY="));
    const target =
      targetReady === undefined
        ? undefined
        : await published(targetReady.slice("FIXTURE_READY=".length));
    const deadline = Date.now() + 5000;
    while (fixtureArgumentCount(child.pid) !== argv.length) {
      assert.ok(Date.now() < deadline, "Actual execve argv was not published by the kernel");
      // Observe the kernel's new argc, never infer exec from elapsed time.
      // oxlint-disable-next-line no-await-in-loop
      await delay(20);
    }
    const current = nativeFixture(child.pid, receipt.owners.split(",").at(-1));
    assert.equal(current.identity, native.identity);
    assert.equal(current.uid, native.uid);
    assert.equal(current.sid, native.sid);
    return { child, native: current, receipt, target };
  } catch (error) {
    try {
      await terminateNativeFixture(native);
    } catch (teardownError) {
      reportFixtureTeardown([teardownError], error);
    }
    throw error;
  }
}

function compileNativeExec(root) {
  const launcher = join(root, "native-exec");
  const source = new URL("./fixtures/native-exec.c", import.meta.url).pathname;
  const compiled = spawnSync("cc", ["-Wall", "-Wextra", "-Werror", source, "-o", launcher], {
    encoding: "utf8",
  });
  assert.equal(compiled.status, 0, compiled.stderr);
  return launcher;
}

async function stopWithoutForeignSignals(owner, foreign) {
  const originalKill = process.kill;
  const attempts = [];
  process.kill = (pid, signal) => {
    if (pid === foreign.pid && signal !== 0) {
      attempts.push({ ...fixtureIdentity(pid), signal });
    }
    return originalKill(pid, signal);
  };
  try {
    await owner.stop();
  } finally {
    process.kill = originalKill;
    console.log(`Linux foreign signal attempts: ${JSON.stringify(attempts)}`);
    assert.deepEqual(attempts, [], "An opaque foreign process must never receive a signal");
  }
}

for (const mode of ["precut", "fresh-session", "caller-session", "owned-session"]) {
  test(
    `Linux non-dumpable ${mode} preserves native cleanup boundaries`,
    { skip: process.platform !== "linux" },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ps-linux-opaque-proof-"));
      const launcher = compileNativeExec(root);
      const fifo = join(root, "hold");
      assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0);
      const ready = join(root, "ready.json");
      const env = { ...process.env, FIXTURE_NONDUMPABLE: "1", FIXTURE_READY: ready };
      for (const key of [
        "PI_COMPAT_PROCESS_OWNERS",
        "PI_COMPAT_GUARDIAN_ROOT",
        "PI_COMPAT_GUARDIAN_PID",
        "PI_COMPAT_GUARDIAN_DIRECTORY",
        "PI_COMPAT_BASELINE_HASH",
      ]) {
        delete env[key];
      }
      let owner;
      let child;
      let native;
      let guardian;
      let publication;
      if (mode !== "precut") {
        owner = new OwnedProcesses(mode === "owned-session" ? env : process.env);
      }
      let outcome;
      let failure;
      let stopAttempted = false;
      try {
        if (mode === "owned-session") {
          outcome = owner
            .execute(
              launcher,
              ["--hold", fifo],
              {
                env,
                quiet: true,
                timeout: 1000,
              },
              new AbortController().signal,
            )
            .then(
              (output) => ({ output }),
              (error) => ({ error }),
            );
        } else {
          child = spawn(launcher, ["--hold", fifo], {
            env,
            detached: mode !== "caller-session",
            stdio: "ignore",
          });
        }
        publication = await published(ready);
        if (child) {
          assert.equal(publication.pid, child.pid);
        }
        native = nativeFixture(publication.pid);
        if (mode === "owned-session") {
          guardian = nativeFixture(native.sid);
        }
        assert.equal(native.uid, process.getuid());
        assert.equal(native.exited, false);
        assert.throws(() => readFileSync(`/proc/${native.pid}/environ`), { code: "EACCES" });
        console.log(
          `Linux non-dumpable precondition: ${JSON.stringify({ ...native, kernelUidRow: readFileSync(`/proc/${native.pid}/status`, "utf8").match(/^Uid:.*$/m)[0], procUid: statSync(`/proc/${native.pid}`).uid, environUid: statSync(`/proc/${native.pid}/environ`).uid, error: "EACCES" })}`,
        );
        if (mode === "precut") {
          owner = new OwnedProcesses();
        }
        if (mode === "owned-session") {
          assert.notEqual(native.pid, guardian.pid);
          assert.equal(guardian.sid, guardian.pid);
          const result = await outcome;
          assert.equal(result.error.code, "ETIMEDOUT");
          stopAttempted = true;
          await owner.stop();
          assert.equal(
            active(native.pid),
            false,
            "Opaque members of an admitted live SID remain owned",
          );
        } else {
          // Allocate a real guardian/root before the negative cleanup transition.
          await owner.execute(
            process.execPath,
            [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(join(root, "work.json"))}, JSON.stringify({ root: process.env.PI_COMPAT_GUARDIAN_ROOT, guardian: Number(process.env.PI_COMPAT_GUARDIAN_PID) }))`,
            ],
            { quiet: true },
            new AbortController().signal,
          );
          const work = await published(join(root, "work.json"));
          guardian = nativeFixture(work.guardian);
          stopAttempted = true;
          if (mode === "precut") {
            await stopWithoutForeignSignals(owner, native);
            assert.equal(existsSync(work.root), false);
          } else {
            await assert.rejects(stopWithoutForeignSignals(owner, native), (error) => {
              assert.match(
                error.cause.message,
                new RegExp(`Unanchored opaque native process ${native.pid} `),
              );
              return true;
            });
            assert.equal(
              existsSync(work.root),
              true,
              "Fresh unknown opacity retains the real private root",
            );
          }
          const live = fixtureIdentity(native.pid);
          assert.equal(live.identity, native.identity);
          assert.equal(live.uid, native.uid);
          assert.equal(live.sid, native.sid);
          assert.equal(live.exited, false, "Negative evidence never authorizes foreign signals");
          console.log(`Linux opaque survivor: ${JSON.stringify(live)}`);
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const errors = await collectFixtureTeardown([
          () => finishNativeOwner(owner, outcome, stopAttempted || !owner),
          () => terminateNativeFixture(native),
          () => terminateNativeFixture(guardian),
        ]);
        // Unknown or deliberately vetoed receipt roots remain diagnostic proof.
        if (errors.length === 0) {
          errors.push(
            ...(await collectFixtureTeardown([
              () => rmSync(root, { recursive: true, force: true }),
            ])),
          );
        }
        reportFixtureTeardown(errors, failure);
      }
    },
  );
}

function nativeExecEnvironment(root, row) {
  if (!row.libcOwner && !row.uncertainty) {
    return row.environment;
  }
  return [
    ...row.environment,
    `FIXTURE_READY=${join(root, `${row.name}-target.json`)}`,
    "FIXTURE_END=1",
  ];
}

function assertNativeExecTarget(row, executed, owner) {
  if (!row.libcOwner && !row.uncertainty) {
    return;
  }
  const target = executed.target;
  assert.equal(target.pid, executed.native.pid);
  assert.equal(target.uid, process.getuid());
  assert.equal(target.sid, executed.native.sid);
  assert.equal(
    target.owners,
    row.libcOwner === "foreign" ? "foreign" : owner.environment.PI_COMPAT_PROCESS_OWNERS,
  );
}

test("native exec table distinguishes protected omissions from complete empty argv and empty environments", async () => {
  const root = mkdtempSync(join(tmpdir(), "ps-native-exec-proof-"));
  const launcher = compileNativeExec(root);
  const fifo = join(root, "hold");
  assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0);
  const owner = new OwnedProcesses();
  const token = owner.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1);
  const rows = [];
  for (let residue = 0; residue < 8; residue++) {
    const link = join(root, `cat-${"x".repeat(residue)}`);
    symlinkSync("/bin/cat", link);
    for (const empty of [0, 1, 2, 3]) {
      rows.push({
        name: `protected-r${residue}-m${empty}`,
        binary: link,
        argv: empty === 0 ? [link, fifo] : [...Array(empty).fill(""), fifo],
        environment: ["PROBE_VISIBLE=1", ...(empty >= 2 ? ["", "EXTRA=2"] : []), "@OWNER"],
        opaque: true,
        owned: false,
      });
    }
  }
  rows.push(
    {
      name: "single-empty-argv-foreign",
      binary: launcher,
      argv: [""],
      environment: [`FIXTURE_HOLD=${fifo}`],
      opaque: false,
      owned: false,
    },
    {
      name: "empty-environment-foreign",
      binary: launcher,
      argv: ["", "--hold", fifo],
      environment: [],
      opaque: false,
      owned: false,
    },
    {
      name: "named-empty-environment-foreign",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: [],
      opaque: false,
      owned: false,
    },
    {
      name: "empty-argv-owned",
      binary: launcher,
      argv: ["", "--hold", fifo],
      environment: ["PROBE_VISIBLE=1", "@OWNER"],
      opaque: false,
      owned: true,
    },
    {
      name: "complete-foreign",
      binary: launcher,
      argv: ["", "", "--hold", fifo],
      environment: ["PROBE_VISIBLE=1", "FOREIGN=1", "EXTRA=2"],
      opaque: false,
      owned: false,
    },
    {
      name: "duplicate-owner-token-first",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: ["@OWNER", "PI_COMPAT_PROCESS_OWNERS=foreign", "PROBE_VISIBLE=1"],
      opaque: false,
      owned: true,
      libcOwner: "token",
    },
    {
      name: "duplicate-owner-token-last",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: ["PI_COMPAT_PROCESS_OWNERS=foreign", "@OWNER", "PROBE_VISIBLE=1"],
      opaque: false,
      owned: true,
      libcOwner: "foreign",
    },
    {
      name: "duplicate-owner-foreign",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: [
        "PI_COMPAT_PROCESS_OWNERS=foreign",
        "PI_COMPAT_PROCESS_OWNERS=another",
        "PROBE_VISIBLE=1",
      ],
      opaque: false,
      owned: false,
      libcOwner: "foreign",
    },
    {
      name: "duplicate-directory",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: [
        "@OWNER",
        "PI_COMPAT_GUARDIAN_DIRECTORY=first",
        "PI_COMPAT_GUARDIAN_DIRECTORY=second",
      ],
      uncertainty: "Duplicate native guardian directory",
    },
    {
      name: "duplicate-hash",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: ["@OWNER", "PI_COMPAT_BASELINE_HASH=first", "PI_COMPAT_BASELINE_HASH=second"],
      uncertainty: "Duplicate native baseline hash",
    },
    {
      name: "invalid-directory-utf8",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: ["@OWNER", "@INVALID_DIRECTORY"],
      uncertainty: "The encoded data was not valid for encoding utf-8",
      linuxOnly: true,
    },
    {
      name: "truncated-environment",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: ["@OWNER", "FIXTURE_TRUNCATE=1"],
      uncertainty: "Incomplete native environment snapshot",
      linuxOnly: true,
    },
    {
      name: "oversized-environment",
      binary: launcher,
      argv: [launcher, "--hold", fifo],
      environment: [
        "@OWNER",
        ...Array.from({ length: 9 }, (_, index) => `PAYLOAD_${index}=${"x".repeat(120000)}`),
      ],
      uncertainty: "Native environment exceeds the native-response bound",
      linuxOnly: true,
    },
  );
  try {
    for (const row of rows) {
      if (
        (process.platform !== "darwin" && row.opaque) ||
        (process.platform !== "linux" && row.linuxOnly)
      ) {
        continue; // Protected omissions are Darwin-only; procfs byte corruption is Linux-only.
      }
      // Each fixture owns a FIFO/exec lifetime and must finish before the next.
      // oxlint-disable-next-line no-await-in-loop
      const executed = await nativeExecFixture(
        root,
        owner,
        row.binary,
        row.argv,
        nativeExecEnvironment(root, row),
        row.name,
      );
      try {
        assertNativeExecTarget(row, executed, owner);
        const snapshot = processSnapshot(token, executed.native.pid, Date.now() + 3000);
        if (row.uncertainty) {
          assert.equal(snapshot.uncertainties.length, 1, row.name);
          assert.equal(snapshot.uncertainties[0].pid, executed.native.pid);
          assert.equal(snapshot.uncertainties[0].identity, executed.native.identity);
          assert.equal(snapshot.uncertainties[0].message, row.uncertainty, row.name);
          assert.equal(active(executed.native.pid), true);
          continue;
        }
        assert.deepEqual(snapshot.uncertainties, [], row.name);
        assert.equal(
          (snapshot.opaque ?? []).some((entry) => entry.pid === executed.native.pid),
          row.opaque,
          row.name,
        );
        assert.equal(
          snapshot.processes.some((entry) => entry.pid === executed.native.pid),
          row.owned,
          row.name,
        );
        if (row.opaque) {
          assert.equal(
            executed.native.environmentVisible,
            false,
            "Protected target omitted the independently published OWNER",
          );
        }
      } finally {
        // Reap this authenticated native incarnation before the next row.
        // oxlint-disable-next-line no-await-in-loop
        await terminateNativeFixture(executed.native);
      }
    }
    await owner.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a surviving pre-WORK nonleader reserves a foreign session without granting signal authority",
  {},
  async () => {
    const root = mkdtempSync(join(tmpdir(), "ps-foreign-reservation-proof-"));
    const ready = join(root, "anchor.json");
    const childReady = join(root, "child.json");
    const launch = join(root, "launch");
    const launcher = process.platform === "linux" ? compileNativeExec(root) : undefined;
    const fifo = join(root, "hold");
    if (launcher) {
      assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0);
    }
    const env = { ...process.env };
    for (const key of [
      "PI_COMPAT_PROCESS_OWNERS",
      "PI_COMPAT_GUARDIAN_ROOT",
      "PI_COMPAT_GUARDIAN_DIRECTORY",
      "PI_COMPAT_GUARDIAN_PID",
      "PI_COMPAT_BASELINE_HASH",
    ]) {
      delete env[key];
    }
    const anchorCommand = `
      printf '{"pid":%s,"owners":"%s"}' "$$" "\${PI_COMPAT_PROCESS_OWNERS:-}" > '${ready}'
      while [ ! -f '${launch}' ]; do :; done
      ${
        launcher
          ? `FIXTURE_NONDUMPABLE=1 FIXTURE_READY='${childReady}' '${launcher}' --hold '${fifo}' </dev/null >/dev/null 2>&1 &`
          : `/bin/sleep 180 </dev/null >/dev/null 2>&1 &
      printf '{"pid":%s}' "$!" > '${childReady}'`
      }
      while :; do :; done`;
    const script = join(root, "anchor.sh");
    writeFileSync(script, anchorCommand);
    const leader = spawn("/bin/sh", ["-c", `/bin/sh '${script}' </dev/null >/dev/null 2>&1 &`], {
      env,
      detached: true,
      stdio: "ignore",
    });
    const founder = nativeFixture(leader.pid);
    const exited = new Promise((resolve) => leader.once("exit", resolve));
    let anchor;
    let child;
    try {
      const receipt = await published(ready);
      anchor = nativeFixture(receipt.pid);
      await exited;
      assert.equal(receipt.owners, "");
      assert.equal(anchor.uid, process.getuid());
      assert.equal(anchor.sid, founder.pid);
      assert.notEqual(anchor.pid, anchor.sid);
      assert.equal(
        fixtureIdentity(founder.pid),
        undefined,
        "The session founder is genuinely absent before the cut",
      );
      const owner = new OwnedProcesses();
      writeFileSync(launch, "spawn after cut");
      child = nativeFixture((await published(childReady)).pid);
      assert.equal(child.sid, anchor.sid);
      assert.equal(child.uid, process.getuid());
      if (process.platform === "linux") {
        assert.throws(() => readFileSync(`/proc/${child.pid}/environ`), { code: "EACCES" });
      }
      const snapshot = processSnapshot(
        owner.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1),
        child.pid,
        Date.now() + 3000,
      );
      assert.deepEqual(snapshot.uncertainties, []);
      assert.equal(
        snapshot.opaque.some((entry) => entry.pid === child.pid),
        true,
      );
      await owner.stop();
      assert.equal(active(anchor.pid), true);
      assert.equal(
        active(child.pid),
        true,
        "Foreign reservation is negative evidence, never kill authority",
      );
    } finally {
      writeFileSync(launch, "teardown");
      for (const entry of [child, anchor, founder]) {
        // Confirm each authenticated foreign fixture is absent before the next.
        // oxlint-disable-next-line no-await-in-loop
        await terminateNativeFixture(entry);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "ordinary protected caller-SID work vetoes cleanup without a blanket pre-cut caller exemption",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "ps-caller-veto-proof-"));
    const owner = new OwnedProcesses();
    const shell = spawn(
      "/bin/sh",
      [
        "-c",
        `
      printf '{"pid":%s,"owners":"%s"}' "$$" "$PI_COMPAT_PROCESS_OWNERS" > '${root}/ready.json'
      while :; do :; done`,
      ],
      { env: owner.environment, stdio: "ignore" },
    );
    const native = nativeFixture(shell.pid);
    assert.equal(native.uid, process.getuid());
    try {
      const receipt = await published(join(root, "ready.json"));
      assert.equal(receipt.pid, native.pid);
      assert.equal(receipt.owners, owner.environment.PI_COMPAT_PROCESS_OWNERS);
      assert.equal(native.sid, fixtureIdentity(process.pid).sid);
      assert.equal(fixtureEnvironmentVisible(native.pid, receipt.owners.split(",").at(-1)), false);
      await assert.rejects(owner.stop(), (error) => {
        assert.match(
          error.cause.message,
          new RegExp(`Unanchored opaque native process ${native.pid} `),
        );
        return true;
      });
      assert.equal(active(native.pid), true, "Unknown ownership never authorizes a signal");
    } finally {
      await terminateNativeFixture(native);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const forged of [false, true]) {
  test(
    `${forged ? "forged baseline pair is rejected" : "original pre-WORK cut vetoes an opaque escape"} on normal borrow and disconnect rescue`,
    {},
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ps-original-cut-proof-"));
      const ready = join(root, "ready.json");
      const escapeReady = join(root, "escape.json");
      const go = join(root, "go");
      const borrow = join(root, "borrow.json");
      const log = join(root, "rescue.log");
      const fd = openSync(log, "w");
      const launcher = process.platform === "linux" ? compileNativeExec(root) : undefined;
      const fifo = join(root, "hold");
      if (launcher) {
        assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0);
      }
      const escapeLaunch = launcher
        ? `spawn(${JSON.stringify(launcher)}, ["--hold", ${JSON.stringify(fifo)}], { env: { ...process.env, FIXTURE_NONDUMPABLE: "1", FIXTURE_READY: ${JSON.stringify(escapeReady)} }, detached: true, stdio: "ignore" })`
        : `spawn("/bin/sh", ["-c", ${JSON.stringify(`printf '{"pid":%s,"owners":"%s"}' "$$" "$PI_COMPAT_PROCESS_OWNERS" > '${escapeReady}'; while :; do :; done`)}], { detached: true, stdio: "ignore" })`;
      writeFileSync(
        join(root, "actor.mjs"),
        `
        import { spawn } from "node:child_process";
        import { createHash } from "node:crypto";
        import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { setTimeout as delay } from "node:timers/promises";
        import { OwnedProcesses } from ${JSON.stringify(runner)};
        const escape = ${escapeLaunch};
        escape.unref();
        const receiptRoot = process.env.PI_COMPAT_GUARDIAN_ROOT;
        const guardian = Number(process.env.PI_COMPAT_GUARDIAN_PID);
        const directory = readdirSync(receiptRoot).map(name => join(receiptRoot, name)).find(directory =>
          JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).pid === guardian);
        writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, guardian: Number(process.env.PI_COMPAT_GUARDIAN_PID), receiptRoot, directory, internalHash: process.env.PI_COMPAT_BASELINE_HASH ?? null, internalDirectory: process.env.PI_COMPAT_GUARDIAN_DIRECTORY ?? null }));
        while (!existsSync(${JSON.stringify(go)})) await delay(10);
        if (${forged}) {
          const before = JSON.parse(readFileSync(join(directory, "baseline.json"), "utf8"));
          // A genuine post-escape incarnation in a self-consistent substituted cut.
          before.members.push(JSON.parse(readFileSync(${JSON.stringify(join(root, "escape-native.json"))}, "utf8")));
          const text = JSON.stringify(before);
          const hash = createHash("sha256").update(text).digest("hex");
          writeFileSync(join(directory, "baseline.tmp"), text, { mode: 0o600 });
          renameSync(join(directory, "baseline.tmp"), join(directory, "baseline.json"));
          const receipt = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
          writeFileSync(join(directory, "state.tmp"), JSON.stringify({ ...receipt, baselineHash: hash }), { mode: 0o600 });
          renameSync(join(directory, "state.tmp"), join(directory, "state.json"));
        }
        let phase = "inherit";
        try {
          const owner = new OwnedProcesses();
          owner.inherit();
          phase = "stop";
          await owner.stop();
          writeFileSync(${JSON.stringify(borrow)}, JSON.stringify({ success: true, phase }));
        } catch (error) {
          writeFileSync(${JSON.stringify(borrow)}, JSON.stringify({ success: false, phase, error: error.message, cause: error.cause?.message }));
        }
      `,
      );
      const owner = new OwnedProcesses();
      const attempt = owner.execute(
        process.execPath,
        [join(root, "actor.mjs")],
        {
          stdio: ["ignore", "ignore", fd],
        },
        new AbortController().signal,
      );
      const outcome = attempt.then(
        (output) => ({ output }),
        (error) => ({ error }),
      );
      let receipt;
      let escape;
      let guardian;
      let actor;
      let failure;
      let stopAttempted = false;
      try {
        receipt = await published(ready);
        guardian = nativeFixture(receipt.guardian);
        actor = nativeFixture(receipt.pid);
        const inherited = await published(escapeReady);
        escape = nativeFixture(inherited.pid);
        assert.equal(inherited.owners, owner.environment.PI_COMPAT_PROCESS_OWNERS);
        assert.equal(escape.uid, process.getuid());
        assert.equal(escape.sid, escape.pid);
        if (process.platform === "linux") {
          assert.throws(() => readFileSync(`/proc/${escape.pid}/environ`), { code: "EACCES" });
        } else {
          assert.equal(
            fixtureEnvironmentVisible(escape.pid, inherited.owners.split(",").at(-1)),
            false,
          );
        }
        assert.equal(receipt.internalHash, null);
        assert.equal(receipt.internalDirectory, null);
        const baseline = JSON.parse(readFileSync(join(receipt.directory, "baseline.json"), "utf8"));
        assert.equal(
          baseline.members.some((entry) => entry.pid === escape.pid),
          false,
        );
        writeFileSync(
          join(root, "escape-native.json"),
          JSON.stringify({
            pid: escape.pid,
            uid: escape.uid,
            sid: escape.sid,
            identity: escape.identity,
          }),
        );
        writeFileSync(go, "borrow");
        assert.equal((await outcome).error, undefined);
        const borrowed = await published(borrow);
        assert.equal(borrowed.success, false);
        assert.equal(borrowed.phase, forged ? "inherit" : "stop");
        assert.match(
          forged ? borrowed.error : borrowed.cause,
          forged
            ? /original baseline digest changed/
            : new RegExp(`Unanchored opaque native process ${escape.pid} `),
        );
        if (forged) {
          const state = JSON.parse(readFileSync(join(receipt.directory, "state.json"), "utf8"));
          assert.equal(
            createHash("sha256")
              .update(readFileSync(join(receipt.directory, "baseline.json")))
              .digest("hex"),
            state.baselineHash,
          );
          const genuine = processSnapshot(
            inherited.owners.split(","),
            guardian.pid,
            Date.now() + 3000,
          );
          assert.deepEqual(genuine.uncertainties, []);
          assert.equal(genuine.processes[0].complete, true);
          assert.notEqual(genuine.processes[0].baselineHash, state.baselineHash);
        }
        stopAttempted = true;
        await assert.rejects(owner.stop(), /retain private roots/);
        const deadline = Date.now() + 13000;
        const expected = forged
          ? /original baseline digest changed/
          : new RegExp(`Unanchored opaque native process ${escape.pid} `);
        while (!expected.test(readFileSync(log, "utf8"))) {
          assert.ok(Date.now() < deadline, "Disconnect rescue did not publish its actual failure");
          // Observe actual rescue completion/error, not elapsed time.
          // oxlint-disable-next-line no-await-in-loop
          await delay(20);
        }
        assert.equal(active(escape.pid), true);
        assert.equal(fixtureIdentity(guardian.pid).identity, guardian.identity);
        assert.equal(existsSync(receipt.receiptRoot), true);
        assert.equal(
          JSON.parse(readFileSync(join(receipt.directory, "state.json"), "utf8")).state,
          "ready",
        );
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const errors = await collectFixtureTeardown([
          () => writeFileSync(go, "teardown"),
          () => finishNativeOwner(owner, outcome, stopAttempted),
          () =>
            terminateNativeGuardian(
              guardian,
              owner.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1),
            ),
          ...[escape, actor, guardian].map((entry) => () => terminateNativeFixture(entry)),
          () => closeSync(fd),
        ]);
        // Failed original-cut authentication is never settlement, even after
        // fixture reaping. Keep its actual receipt root for diagnosis.
        if (errors.length === 0) {
          errors.push(
            ...(await collectFixtureTeardown([
              () => rmSync(root, { recursive: true, force: true }),
            ])),
          );
        }
        reportFixtureTeardown(errors, failure);
      }
    },
  );
}

for (const [mode, forgery] of [
  ["pre-admit", null],
  ["after-admit", null],
  ["pre-admit", "identity"],
  ["pre-admit", "sid"],
  ["pre-admit", "owners"],
  ["pre-admit", "baselineHash"],
]) {
  test(
    forgery
      ? `NO-WORK ${mode} rejects forged ${forgery} despite matching native PID and UID`
      : `genuine NO-WORK ${mode} disconnect publishes native settlement before root removal`,
    {},
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ps-no-work-proof-"));
      const ready = join(root, "ready.json");
      const release = join(root, "release");
      const failure = join(root, "rescue-error.log");
      writeFileSync(
        join(root, "actor.mjs"),
        `
        import { createHash } from "node:crypto";
        import { existsSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
        import { basename, join } from "node:path";
        import { setTimeout as delay } from "node:timers/promises";
        import { OwnedProcesses } from ${JSON.stringify(runner)};
        const root = process.env.PI_COMPAT_GUARDIAN_ROOT;
        const before = new Set(readdirSync(root));
        const inner = new OwnedProcesses();
        const controller = new AbortController();
        const errorFd = openSync(${JSON.stringify(failure)}, "a", 0o600);
        inner.execute(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(join(root, "work-ran"))}, "WORK")`)}], { quiet: true, stdio: ["ignore", "ignore", errorFd] }, controller.signal).catch(() => { /* Deliberate caller loss owns this rejected startup. */ });
        const directory = join(root, readdirSync(root).find((entry) => !before.has(entry)));
        if (${JSON.stringify(mode)} === "after-admit") {
          controller.abort();
          while (!existsSync(join(directory, "state.json"))) await delay(10);
        }
        const publication = { pid: process.pid, outerGuardian: Number(process.env.PI_COMPAT_GUARDIAN_PID), receiptRoot: root, directory,
          owners: inner.environment.PI_COMPAT_PROCESS_OWNERS.split(","),
          admitted: existsSync(join(directory, "state.json")) ? JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) : null };
        writeFileSync(${JSON.stringify(ready + ".tmp")}, JSON.stringify(publication));
        renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
        // Synchronous wait keeps pre-admit IPC queued until actual caller exit.
        while (!existsSync(${JSON.stringify(release)})) {}
        if (${JSON.stringify(forgery)} !== null) {
          const native = JSON.parse(readFileSync(${JSON.stringify(release)}, "utf8"));
          const forged = { pid: native.pid, uid: native.uid, sid: native.sid, identity: native.identity,
            owners: publication.owners, capability: basename(directory), state: "ready", rescuing: false,
            baselineHash: createHash("sha256").update(readFileSync(join(directory, "baseline.json"))).digest("hex") };
          const field = ${JSON.stringify(forgery)};
          if (field === "identity") forged.identity = process.platform === "darwin" ? "AAAAAAAAAAAAAAAAAAAAAA==" : "0";
          if (field === "sid") forged.sid = process.pid;
          if (field === "owners") forged.owners = [...publication.owners.slice(0, -1), "00000000-0000-4000-8000-000000000000"];
          if (field === "baselineHash") forged.baselineHash = "0".repeat(64);
          writeFileSync(join(directory, "state.tmp"), JSON.stringify(forged), { mode: 0o600 });
          renameSync(join(directory, "state.tmp"), join(directory, "state.json"));
        }
        process.exit(0);
      `,
      );
      const outer = new OwnedProcesses();
      let receipt;
      let guardian;
      let enclosing;
      const outcome = outer
        .execute(
          process.execPath,
          [join(root, "actor.mjs")],
          { quiet: true },
          new AbortController().signal,
        )
        .then(
          (output) => ({ output }),
          (error) => ({ error }),
        );
      try {
        receipt = await published(ready);
        assert.equal(receipt.admitted !== null, mode === "after-admit");
        guardian = await publishedNativeGuardian(receipt.pid);
        enclosing = nativeFixture(receipt.outerGuardian);
        assert.equal(guardian.uid, process.getuid());
        assert.equal(guardian.sid, guardian.pid);
        assert.equal(guardian.pgid, guardian.pid);
        assert.equal(guardian.exited, false);
        writeFileSync(`${release}.tmp`, JSON.stringify(guardian));
        renameSync(`${release}.tmp`, release);
        assert.equal((await outcome).error, undefined);
        if (forgery) {
          await assertRejectedNoWork(outer, receipt, guardian, failure, forgery);
          assert.equal(existsSync(join(root, "work-ran")), false);
        } else {
          await assertNoWorkSettlement(outer, receipt, guardian, root);
        }
      } finally {
        writeFileSync(release, "fixture teardown");
        await outcome;
        await terminateNativeFixture(guardian);
        await terminateNativeFixture(enclosing);
        if (forgery && receipt) {
          rmSync(receipt.receiptRoot, { recursive: true, force: true });
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

async function assertRejectedNoWork(outer, receipt, guardian, failure, forgery) {
  const deadline = Date.now() + 5000;
  while (
    !readFileSync(failure, "utf8").includes("Guardian NO-WORK receipt changed native admission")
  ) {
    const state = JSON.parse(readFileSync(join(receipt.directory, "state.json"), "utf8"));
    assert.notEqual(state.state, "settled", "Forged NO-WORK receipt must never publish settlement");
    assert.ok(Date.now() < deadline, "Genuine guardian did not process the forged NO-WORK receipt");
    // Actual child diagnostic publication proves processing, not a guessed delay.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
  const forged = JSON.parse(readFileSync(join(receipt.directory, "state.json"), "utf8"));
  assert.equal(forged.pid, guardian.pid);
  assert.equal(forged.uid, guardian.uid);
  assert.equal(forged.state, "ready");
  assert.equal(forged.rescuing, true, "Actual disconnect marks phase before native authentication");
  if (forgery === "owners") {
    assert.notDeepEqual(forged.owners, receipt.owners);
    assert.ok(forged.owners.includes(outer.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1)));
  } else if (forgery === "baselineHash") {
    assert.notEqual(
      forged.baselineHash,
      createHash("sha256")
        .update(readFileSync(join(receipt.directory, "baseline.json")))
        .digest("hex"),
    );
  } else {
    assert.notEqual(forged[forgery], guardian[forgery]);
  }
  const live = fixtureIdentity(guardian.pid);
  assert.equal(live.identity, guardian.identity);
  assert.equal(live.uid, guardian.uid);
  assert.equal(live.sid, guardian.sid);
  assert.equal(live.exited, false);
  assert.equal(existsSync(join(receipt.directory, "state.json")), true);
  await assert.rejects(outer.stop(), /retain private roots/);
  assert.deepEqual(JSON.parse(readFileSync(join(receipt.directory, "state.json"), "utf8")), forged);
  assert.equal(fixtureIdentity(guardian.pid).identity, guardian.identity);
  assert.equal(
    active(guardian.pid),
    true,
    "Rejected guardian retains its genuine native reservation",
  );
  assert.equal(
    existsSync(receipt.receiptRoot),
    true,
    "Forged metadata must never authorize root deletion",
  );
}

async function assertNoWorkSettlement(outer, receipt, guardian, root) {
  const deadline = Date.now() + 5000;
  let settled;
  while (!settled) {
    const file = join(receipt.directory, "state.json");
    if (existsSync(file)) {
      const state = JSON.parse(readFileSync(file, "utf8"));
      if (state.state === "settled") {
        settled = state;
      }
    }
    assert.ok(Date.now() < deadline, "Genuine no-work guardian did not settle");
    // Observe native lifecycle publication, not absence or a fabricated receipt.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
  assert.equal(settled.uid, process.getuid());
  assert.equal(settled.sid, settled.pid);
  assert.equal(settled.pid, guardian.pid);
  assert.equal(settled.identity, guardian.identity);
  assert.equal(settled.rescuing, receipt.admitted !== null);
  assert.deepEqual(settled.owners, receipt.owners);
  assert.ok(settled.owners.includes(outer.environment.PI_COMPAT_PROCESS_OWNERS.split(",").at(-1)));
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(receipt.directory, "baseline.json")))
      .digest("hex"),
    settled.baselineHash,
  );
  if (receipt.admitted) {
    assert.equal(receipt.admitted.identity, settled.identity);
    assert.equal(receipt.admitted.baselineHash, settled.baselineHash);
  }
  while (fixturePresent(settled.pid)) {
    assert.ok(Date.now() < deadline, "Settled no-work guardian did not exit");
    // Settlement and actual native absence are separate requirements.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
  assert.throws(() => process.kill(settled.pid, 0), { code: "ESRCH" });
  console.log(
    `Native NO-WORK absence: ${JSON.stringify({ pid: settled.pid, uid: settled.uid, identity: settled.identity, errno: "ESRCH" })}`,
  );
  assert.equal(existsSync(join(root, "work-ran")), false);
  await outer.stop();
  assert.equal(existsSync(receipt.directory), false);
}

async function publishedTick(root, tick) {
  const deadline = Date.now() + 5000;
  while (!existsSync(join(root, `tick-${tick}`))) {
    assert.ok(Date.now() < deadline, "Wrapper stopped publishing during cleanup");
    // Observe actual event-loop publication after the interrupt.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

async function published(file) {
  const deadline = Date.now() + 5000;
  while (!existsSync(file)) {
    assert.ok(Date.now() < deadline, `Missing actual publication: ${file}`);
    // Wait for actual child readiness, not a guessed startup sleep.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function active(pid) {
  if (process.platform === "linux" && existsSync(`/proc/${pid}/stat`)) {
    // An adopted zombie cannot write or spawn; only init can reap it.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert.equal(error.code, "ESRCH");
    return false;
  }
}

function runSuite(args, options) {
  // Observe the leaf directly: an outer shared runner would conceal a broken
  // leaf by cleaning up escaped descendants before these assertions.
  const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      const error = new Error(output);
      error.status = code;
      reject(error);
    });
  });
}

function fixture(root) {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { owned: "node parent.mjs" } }),
  );
  writeFileSync(
    join(root, "writer.mjs"),
    `
    import { appendFileSync, writeFileSync } from "node:fs";
    process.on("SIGTERM", () => { /* Force the real cleanup escalation path. */ });
    writeFileSync(${JSON.stringify(join(root, "writer-ready.json"))}, JSON.stringify({pid: process.pid}));
    setInterval(() => appendFileSync(${JSON.stringify(join(root, "writes"))}, "owned\\n"), 20);
  `,
  );
  writeFileSync(
    join(root, "parent.mjs"),
    `
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const { spawnBrokerIfNeeded, isBrokerRunning, getBrokerSpawnOptions } = await import(${JSON.stringify(brokerSpawn)});
    const { getPiAgentDir } = await import(${JSON.stringify(agentDirectory)});
    await spawnBrokerIfNeeded(process.execPath, []);
    assert.equal(await isBrokerRunning(), true);
    const brokerPid = Number(readFileSync(join(getPiAgentDir(), "intercom/broker.pid"), "utf8").split("\\n")[0]);
    const writer = spawn(process.execPath, [${JSON.stringify(join(root, "writer.mjs"))}], getBrokerSpawnOptions());
    writer.unref();
    while (!existsSync(${JSON.stringify(join(root, "writer-ready.json"))})) await delay(10);
    writeFileSync(${JSON.stringify(join(root, "ready.json"))}, JSON.stringify({
      parentPid: process.pid, brokerPid, writerPid: writer.pid, uid: process.getuid(),
      home: process.env.HOME, owners: (process.env.PI_COMPAT_PROCESS_OWNERS ?? "").split(",").filter(Boolean)
    }));
    while (!existsSync(${JSON.stringify(join(root, "fail"))})) await delay(10);
    process.exit(23);
  `,
  );
  writeFileSync(
    join(root, "nested.mjs"),
    `
    import { run } from ${JSON.stringify(runner)};
    await run("npm", ["run", "owned"], { cwd: ${JSON.stringify(root)}, timeout: 15000 });
  `,
  );
}

for (const mode of ["caught failure", "ancestor timeout", "suite watchdog"]) {
  test(`actual npm/native detached descendants quiesce after ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ps-command-proof-"));
    fixture(root);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const unrelatedNative = nativeFixture(unrelated.pid);
    const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), HOME: root };
    // This fixture launches an independent test runner, not a recursive test().
    delete env.NODE_TEST_CONTEXT;
    const command = mode === "suite watchdog" ? suiteRunner : join(root, "nested.mjs");
    if (mode === "suite watchdog") {
      mkdirSync(join(root, "test/unit"), { recursive: true });
      writeFileSync(
        join(root, "test/unit/owned.test.ts"),
        `await import(${JSON.stringify(new URL(`file://${join(root, "parent.mjs")}`).href)});`,
      );
    }
    const args = mode === "suite watchdog" ? [command, "unit", "--timeout-ms", "6000"] : [command];
    const attempt =
      mode === "suite watchdog"
        ? runSuite(args, { cwd: root, env })
        : run(process.execPath, args, {
            cwd: root,
            env,
            quiet: true,
            timeout: mode === "ancestor timeout" ? 6000 : 15000,
          });
    // Handle rejection immediately while readiness is observed independently.
    const outcome = attempt.then(
      (stdout) => ({ stdout }),
      (error) => ({ error }),
    );
    let receipt;
    let owned = [];
    try {
      receipt = await published(join(root, "ready.json"));
      owned = [receipt.brokerPid, receipt.writerPid].map((pid) => nativeFixture(pid));
      assert.ok(active(receipt.brokerPid));
      assert.ok(active(receipt.writerPid));
      assert.equal(receipt.uid, process.getuid());
      if (mode !== "suite watchdog") {
        assert.ok(
          new Set(receipt.owners).size >= 2,
          "Inherited owner receipts survived native launch",
        );
      }
      if (mode === "caught failure") {
        writeFileSync(join(root, "fail"), "fail now");
      }
      const result = await outcome;
      assert.ok(result.error instanceof Error, "Original failure must remain visible");
      assert.notEqual(result.error.cleanupFailed, true);
      assert.equal(active(receipt.brokerPid), false);
      assert.equal(active(receipt.writerPid), false);
      assert.equal(active(unrelated.pid), true, "Unrelated same-UID process must survive");
      if (mode === "ancestor timeout") {
        assert.equal(result.error.code, "ETIMEDOUT");
      }
      if (mode === "suite watchdog") {
        assert.equal(result.error.status, 1);
        assert.match(result.error.message, /unit tests timed out after 6000ms/);
        assert.equal(existsSync(receipt.home), false, "Suite root removed only after quiescence");
      }
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    } finally {
      await outcome;
      if (existsSync(root)) {
        writeFileSync(join(root, "fail"), "fixture teardown");
      }
      for (const entry of owned) {
        // Reap each independently authenticated fixture before proceeding.
        // oxlint-disable-next-line no-await-in-loop
        await terminateNativeFixture(entry);
      }
      await terminateNativeFixture(unrelatedNative);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("command output and native start/failure status survive process settlement", async () => {
  assert.equal(
    await run(process.execPath, ["-e", 'console.log("receipt")'], { quiet: true }),
    "receipt\n",
  );
  // Independent multibyte payload exceeds actual pipe chunks; each chunk may
  // split a UTF8 sequence. Status and close must retain the whole decoded stream.
  const payload = "雪".repeat(50_000);
  assert.equal(
    await run(process.execPath, ["-e", "process.stdout.write('雪'.repeat(50000))"], {
      quiet: true,
    }),
    payload,
  );
  await assert.rejects(run(process.execPath, ["-e", "process.exit(23)"], { quiet: true }), {
    status: 23,
  });
  await assert.rejects(run("/nonexistent/pi-owned-command", []), { code: "ENOENT" });
  const root = mkdtempSync(join(tmpdir(), "ps-descriptor-proof-"));
  const sink = join(root, "sink");
  const fd = openSync(sink, "w");
  try {
    assert.equal(
      await run(
        process.execPath,
        ["-e", 'require("node:fs").writeFileSync(3, "native sink"); console.log(process.cwd())'],
        {
          cwd: pathToFileURL(root),
          quiet: true,
          stdio: ["ignore", "pipe", "pipe", fd],
        },
      ),
      `${realpathSync(root)}\n`,
    );
    assert.equal(
      readFileSync(sink, "utf8"),
      "native sink",
      "IPC must not replace a caller FD sink",
    );
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});
