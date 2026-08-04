import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMessageReader, MAX_FRAME_SIZE_BYTES, writeMessage } from "../../src/pi-intercom/broker/framing.ts";

test("framing rejects oversized incoming frames before buffering payload", () => {
  const errors: Error[] = [];
  const messages: unknown[] = [];
  const reader = createMessageReader((message) => messages.push(message), (error) => errors.push(error));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_SIZE_BYTES + 1, 0);

  reader(header);

  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /frame too large/);
});

test("framing refuses to write oversized messages", () => {
  const socket = new EventEmitter() as EventEmitter & { write(chunk: Buffer): boolean };
  socket.write = () => true;

  assert.throws(
    () => writeMessage(socket as never, { text: "x".repeat(MAX_FRAME_SIZE_BYTES + 1) }),
    /message too large/,
  );
});
