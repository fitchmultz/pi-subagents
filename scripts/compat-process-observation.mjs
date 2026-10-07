import { closeSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { darwinSnapshot } from "./compat-process-darwin.mjs";

export const OWNER = "PI_COMPAT_PROCESS_OWNERS";
export const GUARDIAN_DIRECTORY = "PI_COMPAT_GUARDIAN_DIRECTORY";
export const GUARDIAN_ROOT = "PI_COMPAT_GUARDIAN_ROOT";
export const GUARDIAN_PID = "PI_COMPAT_GUARDIAN_PID";
// Guardian-internal fork-time digest of the original cut; stripped from WORK.
export const BASELINE_HASH = "PI_COMPAT_BASELINE_HASH";

function linuxIdentity(pid) {
  // Pin this proc inode while reading credentials and birth; a reused numeric
  // PID must not splice another process's status into the original stat.
  const fd = openSync(`/proc/${pid}`, "r");
  try {
    return linuxIdentityAt(pid, `/proc/self/fd/${fd}`);
  } finally {
    closeSync(fd);
  }
}
function linuxIdentityAt(pid, base) {
  const stat = readFileSync(`${base}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  // Proc metadata ownership can change for non-dumpable processes without a
  // credential change. Kernel status supplies the actual effective UID.
  const uids = readFileSync(`${base}/status`, "utf8").match(/^Uid:\s+\d+\s+(\d+)\s+\d+\s+\d+$/m);
  if (!uids || !Number.isSafeInteger(Number(uids[1]))) {
    throw new Error(`Invalid native credentials for PID ${pid}`);
  }
  return {
    pid,
    uid: Number(uids[1]),
    exited: ["Z", "X"].includes(fields[0]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    identity: fields[19],
  };
}
function linuxEnvironment(pid) {
  const fd = openSync(`/proc/${pid}/environ`, "r");
  try {
    const raw = Buffer.alloc(1024 * 1024 + 1);
    const length = readSync(fd, raw);
    if (length === raw.length || readSync(fd, Buffer.alloc(1)) !== 0) {
      throw new Error("Native environment exceeds the native-response bound");
    }
    if (length !== 0 && raw[length - 1] !== 0) {
      throw new Error("Incomplete native environment snapshot");
    }
    return raw.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
function linuxReceipt(pid, tokens) {
  const entries = linuxEnvironment(pid).toString("latin1").split("\0");
  const owned = entries.some(
    (entry) =>
      entry.startsWith(`${OWNER}=`) &&
      tokens.some((token) =>
        entry
          .slice(OWNER.length + 1)
          .split(",")
          .includes(token),
      ),
  );
  if (!owned) {
    return;
  }
  return {
    pid,
    directory: linuxMetadata(entries, GUARDIAN_DIRECTORY, "guardian directory") ?? "",
    baselineHash: linuxMetadata(entries, BASELINE_HASH, "baseline hash"),
    complete: true,
  };
}
function linuxMetadata(entries, key, label) {
  const values = entries.filter((entry) => entry.startsWith(`${key}=`));
  if (values.length > 1) {
    throw new Error(`Duplicate native ${label}`);
  }
  const value = values[0]?.slice(key.length + 1);
  if (key === GUARDIAN_DIRECTORY && value !== undefined) {
    return new TextDecoder("utf8", { fatal: true }).decode(Buffer.from(value, "latin1"));
  }
  return value;
}
function validateStable(before, after) {
  if (after.identity !== before.identity || after.uid !== before.uid || after.sid !== before.sid) {
    throw new Error(`Unstable native snapshot for PID ${before.pid}`);
  }
}
function linuxCandidate(pid, tokens, identityOnly) {
  let before;
  try {
    before = linuxIdentity(pid);
    if (identityOnly || before.uid !== process.getuid() || before.exited) {
      return { identities: [before], processes: [], opaque: [], uncertainties: [] };
    }
    const receipt = linuxReceipt(pid, tokens);
    const after = linuxIdentity(pid);
    validateStable(before, after);
    return {
      identities: [after],
      processes: receipt === undefined ? [] : [{ ...receipt, identity: after.identity }],
      opaque: [],
      uncertainties: [],
    };
  } catch (error) {
    return linuxFailure(pid, before, error);
  }
}
function linuxFailure(pid, before, error) {
  if (["ENOENT", "ESRCH"].includes(error.code)) {
    return { identities: [], processes: [], opaque: [], uncertainties: [] };
  }
  let failure = error;
  if (before && error.code === "EACCES") {
    try {
      // A denied environment is opaque only for the SAME live birth/UID/SID.
      // Native failures or a changed incarnation never gain cut exemptions.
      const after = linuxIdentity(pid);
      validateStable(before, after);
      return {
        identities: [after],
        processes: [],
        opaque: after.exited ? [] : [{ pid, identity: after.identity, sid: after.sid }],
        uncertainties: [],
      };
    } catch (afterError) {
      failure = afterError;
    }
  }
  return {
    identities: before ? [before] : [],
    processes: [],
    opaque: [],
    uncertainties: [{ pid, identity: before?.identity, message: failure.message }],
  };
}
export function processSnapshot(token, pid, deadline, identityOnly = false) {
  if (process.platform === "darwin") {
    return darwinSnapshot(token, pid, deadline, identityOnly);
  }
  if (process.platform !== "linux") {
    throw new Error("Compatibility process ownership requires Linux or macOS");
  }
  const candidates =
    pid === undefined
      ? readdirSync("/proc")
          .filter((name) => /^\d+$/.test(name))
          .map(Number)
      : [pid];
  const tokens = Array.isArray(token) ? token : [token];
  const snapshots = candidates.map((candidate) => {
    if (Date.now() >= deadline) {
      throw new Error("Owned-process cleanup observation exceeded its deadline");
    }
    return linuxCandidate(candidate, tokens, identityOnly);
  });
  return {
    identities: snapshots.flatMap((entry) => entry.identities),
    processes: snapshots.flatMap((entry) => entry.processes),
    opaque: snapshots.flatMap((entry) => entry.opaque),
    uncertainties: snapshots.flatMap((entry) => entry.uncertainties),
  };
}
export function captureBaseline() {
  const snapshot = processSnapshot("", undefined, Date.now() + 3000, true);
  if (snapshot.uncertainties.length !== 0) {
    throw new Error(snapshot.uncertainties.map((entry) => entry.message).join("; "));
  }
  const caller = snapshot.identities.find((entry) => entry.pid === process.pid);
  if (!caller || caller.exited || caller.sid <= 0) {
    throw new Error("Cannot establish the caller's native session");
  }
  // Every live pre-WORK member can continue reserving its SID.
  const members = snapshot.identities
    .filter((entry) => !entry.exited && entry.uid === process.getuid() && entry.sid > 0)
    .map(({ pid, uid, sid, identity }) => ({ pid, uid, sid, identity }));
  return { callerSid: caller.sid, members };
}
export function nativeIdentity(pid, deadline) {
  const snapshot = processSnapshot("", pid, deadline, true);
  if (snapshot.uncertainties.length !== 0) {
    throw new Error(snapshot.uncertainties.map((entry) => entry.message).join("; "));
  }
  return snapshot.identities[0];
}
export function sameBirth(entry, identity) {
  return entry !== undefined && entry.uid === process.getuid() && entry.identity === identity;
}
