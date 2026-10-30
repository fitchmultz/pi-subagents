import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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
import {
  attachmentSchema,
  parkedSchema,
  processSchema,
  type Launch,
  type ProcessIdentity,
} from "./contracts.ts";
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
/**
 * A child's routine parent check, one observation at a time. A dead parent detaches the child
 * only while its check is current and the attachment generation is unchanged: a newer parent
 * may adopt the child meanwhile.
 */
export class ParentCheck {
  private current?: object;
  /**
   * Reads the attachment synchronously, so an unreadable one still fails the caller at once.
   * Missing or released attachments detach immediately; a check in flight makes this a no-op.
   */
  check(file: string, detached: () => void): Promise<void> {
    if (this.current !== undefined) {
      return Promise.resolve();
    }
    const attachment = published(file, read(file, attachmentSchema));
    if (attachment === undefined || !attachment.attached) {
      detached();
      return Promise.resolve();
    }
    const check = {};
    this.current = check;
    const settle = async () => {
      try {
        const [live] = await observeAlive([attachment]);
        if (
          this.current === check &&
          !live &&
          read(file, attachmentSchema)?.generation === attachment.generation
        ) {
          detached();
        }
      } finally {
        if (this.current === check) {
          this.current = undefined;
        }
      }
    };
    return settle();
  }
  /** A check settling later no longer acts. */
  cancel(): void {
    this.current = undefined;
  }
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
interface LaunchClaim {
  readonly spawned: () => void;
  readonly release: () => void;
}
function saveSpawnFailure(dir: string, error: Error): Error {
  try {
    write(path.join(dir, "spawn-error.json"), { error: error.message });
    return error;
  } catch (failure) {
    return Object.assign(
      new Error(`${error.message}; could not save the spawn diagnostic: ${errorText(failure)}`, {
        cause: error,
      }),
      "code" in error ? { code: error.code } : {},
    );
  }
}
async function spawnActor(
  base: string,
  launch: Launch,
  token: string,
  claim: LaunchClaim,
): Promise<void> {
  const dir = conversation(base, launch);
  let child: ChildProcess;
  let spawnError: Promise<Error> | undefined;
  try {
    const log = fs.openSync(path.join(dir, "runner.log"), "a", 0o600);
    try {
      const runner = fileURLToPath(
        new URL(import.meta.url.endsWith(".ts") ? "./runner.ts" : "./runner.js", import.meta.url),
      );
      child = spawn(process.execPath, [runner, base, launch.rootId, token, launch.id], {
        cwd: launch.cwd,
        env: childEnvironment(launch),
        detached: true,
        stdio: ["ignore", log, log],
      });
      if (child.pid === undefined) {
        spawnError = new Promise((resolve) => {
          child.once("error", (error) => resolve(saveSpawnFailure(dir, error)));
        });
        claim.release();
      } else {
        claim.spawned();
        child.on("error", (error) => {
          write(path.join(dir, "spawn-error.json"), { error: error.message });
        });
      }
    } finally {
      fs.closeSync(log);
    }
  } catch (error) {
    claim.release();
    throw error;
  }
  if (child.pid === undefined && spawnError) {
    throw await spawnError;
  }
  if (child.pid === undefined) {
    claim.spawned();
    throw new Error("Actor spawn outcome is ambiguous.");
  }
  child.on("exit", (code, signal) => {
    write(path.join(dir, `exit-${token}.json`), { pid: child.pid, code, signal, at: Date.now() });
    trySignalChildTree(child, "SIGKILL");
  });
  child.unref();
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
  if (existing) {
    const stopping = path.join(dir, `stopping-${existing.token}.json`);
    // Parking ends in exit or a removed marker, after native shutdown persistence.
    const parking = path.join(dir, "actor.lock", "parking.json");
    const deadline = Date.now() + (fs.existsSync(stopping) ? 5000 : 30_000);
    while ((fs.existsSync(stopping) || fs.existsSync(parking)) && alive(existing)) {
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
function releaseClaim(
  lock: string,
  identity: fs.Stats | undefined,
  token: string | undefined,
): void {
  try {
    const current = fs.lstatSync(lock, { throwIfNoEntry: false });
    if (current && identity && current.dev === identity.dev && current.ino === identity.ino) {
      const file = path.join(lock, "claim.json");
      const claim = read(file, processSchema);
      if (claim === undefined || claim.token === token) {
        fs.rmSync(file, { force: true });
        fs.rmdirSync(lock);
      }
    }
  } catch {
    // Keep the original failure; an unremovable claim remains safely ambiguous.
  }
}
async function launchClaimedActor(base: string, launch: Launch, lock: string): Promise<void> {
  let identity: fs.Stats | undefined;
  let token: string | undefined;
  let state: "claimed" | "spawned" | "released" = "claimed";
  const claim: LaunchClaim = {
    spawned: () => {
      state = "spawned";
    },
    release: () => {
      if (state === "claimed") {
        state = "released";
        releaseClaim(lock, identity, token);
      }
    },
  };
  try {
    identity = fs.lstatSync(lock);
    token = randomUUID();
    write(path.join(lock, "claim.json"), { ...ownIdentity(), token });
    await spawnActor(base, launch, token, claim);
  } catch (error) {
    claim.release();
    throw error;
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
  parkFailure(base, launch, existing);
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
  await launchClaimedActor(base, launch, lock);
}
/** A failed park keeps its input queued; exact state is lost, so nothing restarts it implicitly. */
export function parkFailure(base: string, launch: Launch, exited?: OwnedProcess): void {
  const dir = conversation(base, launch);
  const parked = read(path.join(dir, "parked.json"), parkedSchema);
  if (exited && parked && parked.token !== exited.token) {
    // Only the exited claim that saved this state may hand it to the next generation.
    throw new Error(
      "Parked working state belongs to another actor generation; nothing was reopened.",
    );
  }
  const file = path.join(dir, "park-failed.json");
  if (fs.existsSync(file)) {
    throw new Error(
      `This idle child exited without saving its exact working state (${file}). Nothing was restarted or admitted; messages for it stay queued. Inspect it, then delegate new work.`,
    );
  }
}
/** A broker wake may only restore exact parked state, never reopen the journal alone. */
export async function wakeActor(base: string, launch: Launch, signal?: AbortSignal): Promise<void> {
  const dir = conversation(base, launch);
  await awaitStopping(dir, actor(base, launch), signal);
  parkFailure(base, launch);
  if (!fs.existsSync(path.join(dir, "parked.json"))) {
    throw new Error("No parked working state; the child was not woken.");
  }
  await ensureActor(base, launch, signal);
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
export function shell(file: string, token: string): OwnedProcess | undefined {
  const identity = published(file, read(file, processSchema));
  if (identity && identity.token !== token) {
    throw new Error("Foreign or missing native shell identity.");
  }
  return identity;
}
export function shells(
  base: string,
  launch: Launch,
  token: string,
): (OwnedProcess & { readonly file: string })[] {
  const dir = path.join(conversation(base, launch), "shells", token);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(dir, name);
      const identity = shell(file, token);
      if (!identity) {
        throw new Error("Foreign or missing native shell identity.");
      }
      return Object.assign(identity, { file });
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
