import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readChildProcessIdentity, trySignalChildTree } from "../shared/post-exit-stdio-guard.ts";
import { processSchema, type Launch, type ProcessIdentity } from "./contracts.ts";
import { conversation, enqueue, read, write } from "./storage.ts";

export function alive(identity: Pick<ProcessIdentity, "pid" | "identity">): boolean {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
  if (identity.identity === "unverified") {
    return true;
  }
  const actual = readChildProcessIdentity(identity.pid);
  return actual === undefined || actual === identity.identity;
}
export function ownIdentity(): { pid: number; identity: string } {
  // An ordinary main need not be a group leader. Ambiguous live PIDs fail closed.
  return { pid: process.pid, identity: readChildProcessIdentity(process.pid) ?? "unverified" };
}
export function actor(base: string, launch: Launch): ProcessIdentity | undefined {
  return read(path.join(conversation(base, launch), "actor.lock", "process.json"), processSchema);
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
  });
}
async function awaitStopping(
  dir: string,
  existing: ProcessIdentity | undefined,
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
function verifyLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw new Error("Actor liveness is ambiguous; no stop was sent.", { cause: error });
  }
  return true;
}
export function verifyProcess(identity: ProcessIdentity): boolean {
  if (!verifyLiveness(identity.pid)) {
    return false;
  }
  const actual = readChildProcessIdentity(identity.pid);
  if (identity.identity !== "unverified" && actual === undefined && !verifyLiveness(identity.pid)) {
    // Native abort can reap a shell between the liveness probe and birth lookup.
    return false;
  }
  if (identity.identity === "unverified" || actual !== identity.identity) {
    throw new Error("Cannot verify actor process identity; no signal sent.");
  }
  return true;
}
export function signalProcess(identity: ProcessIdentity, signal: NodeJS.Signals): boolean {
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
): { targets: ProcessIdentity[]; command: string | undefined } {
  const identity = actor(base, launch);
  const targets = identity ? [identity, ...shells(base, launch, identity.token)] : [];
  // Validate the whole owned set before admitting Stop or signaling any member.
  const live = targets.filter(verifyProcess);
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
    signalProcess(target, "SIGTERM");
  });
  return { targets: live, command };
}
export function shells(base: string, launch: Launch, token: string): ProcessIdentity[] {
  const dir = path.join(conversation(base, launch), "shells", token);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).map((name) => {
    const identity = read(path.join(dir, name), processSchema);
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
