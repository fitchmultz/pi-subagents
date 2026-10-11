import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isRecord, isUnknownArray } from "../../src/shared/unknown.ts";

// After setOwner admits <runId> first, hold the history worker synchronously at one native phase
// until the parent writes to fd 4: "admission:<runId>" at the metadata-root watch, after the
// database writes and before the reply; "changed:<runId>" at the next change publication, before
// its IPC write. The entered witness also uses fd 4, keeping the history IPC protocol unchanged.
const [phase = "", marker = ""] = (process.argv[3] ?? "").split(":");
const send = process.send?.bind(process);
if ((phase !== "admission" && phase !== "changed") || marker.length === 0 || !send) {
  throw new Error("History gate requires IPC and an admission:<runId> or changed:<runId> phase.");
}
let armed = false;
process.on("message", (request: unknown) => {
  if (isRecord(request) && request.method === "setOwner" && isRecord(request.input)) {
    const { runs } = request.input;
    const first: unknown = isUnknownArray(runs) ? runs[0] : undefined;
    armed ||= isRecord(first) && first.runId === marker;
  }
});
function hold(): void {
  armed = false;
  fs.writeSync(4, "E");
  const byte = Buffer.alloc(1);
  for (;;) {
    try {
      if (fs.readSync(4, byte, 0, 1, null) !== 1 || byte[0] !== 1) {
        throw new Error("History gate closed without release.");
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
if (phase === "admission") {
  const watch = fs.watch;
  Object.assign(fs, {
    watch(
      directory: string,
      options?: Readonly<fs.WatchOptionsWithStringEncoding>,
      listener?: fs.WatchListener<string>,
    ): fs.FSWatcher {
      if (armed && directory.endsWith("/sessions/subagent-runs")) {
        hold();
      }
      return watch(directory, options, listener);
    },
  });
  syncBuiltinESMExports();
} else {
  Object.assign(process, {
    send(
      message: unknown,
      sendHandle?: undefined,
      options?: undefined,
      callback?: (error: Readonly<Error> | null) => void,
    ): boolean {
      if (armed && isRecord(message) && message.changed === true) {
        hold();
      }
      return send(message, sendHandle, options, callback);
    },
  });
}
