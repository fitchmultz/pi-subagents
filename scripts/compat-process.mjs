import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GuardianCommand } from "./compat-process-launch.mjs";
import {
  BASELINE_HASH,
  GUARDIAN_DIRECTORY,
  GUARDIAN_PID,
  GUARDIAN_ROOT,
  OWNER,
  captureBaseline,
  nativeIdentity,
  processSnapshot,
  sameBirth,
} from "./compat-process-observation.mjs";
import {
  admittedGuardian,
  currentGuardian,
  guardianSettled,
  publishBaseline,
  publishGuardianReceipt,
  readBaseline,
  readGuardianReceipt,
  serializeBaseline,
} from "./compat-process-receipt.mjs";

const MINUTE = 60_000;
const CLEANUP_MS = 10_000;
// Cold quality, build/package/install smokes and the unchanged suite watchdogs
// run sequentially. The settlement minute covers suite and npm owner cleanup.
export const CI_TIMEOUT_MS = (15 + 5 + 5 + 15 + 1) * MINUTE;
export const COMPAT_TIMEOUT_MS = (5 + 5 + 1 + 5 + 1) * MINUTE + CI_TIMEOUT_MS;

function observationFailure(entries) {
  return new Error(entries.map((entry) => entry.message).join("; "));
}
function queryFailure(previous, error, deadline) {
  // Query-budget truncation must not hide the last concrete veto.
  const truncated = error.cause?.code === "ETIMEDOUT" || Date.now() >= deadline;
  return previous && truncated ? previous : error;
}
async function withinDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Guardian settlement exceeded cleanup deadline")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function birthKey(entry) {
  return `${entry.pid}:${entry.uid}:${entry.sid}:${entry.identity}`;
}
// CI's pinned synchronous helpers must run inside a genuine live enclosure.
// The marker only locates it; native UID/birth/SID and exact OWNER authenticate it.
export function currentEnclosure(env = process.env) {
  const deadline = Date.now() + 3000;
  const caller = nativeIdentity(process.pid, deadline);
  const pid = Number(env[GUARDIAN_PID] ?? process.pid);
  if (!caller || caller.sid !== pid) {
    return;
  }
  const tokens = (env[OWNER] ?? "").split(",").filter(Boolean);
  const snapshot = processSnapshot(tokens, pid, deadline);
  if (snapshot.uncertainties.length !== 0) {
    throw observationFailure(snapshot.uncertainties);
  }
  const receipt = snapshot.processes.find((entry) => entry.pid === pid);
  const entry = snapshot.identities.find((value) => value.pid === pid);
  if (!receipt?.directory || !entry) {
    return;
  }
  return admittedGuardian(entry, receipt.directory, tokens, receipt);
}

