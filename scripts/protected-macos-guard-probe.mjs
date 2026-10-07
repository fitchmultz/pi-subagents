#!/usr/bin/env node
// Standard CI-UID native controls, never a GitHub job/source certification.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const [mode, value] = process.argv.slice(2);
if (["--help", "-h"].includes(mode)) {
  console.log(
    "Usage: node protected-macos-guard-probe.mjs --worker 0|1 OR --socket tcp|unix\nCI-UID native qualification control. Publishes ready only after actual runtime/listen readiness. Send one stdin line to close/reap the owned control. Exit0 reaped;1 failed;2 usage. Example: --worker 0",
  );
  process.exit(0);
}
assert.equal(process.getuid(), 502);
assert.ok(
  (mode === "--worker" && ["0", "1"].includes(value)) ||
    (mode === "--socket" && ["tcp", "unix"].includes(value)),
);
async function worker() {
  mkdirSync("/Users/ci/runner/_diag", { recursive: true, mode: 0o700 });
  const before = new Set(readdirSync("/Users/ci/runner/_diag"));
  const child = spawn("/Users/ci/runner/bin/Runner.Worker", ["spawnclient", "3", "4"], {
    cwd: "/Users/ci/runner",
    env: {
      HOME: "/Users/ci",
      USER: "ci",
      LOGNAME: "ci",
      PATH: "/bin:/usr/bin",
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: "/tmp",
      DOTNET_EnableDiagnostics: value,
    },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  child.stdio[3].on("error", () => {
    /* Owned Worker exit closes the pipe; joined below. */
  });
  const returned = once(child, "exit").then(
    ([code, signal]) => ({ code, signal }),
    (error) => ({ error }),
  );
  let failure;
  try {
    await publishWorker(child, before);
    await Promise.race([once(process.stdin, "data"), once(process.stdin, "end")]);
  } catch (error) {
    failure = error;
  }
  child.stdio[3].end();
  const { code, signal, error } = await returned;
  if (failure) {
    throw failure;
  }
  if (error) {
    throw error;
  }
  assert.equal(signal, null);
  console.log(JSON.stringify({ reaped: true, pid: child.pid, code }));
}
async function publishWorker(child, before) {
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(child.exitCode, null, "Official Worker exited before genuine channel readiness");
    const logs = readdirSync("/Users/ci/runner/_diag").filter(
      (name) => !before.has(name) && /^Worker_.*\.log$/.test(name),
    );
    if (
      logs.some((name) =>
        readFileSync(`/Users/ci/runner/_diag/${name}`, "utf8").includes(
          "Waiting to receive the job message from the channel.",
        ),
      )
    ) {
      break;
    }
    assert.ok(Date.now() < deadline, "Official Worker did not initialize its channel");
    // Genuine runtime trace readiness, not a sleep-based absence claim.
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
  console.log(
    JSON.stringify({
      ready: true,
      pid: child.pid,
      observerPID: process.pid,
      mode,
      diagnostics: value,
    }),
  );
}
async function socket() {
  const server = createServer((connection) => connection.end());
  const address =
    value === "tcp" ? { host: "127.0.0.1", port: 0 } : `/tmp/protected-macos-${randomUUID()}.sock`;
  server.listen(address);
  await once(server, "listening");
  console.log(JSON.stringify({ ready: true, pid: process.pid, mode, family: value }));
  await Promise.race([once(process.stdin, "data"), once(process.stdin, "end")]);
  const closed = once(server, "close");
  server.close();
  await closed;
  console.log(JSON.stringify({ reaped: true, pid: process.pid }));
}
if (mode === "--worker") {
  await worker();
} else {
  await socket();
}
