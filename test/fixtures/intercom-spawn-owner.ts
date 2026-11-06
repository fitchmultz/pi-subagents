import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnBrokerIfNeeded } from "../../src/pi-intercom/broker/spawn.ts";

const runtime = process.env.PI_INTERCOM_RUNTIME_DIR;
assert.ok(runtime !== undefined && runtime !== "");
if (process.argv[2] === "suspend") {
  const broker = process.argv[3];
  assert.ok(broker !== undefined && broker !== "");
  const marker = join(runtime, "suspended-candidate.json");
  writeFileSync(
    `${marker}.tmp`,
    JSON.stringify({ launcher: process.ppid, candidate: process.pid }),
  );
  renameSync(`${marker}.tmp`, marker);
  process.kill(process.ppid, "SIGSTOP");
  process.kill(process.pid, "SIGSTOP");
  await import(pathToFileURL(broker).href);
} else {
  await spawnBrokerIfNeeded(
    process.execPath,
    process.argv[2] === "hold" ? [import.meta.filename, "suspend"] : [],
  );
  process.send?.({ event: "ready" });
  process.disconnect();
}
