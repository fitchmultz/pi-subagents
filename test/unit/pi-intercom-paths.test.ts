import test from "node:test";
import assert from "node:assert/strict";
import { getBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";

test("getBrokerSocketPath uses named pipe on Windows", () => {
  const pipePath = getBrokerSocketPath("win32", "C:/Users/rcroh");
  assert.match(pipePath, /^\\\\\.\\pipe\\pi-intercom-/);
  assert.doesNotMatch(pipePath, /broker\.sock$/);
});

test("getBrokerSocketPath uses a short temp socket on non-Windows", () => {
  const socketPath = getBrokerSocketPath("linux", "/home/rcroh");
  assert.match(socketPath, /pi-intercom-[a-f0-9]{16}\.sock$/);
  assert.doesNotMatch(socketPath, /rcroh/);
  assert.ok(socketPath.length < 100, socketPath);
});
