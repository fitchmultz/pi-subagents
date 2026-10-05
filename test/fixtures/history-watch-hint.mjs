import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

// Retain an actual native notification until refresh has indexed its file.
// Park queued pumps only while IPC observes the delivered hint.
const file = process.argv[3],
  watch = fs.watch,
  immediate = globalThis.setImmediate;
const hints = [],
  pumps = [];
let held = false;
let automatic = false;
fs.watch = function (directory, options, callback) {
  const sourceParent = path.resolve(directory) === path.dirname(file);
  const registered = sourceParent ? fs.statSync(directory, { bigint: true }) : undefined;
  const directoryId = registered && `${registered.dev}:${registered.ino}`;
  const watcher = watch.call(this, directory, options, (event, name) => {
    if (path.resolve(directory) === path.dirname(file) && String(name) === path.basename(file)) {
      if (automatic) {
        const current = fs.statSync(directory, { bigint: true });
        if (`${current.dev}:${current.ino}` === directoryId) {
          callback(event, name);
          return;
        }
      }
      hints.push(() => callback(event, name));
      process.send({ watchHint: "observed" });
    } else {
      callback(event, name);
    }
  });
  if (sourceParent) {
    process.send({ watchDirectory: directoryId });
  }
  return watcher;
};
syncBuiltinESMExports();
globalThis.setImmediate = function (callback, ...args) {
  if (!held) {
    return immediate(callback, ...args);
  }
  pumps.push(() => immediate(callback, ...args));
  return { unref() {} };
};
process.on("message", (message) => {
  if (message.watchHint === "deliver") {
    held = true;
    for (const hint of hints.splice(0)) {
      hint();
    }
    process.send({ watchHint: "delivered" });
  }
  if (message.watchHint === "drain") {
    held = false;
    for (const pump of pumps.splice(0)) {
      pump();
    }
  }
  if (message.watchHint === "automatic") {
    automatic = true;
    process.send({ watchHint: "automatic" });
  }
});
