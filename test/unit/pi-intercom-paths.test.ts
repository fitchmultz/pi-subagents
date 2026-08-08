import assert from "node:assert/strict";
import * as fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import test from "node:test";
import { getBrokerSocketPath, getLegacyBrokerSocketPath, prepareBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";

test("getBrokerSocketPath uses named pipe on Windows", () => {
  const pipePath = getBrokerSocketPath("win32", "C:/Users/rcroh");
  assert.match(pipePath, /^\\\\\.\\pipe\\pi-intercom-/);
  assert.doesNotMatch(pipePath, /broker\.sock$/);
});

test("getBrokerSocketPath is pure and uses a short temp socket on non-Windows", () => {
  const agentDir = `/home/rcroh-${randomUUID()}`;
  const socketPath = getBrokerSocketPath("linux", agentDir);
  assert.match(socketPath, /pi-intercom-[a-f0-9]{16}[\\/]broker\.sock$/);
  assert.doesNotMatch(socketPath, /rcroh/);
  assert.ok(Buffer.byteLength(socketPath) <= 100, socketPath);
  assert.equal(fs.existsSync(socketPath), false);
});

test("getBrokerSocketPath falls back to /tmp only when the preferred socket path is too long", () => {
  const socketPath = getBrokerSocketPath("darwin", `/agent-${randomUUID()}`, `/private/${"long/".repeat(30)}tmp`);
  assert.match(socketPath, /^\/tmp\/pi-intercom-[a-f0-9]{16}\/broker\.sock$/);
});

test("prepareBrokerSocketPath rejects an unusable socket directory at runtime", { skip: process.platform === "win32" }, () => {
  const agentDir = `/tmp/pi-agent-${randomUUID()}`;
  const brokerDir = dirname(getBrokerSocketPath(process.platform, agentDir));
  fs.writeFileSync(brokerDir, "blocked", "utf-8");
  try {
    assert.throws(() => prepareBrokerSocketPath(process.platform, agentDir));
  } finally {
    fs.rmSync(brokerDir, { force: true });
  }
});

test("getBrokerSocketPath keeps an existing legacy broker reachable during migration", { skip: process.platform === "win32" }, async () => {
  const agentDir = `/tmp/pi-agent-${randomUUID()}`;
  const legacyPath = getLegacyBrokerSocketPath(agentDir);
  const server = net.createServer();
  server.listen(legacyPath);
  await once(server, "listening");
  try {
    assert.equal(prepareBrokerSocketPath(process.platform, agentDir), legacyPath);
    assert.equal(fs.statSync(legacyPath).mode & 0o777, 0o600);
  } finally {
    server.close();
    await once(server, "close");
    fs.rmSync(legacyPath, { force: true });
  }
});
