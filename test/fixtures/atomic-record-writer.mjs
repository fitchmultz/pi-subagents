import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { write } from "../../src/agent/storage.ts";

const [fileArgument, idArgument] = process.argv.slice(2);
assert.ok(fileArgument !== undefined && idArgument !== undefined, "expected file and id arguments");
const file = fileArgument;
const id = idArgument;
const send = process.send?.bind(process);
if (send === undefined) {
  throw new Error("Run this fixture under a parent with an IPC channel");
}
const gate = process.argv.at(4);
fs.linkSync = () => {
  throw Object.assign(new Error("Hard links are denied"), { code: "EACCES" });
};
if (gate !== undefined) {
  const fsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    fsync(fd);
    fs.writeFileSync(`${gate}.ready`, "flushed");
    while (!fs.existsSync(`${gate}.release`)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
}
syncBuiltinESMExports();
process.once("message", () => {
  let outcome = "published";
  try {
    write(file, { winner: Number(id), body: "P".repeat(200_000) }, true);
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
    outcome = "exists";
  }
  send(outcome, () => process.disconnect());
});
send("ready");
