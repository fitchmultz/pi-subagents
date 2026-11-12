import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishAttachment } from "../../src/agent/attachment.ts";
import { ensureActor, ownIdentity } from "../../src/agent/process.ts";
import { OwnershipLock } from "../../src/agent/ownership-lock.ts";
import { launchSchema } from "../../src/agent/contracts.ts";
import { Assert } from "../../src/agent/typebox.ts";
import { assertRecord } from "../support/assertions.ts";

const root = process.argv[2];
if (root === undefined) {
  throw new Error("Missing isolated ownership root");
}
const base = join(root, "owner");
const launch: unknown = JSON.parse(readFileSync(join(root, "launch.json"), "utf8"));
Assert(launchSchema, launch);
let held: OwnershipLock | undefined;
process.on("message", (message: unknown) => {
  assertRecord(message);
  const action = message.action;
  const execute = async () => {
    if (action === "hold") {
      held = new OwnershipLock(base);
    } else if (action === "release") {
      held?.close();
      held = undefined;
    } else if (action === "attach") {
      publishAttachment(base, ownIdentity(), `main-${process.pid}`);
    } else if (action === "ensure" || action === "spawn-failure") {
      // Real runners stop at Node's native entry, before SDK/provider effects.
      process.env.NODE_OPTIONS = "--inspect-brk=127.0.0.1:0";
      await ensureActor(
        base,
        action === "spawn-failure" ? { ...launch, cwd: join(root, "missing") } : launch,
      );
      const record: unknown = JSON.parse(
        readFileSync(join(base, "run/actor.lock/process.json"), "utf8"),
      );
      return { record };
    }
    return {};
  };
  execute()
    .then((result) => process.send?.({ action, ok: true, ...result }))
    .catch((error: unknown) => {
      process.send?.({
        action,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});
process.send?.({ ready: true });
