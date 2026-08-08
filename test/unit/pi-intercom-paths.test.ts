import assert from "node:assert/strict";
import * as fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getBrokerSocketPath, getLegacyBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";

test("getBrokerSocketPath uses named pipe on Windows", () => {
  const pipePath = getBrokerSocketPath("win32", "C:/Users/rcroh");
  assert.match(pipePath, /^\\\\\.\\pipe\\pi-intercom-/);
  assert.doesNotMatch(pipePath, /broker\.sock$/);
});

test("getBrokerSocketPath uses a short temp socket on non-Windows", () => {
  const socketPath = getBrokerSocketPath("linux", `/home/rcroh-${randomUUID()}`);
  assert.match(socketPath, /pi-intercom-[a-f0-9]{16}[\\/]broker\.sock$/);
  assert.doesNotMatch(socketPath, /rcroh/);
  assert.ok(socketPath.length < 100, socketPath);
});

test("getBrokerSocketPath keeps an existing legacy broker reachable during migration", { skip: process.platform === "win32" }, async () => {
  const agentDir = `/tmp/pi-agent-${randomUUID()}`;
  const legacyPath = getLegacyBrokerSocketPath(agentDir);
  const server = net.createServer();
  server.listen(legacyPath);
  await once(server, "listening");
  try {
    assert.equal(getBrokerSocketPath(process.platform, agentDir), legacyPath);
    assert.equal(fs.statSync(legacyPath).mode & 0o777, 0o600);
  } finally {
    server.close();
    await once(server, "close");
    fs.rmSync(legacyPath, { force: true });
  }
});
