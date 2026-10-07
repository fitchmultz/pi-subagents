import { spawn } from "node:child_process";
import { OwnedProcesses } from "./compat-process.mjs";
import {
  BASELINE_HASH,
  GUARDIAN_DIRECTORY,
  GUARDIAN_PID,
  OWNER,
  nativeIdentity,
} from "./compat-process-observation.mjs";
import { publishGuardianReceipt, readGuardianReceipt } from "./compat-process-receipt.mjs";
import { basename } from "node:path";

const directory = process.env[GUARDIAN_DIRECTORY];
process.env[GUARDIAN_PID] = String(process.pid);
const owners = process.env[OWNER].split(",");
function initializeRescueReceipt() {
  let existing = false;
  try {
    markRescuing();
    existing = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  // An existing receipt must defer this actual self-authentication query too.
  // Missing state already makes enclosing observation fail closed.
  const admission = nativeSelfAdmission();
  if (!existing) {
    publishGuardianReceipt(directory, admission);
    return admission;
  }
  const receipt = ownReceipt();
  if (
    Object.keys(admission).some(
      (key) =>
        key !== "rescuing" && JSON.stringify(receipt[key]) !== JSON.stringify(admission[key]),
    )
  ) {
    throw new Error("Guardian NO-WORK receipt changed native admission");
  }
  return receipt;
}
function nativeSelfAdmission() {
  const identity = nativeIdentity(process.pid, Date.now() + 3000);
  if (
    !identity ||
    identity.exited ||
    identity.sid !== process.pid ||
    identity.pgid !== process.pid ||
    identity.uid !== process.getuid()
  ) {
    throw new Error("Guardian lost native private session admission");
  }
  return {
    pid: process.pid,
    uid: identity.uid,
    sid: identity.sid,
    identity: identity.identity,
    owners,
    capability: basename(directory),
    state: "ready",
    rescuing: false,
    baselineHash: process.env[BASELINE_HASH],
  };
}
let started = false;
let cancelled = false;
let command;
let commandExited = true;
let rescuing = false;

function send(message) {
  if (process.connected) {
    process.send(message, (error) => {
      if (error && process.connected) {
        console.error("Guardian IPC failed:", error.message);
      }
    });
  }
}
function ownReceipt() {
  const receipt = readGuardianReceipt(directory);
  if (receipt.pid !== process.pid || receipt.uid !== process.getuid()) {
    throw new Error("Guardian lifecycle receipt changed identity");
  }
  return receipt;
}
function markRescuing() {
  publishGuardianReceipt(directory, { ...ownReceipt(), rescuing: true });
}
function settle(receipt = ownReceipt()) {
  publishGuardianReceipt(directory, { ...receipt, state: "settled" });
  process.exit(0);
}
function start(message) {
  if (started || cancelled) {
    return;
  }
  started = true;
  const env = { ...process.env, [GUARDIAN_PID]: String(process.pid) };
  // Keep the guardian's original-cut authentication metadata out of WORK.
  delete env[GUARDIAN_DIRECTORY];
  delete env[BASELINE_HASH];
  command = spawn(message.command, message.args, {
    ...message.options,
    detached: false,
    env,
    stdio: Array.from({ length: message.descriptors }, (_, index) => index),
  });
  commandExited = false;
  command.once("error", (error) => {
    commandExited = true;
    send({
      type: "error",
      error: {
        message: error.message,
        code: error.code,
        errno: error.errno,
        syscall: error.syscall,
        path: error.path,
        spawnargs: error.spawnargs,
      },
    });
  });
  command.once("exit", (code, signal) => {
    commandExited = true;
    send({ type: "exit", code, signal });
  });
}
async function rescue() {
  if (rescuing) {
    return;
  }
  rescuing = true;
  cancelled = true;
  if (!started) {
    // Cancellation precedes any queued start, so genuine NO-WORK can settle
    // its admitted (or natively self-admitted) receipt without a cleanup sweep.
    settle(initializeRescueReceipt());
    return;
  }
  // Only unexpected parent loss invokes local cleanup. Normal release never
  // performs a second sweep that could mask a failed parent ownership proof.
  // Started WORK requires its original admitted receipt. Publish rescue phase
  // before ANY query launch; a missing/invalid receipt holds fail-closed instead.
  markRescuing();
  const owner = new OwnedProcesses(process.env, owners.at(-1));
  owner.inherit();
  await owner.stop();
  if (!commandExited) {
    throw new Error("Guardian command has not exited after rescue");
  }
  settle();
}
process.on("message", (message) => {
  if (message.type === "start") {
    start(message);
  } else if (message.type === "cancel") {
    cancelled = true;
    send({ type: "cancelled" }); // serialized after any preceding start callback
  } else if (message.type === "release") {
    if (!cancelled || !commandExited) {
      send({ type: "error", error: { message: "Guardian release before command quiescence" } });
      return;
    }
    settle();
  }
});
process.on("disconnect", () => {
  rescue().catch((error) => {
    console.error("Guardian rescue failed; retaining private roots:", error);
    // An uncertain guardian must remain a live SID reservation, not disappear.
    setInterval(() => {
      /* Hold the native reservation for diagnosis. */
    }, 60_000);
  });
});
process.on("SIGINT", () => {
  /* Parent or disconnect rescue owns cancellation. */
});
process.on("SIGTERM", () => {
  /* Work must quiesce before this leader is released. */
});
send({ type: "ready" });
