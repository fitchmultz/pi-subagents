import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { readChildProcessIdentity } from "../shared/post-exit-stdio-guard.ts";
import { read, write } from "./storage.ts";
import { processSchema } from "./contracts.ts";
import { verifyProcess } from "./process.ts";

// Called by the actual native shell before executing any user command.
const directory = process.argv.at(2),
  token = process.argv.at(3),
  rawPid = process.argv.at(4);
const pid = Number(rawPid);
if (
  directory === undefined ||
  token === undefined ||
  !Number.isSafeInteger(pid) ||
  pid < 1 ||
  process.ppid !== pid
) {
  throw new Error("Native shell registration requires its actual parent shell.");
}
const group = Number(
  execFileSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim(),
);
const identity = readChildProcessIdentity(pid);
if (group !== pid || identity === undefined) {
  throw new Error("Cannot verify the native shell's process-group birth.");
}
function verifyOwner(dir: string, claim: string): void {
  const owner = read(path.join(dir, "actor.lock/process.json"), processSchema);
  if (
    !owner ||
    owner.token !== claim ||
    !verifyProcess(owner) ||
    fs.existsSync(path.join(dir, `stopping-${claim}.json`))
  ) {
    throw new Error("Native shell owner is absent, replaced or stopping.");
  }
}
verifyOwner(directory, token);
write(
  path.join(directory, "shells", token, `${randomUUID()}.json`),
  {
    pid,
    identity,
    token,
  },
  true,
);
verifyOwner(directory, token);
