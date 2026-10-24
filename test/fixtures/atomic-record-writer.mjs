import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { write } from "../../src/agent/storage.ts";

const [file, id, gate] = process.argv.slice(2);
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
    if (error.code !== "EEXIST") {
      throw error;
    }
    outcome = "exists";
  }
  process.send(outcome, () => process.disconnect());
});
process.send("ready");
