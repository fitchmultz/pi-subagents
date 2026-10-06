import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

const BASELINE_BYTES = 1024 * 1024; // The existing native-response bound.

function controlledDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Invalid compatibility guardian directory permissions");
  }
}
function validateReceipt(receipt, directory) {
  if (
    receipt.capability !== basename(directory) ||
    !["ready", "settled"].includes(receipt.state) ||
    typeof receipt.rescuing !== "boolean" ||
    !Array.isArray(receipt.owners) ||
    !/^[0-9a-f]{64}$/.test(receipt.baselineHash)
  ) {
    throw new Error("Invalid compatibility guardian receipt");
  }
}
export function readGuardianReceipt(directory) {
  if (
    !basename(dirname(directory)).startsWith("pi-compat-guardians-") ||
    !/^[0-9a-f-]{36}$/.test(basename(directory))
  ) {
    throw new Error("Invalid compatibility guardian directory");
  }
  controlledDirectory(dirname(directory));
  controlledDirectory(directory);
  const fd = openSync(join(directory, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192
    ) {
      throw new Error("Invalid compatibility guardian receipt permissions or size");
    }
    const receipt = JSON.parse(readFileSync(fd, "utf8"));
    validateReceipt(receipt, directory);
    return receipt;
  } finally {
    closeSync(fd);
  }
}
function authenticateBaseline(entry, directory, receipt, nativeReceipt) {
  // Mutable filesystem pairs cannot authenticate the original cut. Every
  // admission, borrow and rediscovery binds to the live guardian's complete
  // native fork environment, never a WORK marker or a newly captured cut.
  if (
    nativeReceipt?.pid !== entry.pid ||
    nativeReceipt.identity !== entry.identity ||
    nativeReceipt.directory !== directory ||
    nativeReceipt.complete !== true ||
    nativeReceipt.baselineHash !== receipt.baselineHash
  ) {
    throw new Error(
      `Guardian ${entry.pid} original baseline digest changed or native environment incomplete`,
    );
  }
}
export function admittedGuardian(entry, directory, tokens, nativeReceipt) {
  const receipt = readGuardianReceipt(directory);
  authenticateBaseline(entry, directory, receipt, nativeReceipt);
  if (
    entry.uid !== process.getuid() ||
    entry.exited ||
    entry.sid !== entry.pid ||
    entry.pgid !== entry.pid ||
    receipt.pid !== entry.pid ||
    receipt.uid !== entry.uid ||
    receipt.sid !== entry.sid ||
    receipt.identity !== entry.identity ||
    !tokens.some((token) => receipt.owners.includes(token))
  ) {
    throw new Error(`Cannot authenticate compatibility guardian ${entry.pid}`);
  }
  return { ...receipt, directory };
}
export function guardianSettled(guardian) {
  const receipt = readGuardianReceipt(guardian.directory);
  return (
    receipt.state === "settled" &&
    ["pid", "uid", "sid", "identity", "capability", "baselineHash"].every(
      (key) => receipt[key] === guardian[key],
    ) &&
    JSON.stringify(receipt.owners) === JSON.stringify(guardian.owners)
  );
}
export function currentGuardian(receipt, snapshot, tokens) {
  if (!receipt?.directory) {
    return;
  }
  const binding = readGuardianReceipt(receipt.directory);
  if (binding.pid !== receipt.pid) {
    return; // Role-shaped WORK cannot stand in for the actual guardian.
  }
  const entry = snapshot.identities.find((value) => value.pid === binding.pid);
  if (!entry || entry.exited) {
    return;
  }
  return admittedGuardian(entry, receipt.directory, tokens, receipt);
}
export function publishGuardianReceipt(directory, receipt) {
  const temp = join(directory, "state.tmp");
  writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(temp, join(directory, "state.json"));
}
// The original pre-WORK cut is plain bounded JSON in the private directory.
export function serializeBaseline(baseline) {
  const text = JSON.stringify(baseline);
  if (Buffer.byteLength(text) > BASELINE_BYTES) {
    throw new Error("Pre-work native baseline exceeds the native-response bound");
  }
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}
export function publishBaseline(directory, serialized) {
  controlledDirectory(dirname(directory));
  controlledDirectory(directory);
  writeFileSync(join(directory, "baseline.json"), serialized.text, { mode: 0o600, flag: "wx" });
}
function validBaseline(value) {
  return (
    Number.isSafeInteger(value?.callerSid) &&
    value.callerSid > 0 &&
    Array.isArray(value.members) &&
    value.members.every(
      (member) =>
        Number.isSafeInteger(member?.pid) &&
        member.pid > 0 &&
        Number.isSafeInteger(member.sid) &&
        member.sid > 0 &&
        member.uid === process.getuid() &&
        typeof member.identity === "string" &&
        (process.platform === "linux"
          ? /^\d+$/.test(member.identity)
          : /^[A-Za-z0-9+/]{22}==$/.test(member.identity)),
    )
  );
}
export function readBaseline(directory, hash) {
  controlledDirectory(dirname(directory));
  controlledDirectory(directory);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("Invalid original baseline digest");
  }
  const fd = openSync(join(directory, "baseline.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > BASELINE_BYTES
    ) {
      throw new Error("Invalid original baseline permissions or size");
    }
    const text = readFileSync(fd, "utf8");
    if (createHash("sha256").update(text).digest("hex") !== hash) {
      throw new Error("Original baseline digest changed");
    }
    const baseline = JSON.parse(text);
    if (!validBaseline(baseline)) {
      throw new Error("Invalid original baseline");
    }
    return baseline;
  } finally {
    closeSync(fd);
  }
}
