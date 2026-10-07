#!/usr/bin/env node
// Ordinary CI-account qualification, before any runner credential or untrusted job.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `${command} failed`);
  return result.stdout;
}
function nativeAPI(source) {
  const require = createRequire(join(source, "package.json"));
  const koffi = require("koffi");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const proc = koffi.load("/usr/lib/libproc.dylib");
  return {
    koffi,
    system,
    pidinfo: proc.func(
      "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
    ),
    getsid: system.func("int getsid(int pid)"),
    flags: system.func("int csops(int pid, unsigned int ops, void *buffer, size_t size)"),
    sysctl: system.func(
      "int sysctl(int *name, unsigned int namelen, void *oldp, size_t *oldlenp, void *newp, size_t newlen)",
    ),
  };
}
function identity(api, pid) {
  const data = Buffer.alloc(136);
  assert.equal(api.pidinfo(pid, 3, 1, data, data.length), data.length);
  assert.equal(data.readUInt32LE(12), pid);
  return {
    pid,
    uid: data.readUInt32LE(20),
    sid: api.getsid(pid),
    birth: data.subarray(120, 136).toString("base64"),
  };
}
function nativeBytes(api, pid) {
  const mib = new Int32Array([1, 49, pid]);
  const size = Buffer.alloc(8);
  assert.equal(api.sysctl(mib, 3, null, size, null, 0), 0);
  const capacity = Number(size.readBigUInt64LE());
  assert.ok(capacity >= 4 && capacity <= 1048576);
  const bytes = Buffer.alloc(capacity);
  assert.equal(api.sysctl(mib, 3, bytes, size, null, 0), 0);
  const used = Number(size.readBigUInt64LE());
  assert.ok(used >= 4 && used <= capacity);
  return bytes.subarray(0, used);
}
async function publication(observe) {
  const deadline = Date.now() + 5000;
  while (!observe()) {
    assert.ok(Date.now() < deadline, "Native fixture did not publish its actual phase");
    // Observe the actual publication/exec before proceeding, never a guessed sleep.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
}
function restrictedFlags(api, pid) {
  const buffer = Buffer.alloc(4);
  assert.equal(api.flags(pid, 0, buffer, buffer.length), 0);
  return buffer.readUInt32LE();
}
function observerReceipt() {
  const signing = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", process.execPath], {
    encoding: "utf8",
  });
  assert.equal(signing.status, 0);
  const entitlements = signing.stdout + signing.stderr;
  assert.ok(!entitlements.includes("com.apple.private.read-environment-variables"));
  const kernel = execute("/usr/sbin/sysctl", ["-n", "kern.version"]);
  assert.ok(!/DEVELOPMENT|DEBUG/.test(kernel));
  return {
    kernel,
    node: {
      path: process.execPath,
      version: process.version,
      sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      entitlements,
    },
  };
}
async function nativeProof(source) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.getuid(), 502);
  const api = nativeAPI(source);
  const csr = api.system.func("int csr_check(uint32_t mask)");
  const csrResult = csr(0x20);
  const csrErrno = api.koffi.errno();
  assert.equal(csrResult, -1);
  assert.equal(csrErrno, 1, "Kernel must deny unrestricted DTRACE");
  const observer = observerReceipt();
  const token = randomUUID();
  const ready = `/Users/ci/native-${token}.json`;
  const fixture = `/Users/ci/native-${token}`;
  execute("/usr/bin/clang", [join(source, "test/quality/fixtures/native-exec.c"), "-o", fixture]);
  const child = spawn(fixture, [ready, "/bin/sleep", "2", "/bin/sleep", "60", "1", "@OWNER"], {
    env: { PATH: "/usr/bin:/bin", PI_COMPAT_PROCESS_OWNERS: token },
    stdio: ["ignore", "ignore", "inherit", "pipe"],
  });
  const outcome = new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", resolveExit);
  });
  let admitted;
  try {
    await publication(() => existsSync(ready));
    const published = JSON.parse(readFileSync(ready, "utf8"));
    admitted = identity(api, child.pid);
    assert.deepEqual(
      [published.pid, published.uid, published.sid, published.owners],
      [admitted.pid, admitted.uid, admitted.sid, token],
    );
    assert.ok(
      nativeBytes(api, child.pid).includes(Buffer.from(token)),
      "Actually inherited OWNER must be visible before restricted exec",
    );
    child.stdio[3].end("x");
    await publication(() => (restrictedFlags(api, child.pid) & 0x800) !== 0);
    assert.deepEqual(identity(api, child.pid), admitted);
    const raw = nativeBytes(api, child.pid);
    assert.equal(raw.readInt32LE(0), 2);
    assert.ok(raw.includes(Buffer.from("/bin/sleep\0")) && raw.includes(Buffer.from("60\0")));
    assert.equal(
      raw.includes(Buffer.from(token)),
      false,
      "Successful kernel argv bytes must omit inherited OWNER",
    );
    console.log(
      JSON.stringify({
        ...observer,
        published,
        admitted,
        targetFlags: restrictedFlags(api, child.pid),
        csrUnrestrictedDtraceResult: csrResult,
        csrErrno,
        inheritedOwnerPresent: true,
        ownerOmitted: true,
        argv: ["/bin/sleep", "60"],
        rawBase64: raw.toString("base64"),
      }),
    );
  } finally {
    if (admitted) {
      assert.deepEqual(identity(api, child.pid), admitted);
    }
    child.kill("SIGKILL");
    await outcome;
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    rmSync(fixture);
    if (existsSync(ready)) {
      rmSync(ready);
    }
  }
}
if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  console.log(
    "Usage: node protected-macos-guest-probe.mjs /Users/ci/source\nPre-registration ordinary-Node CSR/target/argv/OWNER-omission proof. Exit 0 pass, 1 fail, 2 usage.",
  );
} else if (process.argv.length !== 3) {
  console.error("Usage: node protected-macos-guest-probe.mjs /Users/ci/source");
  process.exitCode = 2;
} else {
  try {
    await nativeProof(resolve(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native guest proof failed");
    process.exitCode = 1;
  }
}
