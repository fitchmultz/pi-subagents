import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnBrokerIfNeeded } from "../../src/pi-intercom/broker/spawn.ts";

const runtime = process.env.PI_INTERCOM_RUNTIME_DIR;
assert.ok(runtime !== undefined && runtime !== "");

function publishCandidate(directory: string): void {
  const marker = join(directory, "candidate.json");
  writeFileSync(
    `${marker}.tmp`,
    JSON.stringify({ launcher: process.ppid, candidate: process.pid }),
  );
  renameSync(`${marker}.tmp`, marker);
}

if (process.argv[2] === "candidate") {
  const broker = process.argv[4];
  assert.ok(broker !== undefined && broker !== "");
  publishCandidate(runtime);
  if (process.argv[3] === "claim") {
    // The real PID read blocks after startup ownership; the parent opens the
    // FIFO writer to witness that read before launching a contender.
    execFileSync("mkfifo", [join(runtime, "broker.pid")]);
  } else {
    process.kill(process.pid, "SIGSTOP");
  }
  await import(pathToFileURL(broker).href);
} else {
  const mode = process.argv[2];
  await spawnBrokerIfNeeded(
    process.execPath,
    mode === undefined ? [] : [import.meta.filename, "candidate", mode],
  );
  process.send?.({ event: "ready" });
  process.disconnect();
}
