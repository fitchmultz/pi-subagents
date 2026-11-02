import "../support/isolated-home.ts";
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import {
  createMessageReader,
  MAX_FRAME_SIZE_BYTES,
  writeMessage,
} from "../../src/pi-intercom/broker/framing.ts";

nodeTest("framing rejects oversized incoming frames before buffering payload", () => {
  const errors: Error[] = [];
  const messages: unknown[] = [];
  const reader = createMessageReader(
    (message) => {
      messages.push(message);
    },
    (error) => {
      errors.push(error);
    },
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_SIZE_BYTES + 1, 0);

  reader(header);

  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /frame too large/);
});

nodeTest("framing refuses to write oversized messages", () => {
  const socket = new Socket();

  assert.throws(
    () => writeMessage(socket, { text: "x".repeat(MAX_FRAME_SIZE_BYTES + 1) }),
    /message too large/,
  );
});

function frame(json: string): Buffer {
  const payload = Buffer.from(json);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

nodeTest(
  "framing preserves split headers, UTF-8 and coalesced messages up to the exact limit",
  () => {
    const small = { text: "日本語 🦄" };
    const maximum = { text: "x".repeat(MAX_FRAME_SIZE_BYTES - 11) };
    for (const [message, chunkSize] of [
      [small, 1],
      [maximum, 1024],
      [maximum, 4096],
      [maximum, 65536],
    ] as const) {
      const messages: unknown[] = [];
      const errors: Error[] = [];
      const reader = createMessageReader(
        (value) => {
          messages.push(value);
        },
        (error) => {
          errors.push(error);
        },
      );
      const wire = Buffer.concat([frame(JSON.stringify(message)), frame('{"after":true}')]);
      for (let offset = 0; offset < wire.length; offset += chunkSize) {
        reader(wire.subarray(offset, offset + chunkSize));
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(messages, [message, { after: true }]);
    }
  },
);

nodeTest(
  "framing drops an oversized read but retains the unprocessed tail after parse or handler errors",
  () => {
    for (const failure of ["size", "parse", "handler", "empty"] as const) {
      const errors: Error[] = [];
      const messages: unknown[] = [];
      const reader = createMessageReader(
        (message) => {
          if (message === "throw") {
            throw new Error("handler failure");
          }
          messages.push(message);
        },
        (error) => {
          errors.push(error);
        },
      );
      const invalid = Buffer.alloc(4);
      invalid.writeUInt32BE(MAX_FRAME_SIZE_BYTES + 1);
      const bad = { size: invalid, parse: frame("{"), handler: frame('"throw"'), empty: frame("") };
      const wire = Buffer.concat([bad[failure], frame('{"retained":true}')]);
      reader(wire.subarray(0, 2));
      reader(wire.subarray(2));
      assert.deepEqual(messages, []);
      assert.equal(errors.length, 1);
      const expectedError =
        failure === "size" ? /frame too large/ : /Failed to (?:parse|handle) intercom message/;
      assert.match(errors[0].message, expectedError);
      reader(Buffer.alloc(0));
      assert.deepEqual(messages, failure === "size" ? [] : [{ retained: true }]);
      reader(frame('{"fresh":true}'));
      assert.deepEqual(messages[messages.length - 1], { fresh: true });
      assert.equal(errors.length, 1);
    }
  },
);

nodeTest("framing validates and writes the same single JSON encoding", (t) => {
  const socket = new Socket();
  const writes: unknown[] = [];
  t.mock.method(socket, "write", (chunk: unknown) => {
    writes.push(chunk);
    return true;
  });
  let encodings = 0;
  writeMessage(socket, {
    toJSON() {
      encodings++;
      return { text: encodings === 1 ? "one encoding" : "x".repeat(MAX_FRAME_SIZE_BYTES) };
    },
  });
  assert.equal(encodings, 1);
  assert.deepEqual(writes, [frame('{"text":"one encoding"}')]);
  assert.throws(
    () => writeMessage(socket, { text: "日".repeat(MAX_FRAME_SIZE_BYTES / 2) }),
    /message too large/,
  );
  assert.equal(writes.length, 1);
});
