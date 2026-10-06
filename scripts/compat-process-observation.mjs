import { readFileSync, readdirSync, statSync } from "node:fs";
import { darwinSnapshot } from "./compat-process-darwin.mjs";

export const OWNER = "PI_COMPAT_PROCESS_OWNERS";
export const GUARDIAN_DIRECTORY = "PI_COMPAT_GUARDIAN_DIRECTORY";
export const GUARDIAN_ROOT = "PI_COMPAT_GUARDIAN_ROOT";
export const GUARDIAN_PID = "PI_COMPAT_GUARDIAN_PID";
// Guardian-internal fork-time digest of the original cut; stripped from WORK.
export const BASELINE_HASH = "PI_COMPAT_BASELINE_HASH";

function linuxIdentity(pid) {
  const base = `/proc/${pid}`;
  const stat = readFileSync(`${base}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  return {
    pid,
    uid: statSync(base).uid,
    exited: ["Z", "X"].includes(fields[0]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    identity: fields[19],
  };
}
function linuxReceipt(pid, tokens) {
  const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
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
  return (
    entries
      .find((entry) => entry.startsWith(`${GUARDIAN_DIRECTORY}=`))
      ?.slice(GUARDIAN_DIRECTORY.length + 1) ?? ""
  );
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
      return { identities: [before], processes: [], uncertainties: [] };
    }
    const directory = linuxReceipt(pid, tokens);
    const after = linuxIdentity(pid);
    validateStable(before, after);
    return {
      identities: [after],
      processes: directory === undefined ? [] : [{ pid, identity: after.identity, directory }],
      uncertainties: [],
    };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) {
      return { identities: [], processes: [], uncertainties: [] };
    }
    return {
      identities: before ? [before] : [],
      processes: [],
      uncertainties: [{ pid, identity: before?.identity, message: error.message }],
    };
  }
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
