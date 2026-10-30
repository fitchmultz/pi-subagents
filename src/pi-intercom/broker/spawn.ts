import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import net from "net";
import { getPiAgentDir } from "../agent-dir.ts";
import {
  getBrokerRuntimeDir,
  getBrokerSocketPath,
  getPreviousBrokerSocketPaths,
  isOwnedBrokerSocket,
  prepareBrokerSocketPath,
} from "./paths.ts";
import { isBrokerPidReused } from "./pid.ts";
import { errorMessage, hasErrorCode } from "../../shared/unknown.ts";

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BROKER_PID = join(getBrokerRuntimeDir(), "broker.pid");
const BROKER_SPAWN_LOCK = join(getBrokerRuntimeDir(), "broker.spawn.lock");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function usesLegacyTsxDefault(brokerCommand: string, brokerArgs: readonly string[]): boolean {
  return (
    brokerCommand === "npx" &&
    brokerArgs.length === 2 &&
    brokerArgs[0] === "--no-install" &&
    brokerArgs[1] === "tsx"
  );
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  brokerCommand: string,
  brokerArgs: readonly string[],
): { command: string; args: string[] } {
  if (usesLegacyTsxDefault(brokerCommand, brokerArgs)) {
    return {
      command: process.execPath,
      args: [brokerPath],
    };
  }

  return {
    command: brokerCommand,
    args: [...brokerArgs, brokerPath],
  };
}

export function getBrokerSpawnOptions(): {
  detached: true;
  stdio: "ignore";
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    detached: true,
    stdio: "ignore",
    cwd: EXTENSION_DIR,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

export async function spawnBrokerIfNeeded(
  brokerCommand: string,
  brokerArgs: readonly string[],
  warning: (message?: string) => void = (message) => {
    if (message !== undefined) {
      console.warn(message);
    }
  },
): Promise<void> {
  prepareBrokerSocketPath();
  warning(await previousBrokerWarning());

  if (await isBrokerRunning()) {
    return;
  }

  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) {
      return;
    }
    await stopUnhealthyBrokerBeforeSpawn();

    const brokerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      import.meta.url.endsWith(".ts") ? "broker.ts" : "broker.js",
    );
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    const child = spawn(launch.command, launch.args, getBrokerSpawnOptions());
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };

      const onError = (error: Readonly<Error>) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error.message}`, { cause: error }));
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        if (signal !== null) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };

      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker()
        .then(() => {
          cleanup();
          resolve();
        })
        .catch((error: unknown) => {
          cleanup();
          reject(toError(error));
        });
    });
  } finally {
    releaseSpawnLock();
  }
}

export async function isBrokerRunning(): Promise<boolean> {
  return checkSocketConnectable();
}

export async function assertBrokerCanStart(): Promise<void> {
  if (await isBrokerRunning()) {
    throw new Error("Intercom broker is already running; refusing to replace its socket.");
  }
  await stopUnhealthyBrokerBeforeSpawn();
}

function readLivePid(pidPath: string): number | null {
  if (!existsSync(pidPath)) {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf-8");
  } catch {
    return null;
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return hasErrorCode(error, "EPERM") ? pid : null;
  }
  return isBrokerPidReused(pid, raw) ? null : pid;
}

async function previousBrokerWarning(): Promise<string | undefined> {
  const previousSockets = getPreviousBrokerSocketPaths();
  for (const socketPath of previousSockets) {
    // Migration probes are sequential and never register or send to old peers.
    // oxlint-disable-next-line no-await-in-loop
    if (isOwnedBrokerSocket(socketPath) && (await checkOneSocket(socketPath))) {
      return "An older agent-directory Intercom broker is still running. Its peers are not part of shared same-user discovery until they reload with the updated extension. Existing sessions and accepted work are untouched; no legacy fallback is used.";
    }
  }
  const previousPid = readLivePid(join(getPiAgentDir(), "intercom", "broker.pid"));
  if (previousPid !== null) {
    return `Older Intercom broker PID ${previousPid} may still own accepted work. Its peers need to reload with the updated extension to join shared same-user discovery. Nothing was stopped or replaced; no legacy fallback is used.`;
  }
  return undefined;
}

export async function stopUnhealthyBrokerBeforeSpawn(): Promise<void> {
  if (await checkSocketConnectable()) {
    return;
  }
  const pid = readLivePid(BROKER_PID);
  if (pid === null) {
    return;
  }
  throw new Error(
    `Intercom broker PID ${pid} may still own accepted work but its socket is unhealthy; refusing to spawn a second broker. Let the broker exit normally, then retry.`,
  );
}

async function checkSocketConnectable(): Promise<boolean> {
  const socketPath = getBrokerSocketPath();
  return isOwnedBrokerSocket(socketPath) && (await checkOneSocket(socketPath));
}

function checkOneSocket(brokerSocket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(brokerSocket);
    const finish = (isConnected: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
      resolve(isConnected);
    };
    const onConnect = () => finish(true);
    const onError = () => finish(false);
    socket.on("connect", onConnect);
    socket.on("error", onError);
    const timeout = setTimeout(() => finish(false), 1000);
    timeout.unref();
  });
}

function acquireSpawnLock(): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (isSpawnLockStale()) {
        releaseSpawnLock();
        continue;
      }
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8")
      .trim()
      .split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        // The process that created the lock is gone.
        return true;
      }
    }

    return !Number.isFinite(createdAt) || ageMs > 10_000;
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Each probe must finish before the next to avoid parallel socket attempts.
    // oxlint-disable-next-line no-await-in-loop
    if (await checkSocketConnectable()) {
      return;
    }
    // Polling waits between probes rather than starting an unbounded batch.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}
