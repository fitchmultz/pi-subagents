import assert from "node:assert/strict";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { spawnBrokerIfNeeded } from "../../src/pi-intercom/broker/spawn.ts";
import { nativePeerId } from "../../src/pi-intercom/session-targets.ts";
import { errorMessage, isRecord } from "../../src/shared/unknown.ts";

const client = new IntercomClient();
client.on("error", (error: Error) => {
  process.send?.({ event: "error", error: error.message });
});
client.on("message", (from: unknown, message: unknown) => {
  process.send?.({ event: "received", from, message });
});
process.on("message", (message) => {
  if (!isRecord(message)) {
    return;
  }
  void (async () => {
    switch (message.action) {
      case "list":
        return await client.listSessions();
      case "send":
        if (typeof message.to !== "string" || typeof message.text !== "string") {
          throw new Error("Invalid send");
        }
        return await client.send(message.to, { text: message.text });
      case "disconnect":
        await client.disconnect();
        process.disconnect();
        return;
    }
    return null;
  })().then(
    (result) => process.send?.({ request: message.request, result }),
    (error: unknown) => process.send?.({ request: message.request, error: errorMessage(error) }),
  );
});
await spawnBrokerIfNeeded(process.execPath, []);
const peerArgument = process.argv[2];
assert.ok(peerArgument !== undefined, "expected a native peer id argument");
await client.connect(
  { name: "duplicate-worker", cwd: process.cwd(), model: "fixture", status: "idle" },
  nativePeerId(peerArgument),
);
process.send?.({ event: "ready", id: client.sessionId });
