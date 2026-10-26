import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  isChildProcessReplaced,
  observeChildProcessReplaced,
  readChildProcessIdentity,
  readProcessClock,
  trySignalChildTree,
} from "../shared/post-exit-stdio-guard.ts";
import { agentObservationSocketPath } from "../pi-intercom/broker/paths.ts";
import { hasErrorCode } from "../shared/unknown.ts";
import { processSchema, type Launch, type ProcessIdentity } from "./contracts.ts";
import { conversation, enqueue, launchAt, list, read, write } from "./storage.ts";
import { errorText } from "./host.ts";

/** Darwin's in-memory publication bound; Android records carry their own native clock. */
interface Published {
  readonly published?: number | undefined;
}
type OwnedProcess = ProcessIdentity & Published;
type ClaimedProcess = Pick<ProcessIdentity, "pid" | "identity" | "clock"> & Published;
/** Owner records follow their process's birth; stat after read only moves the bound later. */
export function published<T extends object>(
  file: string,
  record: T | undefined,
): (T & Published) | undefined {
  return record && { ...record, published: fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs };
}
/** Settles liveness without a birth lookup; undefined means compare the recorded birth. */
function probe(identity: ClaimedProcess): boolean | undefined {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    // EPERM still names a live PID, possibly another user's reuse; check its birth below.
    if (!hasErrorCode(error, "EPERM")) {
      return !hasErrorCode(error, "ESRCH");
    }
  }
  return identity.identity === "unverified" ? true : undefined;
}
export function alive(identity: ClaimedProcess): boolean {
  // Only a proven different birth disproves a live PID; ambiguous identities stay possibly owned.
  return (
    probe(identity) ??
    (readChildProcessIdentity(identity.pid) === identity.identity || !replaced(identity))
  );
}
/** Routine `alive` without waiting on `ps`; signals still use the synchronous proof. */
export async function observeAlive(identities: readonly ClaimedProcess[]): Promise<boolean[]> {
  const verdicts: boolean[] = [];
  for (const claim of identities) {
    // One `ps` at a time: each spawn briefly holds the event loop, so concurrent spawns add up.
    const { pid, identity, clock } = claim;
    verdicts.push(
      probe(claim) ??
        // oxlint-disable-next-line no-await-in-loop
        !(await observeChildProcessReplaced(pid, identity, claim.published, clock)),
    );
  }
  return verdicts;
}
function replaced(identity: ClaimedProcess): boolean {
  return (
    identity.identity !== "unverified" &&
    isChildProcessReplaced(identity.pid, identity.identity, identity.published, identity.clock)
  );
}
export function ownIdentity(pid = process.pid): Omit<ProcessIdentity, "token"> {
  // An ordinary main or managed launcher need not be a group leader. Ambiguous live PIDs fail closed.
  return {
    pid,
    identity: readChildProcessIdentity(pid) ?? "unverified",
    clock: readProcessClock(),
  };
}
export function actor(base: string, launch: Launch): OwnedProcess | undefined {
  const file = path.join(conversation(base, launch), "actor.lock", "process.json");
  return published(file, read(file, processSchema));
}
function childEnvironment(launch: Launch): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("PI_SUBAGENT_") ||
      ["PI_SESSION_FILE", "PI_SESSION_ID", "PI_INTERCOM_SESSION_NAME"].includes(key)
    ) {
      delete env[key];
    }
  }
  return Object.assign(env, {
    PI_PACKAGE_DIR: launch.sdk,
    PI_CODING_AGENT_DIR: launch.agentDir,
    PI_INTERCOM_ROOT_SESSION_ID: launch.owner,
    PI_INTERCOM_PARENT_SESSION_ID: launch.owner,
  });
}
function spawnActor(base: string, launch: Launch, token: string): void {
  const dir = conversation(base, launch);
  const log = fs.openSync(path.join(dir, "runner.log"), "a", 0o600);
  const runner = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./runner.ts" : "./runner.js", import.meta.url),
  );
  let child;
  try {
    child = spawn(process.execPath, [runner, base, launch.rootId, token, launch.id], {
      cwd: launch.cwd,
      env: childEnvironment(launch),
      detached: true,
      stdio: ["ignore", log, log],
    });
  } finally {
    fs.closeSync(log);
  }
  child.on("error", (error) => {
    write(path.join(dir, "spawn-error.json"), { error: error.message });
  });
  child.on("exit", (code, signal) => {
    write(path.join(dir, `exit-${token}.json`), { pid: child.pid, code, signal, at: Date.now() });
    trySignalChildTree(child, "SIGKILL");
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error("Actor was not spawned; retained launch claim requires inspection.");
  }
  write(path.join(dir, "actor.lock", "process.json"), {
    pid: child.pid,
    identity: readChildProcessIdentity(child.pid) ?? "unverified",
    token,
    clock: readProcessClock(),
  });
}
async function awaitStopping(
  dir: string,
  existing: OwnedProcess | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (existing && fs.existsSync(path.join(dir, `stopping-${existing.token}.json`))) {
    const deadline = Date.now() + 5000;
    while (alive(existing)) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) {
        throw new Error("Previous actor is still stopping; no replacement was launched.");
      }
      // The old actor must actually exit before replacing its generation.
      // oxlint-disable-next-line no-await-in-loop
      await delay(25);
    }
  }
}
export async function ensureActor(
  base: string,
  launch: Launch,
  signal?: AbortSignal,
): Promise<void> {
  const dir = conversation(base, launch);
  const lock = path.join(dir, "actor.lock");
  await awaitStopping(dir, actor(base, launch), signal);
  signal?.throwIfAborted();
  // Another parallel tool may replace the claim while this invocation yields.
  const existing = actor(base, launch);
  if (existing && alive(existing)) {
    return;
  }
  if (existing) {
    if (shells(base, launch, existing.token).some(alive)) {
      throw new Error("Owned native shell work remains live; stop it before continuing.");
    }
    removeObservationEndpoint(existing.token);
    fs.rmSync(lock, { recursive: true });
  }
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Actor launch is ambiguous; retained claim prevents duplicate launch.", {
        cause: error,
      });
    }
    throw error;
  }
  const token = randomUUID();
  write(path.join(lock, "claim.json"), { ...ownIdentity(), token });
  spawnActor(base, launch, token);
}
/** A crashed generation cannot unlink its endpoint; its exact token names the leftover. */
function removeObservationEndpoint(token: string): void {
  try {
    const socketPath = agentObservationSocketPath(token);
    if (fs.lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket() === true) {
      fs.rmSync(socketPath, { force: true });
    }
  } catch {
    // Observation leftovers are inert to a new token and must never block native work.
  }
}
function verifyLiveness(identity: OwnedProcess): boolean {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    // Another user's live PID is released only by the same proof as a signalable one.
    if (hasErrorCode(error, "ESRCH") || (hasErrorCode(error, "EPERM") && replaced(identity))) {
      return false;
    }
    throw new Error("Actor liveness is ambiguous; no stop was sent.", { cause: error });
  }
  return true;
}
export function verifyProcess(identity: OwnedProcess): boolean {
  if (!verifyLiveness(identity)) {
    return false;
  }
  const actual = readChildProcessIdentity(identity.pid);
  if (identity.identity !== "unverified" && actual !== identity.identity) {
    if (actual === undefined && !verifyLiveness(identity)) {
      // Native abort can reap a shell between the liveness probe and birth lookup.
      return false;
    }
    // A different-birth process at the PID proves the recorded process is gone.
    if (replaced(identity)) {
      return false;
    }
  }
  if (identity.identity === "unverified" || actual !== identity.identity) {
    throw new Error("Cannot verify actor process identity; no signal sent.");
  }
  return true;
}
export function signalProcess(identity: OwnedProcess, signal: NodeJS.Signals): boolean {
  if (!verifyProcess(identity)) {
    return false;
  }
  return trySignalChildTree(
    { pid: identity.pid, kill: (s) => process.kill(identity.pid, s) },
    signal,
  );
}
export function requestStop(
  base: string,
  launch: Launch,
  onError?: (error: unknown) => void,
): { targets: OwnedProcess[]; command: string | undefined } {
  const attempt = (operation: () => boolean): boolean => {
    try {
      return operation();
    } catch (error) {
      if (onError === undefined) {
        throw error;
      }
      onError(error);
      return false;
    }
  };
  const identity = actor(base, launch);
  const targets = identity ? [identity, ...shells(base, launch, identity.token)] : [];
  // Interactive Stop validates the whole set; shutdown reports and skips only ambiguous targets.
  const live = targets.filter((target) => attempt(() => verifyProcess(target)));
  const command =
    identity && live.includes(identity)
      ? enqueue(base, launch, "stop", { actorToken: identity.token })
      : undefined;
  if (identity && live.length > 0) {
    write(path.join(conversation(base, launch), `stopping-${identity.token}.json`), {
      at: Date.now(),
    });
  }
  live.forEach((target) => {
    attempt(() => signalProcess(target, "SIGTERM"));
  });
  return { targets: live, command };
}
export async function stopChildren(base: string, owner: string): Promise<void> {
  const roots = new Set<string>();
  const targets: OwnedProcess[] = [];
  for (const id of list(base)) {
    try {
      const launch = launchAt(base, id, owner);
      if (!roots.has(launch.rootId)) {
        roots.add(launch.rootId);
        targets.push(
          ...requestStop(base, launch, (error) => {
            console.error(`Child shutdown ${id}: ${errorText(error)}`);
          }).targets,
        );
      }
    } catch (error) {
      console.error(`Child shutdown ${id}: ${errorText(error)}`);
    }
  }
  await waitForExit(targets, 3000);
  for (const target of targets) {
    try {
      signalProcess(target, "SIGKILL");
    } catch (error) {
      console.error(`Child shutdown ${target.pid}: ${errorText(error)}`);
    }
  }
  await waitForExit(targets, 1000);
  if (targets.some(alive)) {
    console.error("Child shutdown could not confirm every owned process exit.");
  }
}
async function waitForExit(targets: readonly OwnedProcess[], timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && targets.some(alive)) {
    // Join actual process exit while native abort persists the interrupted turn.
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
}
export function shells(base: string, launch: Launch, token: string): OwnedProcess[] {
  const dir = path.join(conversation(base, launch), "shells", token);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(dir, name);
      const identity = published(file, read(file, processSchema));
      if (!identity || identity.token !== token) {
        throw new Error("Foreign or missing native shell identity.");
      }
      return identity;
    });
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function shellCommand(command: string, directory: string, token: string): string {
  const helper = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./shell.ts" : "./shell.js", import.meta.url),
  );
  const register = [process.execPath, helper, directory, token].map(quote).join(" ");
  return `if ! ${register} "$$"; then exit 125; fi\n${command}`;
}
