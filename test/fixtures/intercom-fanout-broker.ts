import { Socket } from "node:net";
import { readSync, writeSync } from "node:fs";
import { isRecord, type UnknownRecord } from "../../src/shared/unknown.ts";

// Preserve the original receiver when forwarding through Reflect.apply below.
// oxlint-disable-next-line typescript/unbound-method
const nativeWrite = Socket.prototype.write;
const deliveries = new Map<string, number>();
let gateId: string | undefined;

function secondPublication(frame: Readonly<UnknownRecord>): string | undefined {
  if (frame.type !== "message" || !isRecord(frame.message)) {
    return undefined;
  }
  const { content, id } = frame.message;
  if (
    !isRecord(content) ||
    (content.text !== "FANOUT_stall" && content.text !== "FANOUT_kill") ||
    typeof id !== "string"
  ) {
    return undefined;
  }
  const count = (deliveries.get(content.text) ?? 0) + 1;
  deliveries.set(content.text, count);
  return count === 2 ? id : undefined;
}

function holdAcknowledgement(): void {
  writeSync(1, `${JSON.stringify({ event: "ack_gate_entered", messageId: gateId })}\n`);
  writeSync(3, "E");
  const byte = Buffer.alloc(1);
  for (;;) {
    try {
      if (readSync(3, byte, 0, 1, null) !== 1 || byte[0] !== 1) {
        throw new Error("Fanout gate closed without release.");
      }
      return;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EAGAIN") {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

// Keep the real recipient write, but hold its second matching acknowledgement at the native
// socket boundary. The private fd 3 gate prevents later fanout admission until release or kill.
Object.assign(Socket.prototype, {
  write(this: Socket, chunk: unknown, ...args: readonly unknown[]): boolean {
    if (Buffer.isBuffer(chunk) && chunk.length >= 4 && chunk.readUInt32BE(0) === chunk.length - 4) {
      const frame: unknown = JSON.parse(chunk.subarray(4).toString("utf8"));
      if (isRecord(frame)) {
        gateId ??= secondPublication(frame);
        if (frame.type === "delivered" && gateId !== undefined && frame.messageId === gateId) {
          holdAcknowledgement();
          gateId = undefined;
        }
      }
    }
    return Reflect.apply(nativeWrite, this, [chunk, ...args]) === true;
  },
});

await import("../../src/pi-intercom/broker/broker.ts");
