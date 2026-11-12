import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";

const [root, repo] = process.argv.slice(2);
assert.ok(root !== undefined && root !== "" && repo !== undefined && repo !== "");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_") || key === "NODE_OPTIONS") {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, "agent"),
  PI_INTERCOM_RUNTIME_DIR: path.join(root, "ic"),
  PI_OFFLINE: "1",
});

await import(pathToFileURL(path.join(repo, "dist/pi-intercom/broker/broker.js")).href);
const keeper = new IntercomClient();
await keeper.connect({ name: "native-fixture-owner", cwd: root, model: "none" });
assert.equal(typeof process.send, "function");
const disconnected = once(process, "disconnect");
process.send?.({ pid: process.pid, sessionId: keeper.sessionId });
await disconnected;
await keeper.disconnect();
process.kill(process.pid, "SIGTERM");