// Environment receipts cover escaped setsid descendants. A live, birth-bound
// session guardian also covers ordinary Apple children whose env is concealed.
// ponytail: intentional setsid + erased OWNER escapes both OS capabilities;
// adversarial containment would require an OS sandbox, not PID/argv guessing.
export class OwnedProcesses {
  #token;
  #environment;
  #known = new Map();
  #enclosures = new Map();
  #commands = new Map();
  #borrowed = new Set();
  #receiptRoot;
  #ownsRoot = false;
  #baseline;
  #serializedBaseline;
  constructor(env = process.env, token = randomUUID()) {
    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token) ||
      (arguments.length > 1 && !(env[OWNER] ?? "").split(",").includes(token))
    ) {
      throw new Error("Guardian rescue requires an actual inherited UUID owner receipt");
    }
    this.#token = token;
    const owners = new Set(
      [process.env[OWNER], env[OWNER], token].flatMap((value) => value?.split(",") ?? []),
    );
    this.#environment = { ...env, [OWNER]: [...owners].join(",") };
    // Nested owners share the outermost receipt lifetime: an inner release
    // must not erase the proof an enclosing owner needs after disappearance.
    this.#receiptRoot = env[GUARDIAN_ROOT] ?? process.env[GUARDIAN_ROOT];
    // Capture before environment exposure. Rescue instead imports the original
    // cut through inherit(), never a fresh post-escape baseline.
    if (process.platform === "darwin" && arguments.length < 2) {
      this.#setBaseline(captureBaseline());
    }
  }
  #setBaseline(baseline) {
    this.#serializedBaseline = serializeBaseline(baseline);
    this.#baseline = baseline;
  }
  get environment() {
    return this.#environment;
  }
  inherit() {
    const guardian = currentEnclosure();
    if (!guardian) {
      throw new Error("Inherited compatibility root requires a live authenticated guardian");
    }
    if (process.platform === "darwin") {
      if (guardian.pid === process.pid && process.env[BASELINE_HASH] !== guardian.baselineHash) {
        throw new Error("Guardian original baseline digest changed");
      }
      this.#setBaseline(readBaseline(guardian.directory, guardian.baselineHash));
      if (this.#serializedBaseline.hash !== guardian.baselineHash) {
        throw new Error("Original baseline does not round-trip");
      }
    }
    this.#enclosures.set(guardian.pid, guardian);
    this.#borrowed.add(guardian.pid);
    process.env[OWNER] = this.#environment[OWNER];
  }
  #guardianEnvironment() {
    if (!this.#receiptRoot) {
      this.#receiptRoot = mkdtempSync(join(tmpdir(), "pi-compat-guardians-"));
      this.#ownsRoot = true;
    }
    const directory = join(this.#receiptRoot, randomUUID());
    mkdirSync(directory, { mode: 0o700 });
    const environment = {
      ...this.#environment,
      [GUARDIAN_ROOT]: this.#receiptRoot,
      [GUARDIAN_DIRECTORY]: directory,
    };
    if (this.#serializedBaseline) {
      publishBaseline(directory, this.#serializedBaseline);
      environment[BASELINE_HASH] = this.#serializedBaseline.hash;
    }
    return environment;
  }
  #admit(pid, directory) {
    const snapshot = processSnapshot(this.#token, pid, Date.now() + 3000);
    if (snapshot.uncertainties.length !== 0) {
      throw observationFailure(snapshot.uncertainties);
    }
    const entry = snapshot.identities.find((value) => value.pid === pid);
    const receipt = snapshot.processes.find((value) => value.pid === pid);
    if (!entry) {
      throw new Error("Compatibility guardian disappeared before native admission");
    }
    if (entry.uid !== process.getuid() || entry.exited || entry.sid !== pid || entry.pgid !== pid) {
      throw new Error("Compatibility guardian is not a live native private session leader");
    }
    publishGuardianReceipt(directory, {
      pid,
      uid: entry.uid,
      sid: entry.sid,
      identity: entry.identity,
      owners: this.#environment[OWNER].split(","),
      capability: directory.split("/").at(-1),
      state: "ready",
      rescuing: false,
      ...(this.#serializedBaseline ? { baselineHash: this.#serializedBaseline.hash } : {}),
    });
    this.#enclosures.set(pid, admittedGuardian(entry, directory, [this.#token], receipt));
  }
  #remember(snapshot) {
    for (const receipt of snapshot.processes) {
      this.#known.set(receipt.pid, receipt.identity);
      if (!receipt.directory) {
        continue;
      }
      const guardian = currentGuardian(receipt, snapshot, [this.#token]);
      if (!guardian) {
        continue;
      }
      this.#enclosures.set(guardian.pid, guardian);
    }
  }
  #sessionMembers(snapshot) {
    const processes = [];
    const uncertainties = [];
    const live = new Set();
    for (const [pid, guardian] of this.#enclosures) {
      const entry = snapshot.identities.find((value) => value.pid === pid);
      if (!sameBirth(entry, guardian.identity) || entry.exited || entry.sid !== pid) {
        if (guardianSettled(guardian)) {
          this.#enclosures.delete(pid);
          continue;
        }
        uncertainties.push({ message: `Compatibility guardian ${pid} lost without settled proof` });
        continue;
      }
      live.add(pid);
      for (const member of snapshot.identities.filter(
        (value) => value.sid === pid && !value.exited,
      )) {
        if (member.uid !== process.getuid()) {
          uncertainties.push({ message: `Owned session member ${member.pid} changed UID` });
        } else {
          this.#known.set(member.pid, member.identity);
          processes.push({ pid: member.pid, identity: member.identity });
        }
      }
    }
    return { processes, uncertainties, live };
  }
  #pendingEnclosures(snapshot, live) {
    const deferred = new Set();
    let pendingGuardians = false;
    for (const pid of live) {
      if (this.#commands.has(pid) || this.#borrowed.has(pid)) {
        continue;
      }
      // Re-authenticate the current native guardian and freshly read its phase.
      // A stale ready snapshot cannot authorize killing a later rescue query.
      const guardian = currentGuardian(
        snapshot.processes.find((receipt) => receipt.pid === pid),
        snapshot,
        [this.#token],
      );
      if (!guardian) {
        throw new Error(`Cannot authenticate current compatibility guardian ${pid} phase`);
      }
      pendingGuardians = true;
      if (guardian.rescuing) {
        deferred.add(pid);
      }
    }
    return { deferred, pendingGuardians };
  }
  #knownMembers(snapshot, deadline) {
    const processes = [];
    for (const [pid, identity] of this.#known) {
      const entry =
        snapshot.identities.find((value) => value.pid === pid) ?? nativeIdentity(pid, deadline);
      if (!entry || entry.identity !== identity || entry.exited) {
        this.#known.delete(pid);
      } else if (entry.uid !== process.getuid()) {
        throw new Error(`Owned process ${pid} changed UID`);
      } else {
        processes.push({ pid, identity });
      }
    }
    return processes;
  }
  #receiptUncertainties(snapshot) {
    if (!this.#receiptRoot) {
      return [];
    }
    const uncertainties = [];
    for (const name of readdirSync(this.#receiptRoot)) {
      const receipt = readGuardianReceipt(join(this.#receiptRoot, name));
      if (!receipt.owners.includes(this.#token) || receipt.state === "settled") {
        continue;
      }
      const entry = snapshot.identities.find((value) => value.pid === receipt.pid);
      if (!sameBirth(entry, receipt.identity) || entry.exited) {
        // Filesystem state can veto deletion, never authorize a PID signal.
        // Also detects an inner guardian lost before the outer's first scan.
        uncertainties.push({
          message: `Unsettled compatibility guardian ${receipt.pid} disappeared`,
        });
      }
    }
    return uncertainties;
  }
  // Exact pre-cut instances and still-reserved foreign sessions are negative
  // evidence only. The caller SID can receive explicit owner.environment
  // children, so it never grants a broad exemption. Opaque work is not killed.
  // ponytail: anchored foreign namespaces remain the service boundary, including
  // explicit OWNER transfer into them. Universal containment needs an OS sandbox.
  #unanchoredOpaque(snapshot, receipts) {
    if (!this.#baseline) {
      return [];
    }
    const live = new Set(snapshot.identities.filter((entry) => !entry.exited).map(birthKey));
    const exact = new Set();
    const sessions = new Set();
    for (const member of this.#baseline.members) {
      if (live.has(birthKey(member))) {
        exact.add(`${member.pid}:${member.identity}`);
        if (member.sid !== this.#baseline.callerSid) {
          sessions.add(member.sid);
        }
      }
    }
    return snapshot.opaque
      .filter(
        (entry) =>
          entry.pid !== process.pid &&
          !exact.has(`${entry.pid}:${entry.identity}`) &&
          !sessions.has(entry.sid) &&
          !receipts.some(
            (receipt) => receipt.pid === entry.pid && receipt.identity === entry.identity,
          ),
      )
      .map((entry) => ({
        pid: entry.pid,
        identity: entry.identity,
        sid: entry.sid,
        message: `Unanchored opaque native process ${entry.pid} in session ${entry.sid}; ownership unknown`,
      }));
  }
  #observe(deadline) {
    const snapshot = processSnapshot(this.#token, undefined, deadline);
    this.#remember(snapshot);
    const sessions = this.#sessionMembers(snapshot);
    const pending = this.#pendingEnclosures(snapshot, sessions.live);
    const deferred = new Set(
      snapshot.identities
        .filter((entry) => !entry.exited && pending.deferred.has(entry.sid))
        .map((entry) => `${entry.pid}:${entry.identity}`),
    );
    const receipts = [
      ...snapshot.processes,
      ...sessions.processes,
      ...this.#knownMembers(snapshot, deadline),
    ];
    const uncertainties = snapshot.uncertainties.filter(
      (entry) =>
        !receipts.some(
          (receipt) => receipt.pid === entry.pid && receipt.identity === entry.identity,
        ),
    );
    const processes = receipts.filter(
      (entry) =>
        entry.pid !== process.pid &&
        !this.#enclosures.has(entry.pid) &&
        !deferred.has(`${entry.pid}:${entry.identity}`),
    );
    for (const command of this.#commands.values()) {
      if (command.lost) {
        uncertainties.push({ message: command.lost.message });
      }
    }
    return {
      processes: [...new Map(processes.map((entry) => [entry.pid, entry])).values()],
      uncertainties: [
        ...uncertainties,
        ...this.#unanchoredOpaque(snapshot, receipts),
        ...sessions.uncertainties,
        ...this.#receiptUncertainties(snapshot),
      ],
      pendingGuardians: pending.pendingGuardians,
    };
  }
  #signal(entry, signal, deadline) {
    const observed = nativeIdentity(entry.pid, deadline);
    if (!sameBirth(observed, entry.identity) || observed.exited) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Owned-process cleanup observation exceeded its deadline");
    }
    try {
      process.kill(entry.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  execute(command, args, options, signal) {
    const env = this.#guardianEnvironment();
    const guardian = new GuardianCommand(env, options);
    this.#commands.set(guardian.pid, guardian);
    return guardian.execute({ command, args, options }, signal, (pid) =>
      this.#admit(pid, env[GUARDIAN_DIRECTORY]),
    );
  }
  #removeReceipts() {
    if (!this.#ownsRoot) {
      return;
    }
    for (const name of readdirSync(this.#receiptRoot)) {
      const directory = join(this.#receiptRoot, name);
      const receipt = readGuardianReceipt(directory);
      if (receipt.state !== "settled" || !receipt.owners.includes(this.#token)) {
        throw new Error("Unsettled guardian receipt; retain private roots for diagnosis");
      }
      rmSync(directory, { recursive: true });
    }
    rmdirSync(this.#receiptRoot);
    this.#receiptRoot = undefined;
    this.#ownsRoot = false;
  }
  async #release(deadline) {
    await withinDeadline(
      Promise.all([...this.#commands.values()].map((command) => command.release())),
      deadline,
    );
    for (const guardian of this.#enclosures.values()) {
      if (this.#commands.has(guardian.pid) && !guardianSettled(guardian)) {
        throw new Error("Guardian exited without settled receipt");
      }
    }
    this.#commands.clear();
    this.#enclosures.clear();
    this.#removeReceipts();
  }
  async stop() {
    const started = Date.now();
    const deadline = started + CLEANUP_MS;
    try {
      await this.#quiesce(started, deadline);
      await this.#release(deadline);
    } catch (error) {
      for (const command of this.#commands.values()) {
        command.abandon();
      }
      throw error;
    }
  }
  async #quiesce(started, deadline) {
    // Acknowledgment precedes observation: queued config must never launch work
    // after an apparently empty snapshot during timeout/startup cancellation.
    await withinDeadline(
      Promise.all([...this.#commands.values()].map((command) => command.cancel())),
      deadline,
    );
    let empty = false;
    let observationError;
    while (Date.now() < deadline) {
      try {
        const snapshot = this.#observe(deadline);
        const quiescent =
          snapshot.processes.length === 0 &&
          snapshot.uncertainties.length === 0 &&
          !snapshot.pendingGuardians;
        if (quiescent && empty) {
          return;
        }
        empty = quiescent;
        if (snapshot.uncertainties.length !== 0) {
          observationError = observationFailure(snapshot.uncertainties);
        }
        for (const entry of snapshot.processes) {
          this.#signal(entry, Date.now() - started < 3000 ? "SIGTERM" : "SIGKILL", deadline);
        }
      } catch (error) {
        empty = false;
        observationError = queryFailure(observationError, error, deadline);
      }
      // Observe late forks and actual quiescence; errors never prove absence.
      // oxlint-disable-next-line no-await-in-loop
      await delay(50);
    }
    throw new Error("Owned processes did not quiesce; retain private roots for diagnosis", {
      cause: observationError,
    });
  }
}
function commandFailure(command, args, code, signal) {
  const error = new Error(`${command} ${args.join(" ")} failed (${code ?? signal})`);
  error.status = code;
  error.signal = signal;
  return error;
}
export async function run(command, args, options = {}) {
  const processes = new OwnedProcesses(options.env);
  const cancellation = new AbortController();
  let failure;
  let output;
  const cancel = (signal) => {
    failure ??= commandFailure(command, args, null, signal);
    cancellation.abort(failure);
  };
  const interrupt = () => {
    cancel("SIGINT");
  };
  const terminate = () => {
    cancel("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    try {
      output = await processes.execute(command, args, options, cancellation.signal);
    } catch (error) {
      failure ??= error;
    }
    try {
      await processes.stop();
    } catch (error) {
      error.cleanupFailed = true;
      if (failure) {
        failure.cleanupFailed = true;
        console.error("Owned-process cleanup failed; original command failure retained:", error);
      } else {
        failure = error;
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  if (failure) {
    throw failure;
  }
  return output.stdout;
}
