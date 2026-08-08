import assert from "node:assert/strict";
import * as fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import test from "node:test";
import { getBrokerSocketPath, getLegacyBrokerSocketPath, isOwnedBrokerSocket, prepareBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { createMessageReader, writeMessage } from "../../src/pi-intercom/broker/framing.ts";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";

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

test("getBrokerSocketPath includes uid scope while preserving the legacy digest", () => {
  const agentDir = `/home/shared-${randomUUID()}`;
  const uid501 = getBrokerSocketPath("linux", agentDir, "/tmp", 501);
  const uid502 = getBrokerSocketPath("linux", agentDir, "/tmp", 502);
  assert.notEqual(uid501, uid502);
  assert.notEqual(uid501, getLegacyBrokerSocketPath(agentDir, "/tmp"));
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

test("client falls back to an owned live legacy socket without mutating it", { skip: process.platform === "win32" }, async () => {
  const agentDir = `/tmp/pi-agent-${randomUUID()}`;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const legacyPath = getLegacyBrokerSocketPath(agentDir);
  const server = net.createServer((socket) => {
    socket.on("data", createMessageReader((message) => {
      if (message && typeof message === "object" && "type" in message && message.type === "register") {
        writeMessage(socket, { type: "registered", sessionId: "legacy-session" });
      }
    }));
  });
  server.listen(legacyPath);
  await once(server, "listening");
  const modeBefore = fs.statSync(legacyPath).mode & 0o777;
  const client = new IntercomClient();
  try {
    await client.connect({ name: "legacy-client", cwd: "/tmp", model: "test", status: "idle" });
    assert.equal(client.sessionId, "legacy-session");
    assert.equal(fs.statSync(legacyPath).mode & 0o777, modeBefore);
  } finally {
    await client.disconnect().catch(() => undefined);
    server.close();
    await once(server, "close");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(legacyPath, { force: true });
  }
});

test("prepareBrokerSocketPath never switches startup ownership to a live legacy socket", { skip: process.platform === "win32" }, async () => {
  const agentDir = `/tmp/pi-agent-${randomUUID()}`;
  const legacyPath = getLegacyBrokerSocketPath(agentDir);
  const server = net.createServer();
  server.listen(legacyPath);
  await once(server, "listening");
  try {
    assert.equal(prepareBrokerSocketPath(process.platform, agentDir), getBrokerSocketPath(process.platform, agentDir));
    assert.equal(isOwnedBrokerSocket(legacyPath), true);
    const symlinkPath = `${legacyPath}.link`;
    fs.symlinkSync(legacyPath, symlinkPath);
    assert.equal(isOwnedBrokerSocket(symlinkPath), false);
    fs.unlinkSync(symlinkPath);
  } finally {
    server.close();
    await once(server, "close");
    fs.rmSync(legacyPath, { force: true });
  }
});
