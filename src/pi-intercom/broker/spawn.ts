import { spawn } from "child_process";
import { closeSync, fstatSync, openSync, readFileSync } from "fs";
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
    // A competing broker can win publication. Its healthy endpoint is success even
    // when our candidate exits; the starter never owns or releases the broker's claim.
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      isBrokerRunning()
        .then((running) => {
          cleanup();
          if (running) {
            resolve();
          } else {
            const exit = signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`;
            reject(new Error(`Intercom broker exited before startup with ${exit}`));
          }
        })
        .catch((error: unknown) => {
          cleanup();
          reject(toError(error));
        });
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

type BrokerOwner =
  | { readonly kind: "absent" }
  | { readonly kind: "live"; readonly pid: number }
  | { readonly kind: "uncertain"; readonly reason: string };

function readBrokerOwner(pidPath: string): BrokerOwner {
  let raw: string;
  let published: number;
  try {
    const fd = openSync(pidPath, "r");
    try {
      raw = readFileSync(fd, "utf-8");
      published = fstatSync(fd).mtimeMs;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return hasErrorCode(error, "ENOENT")
      ? { kind: "absent" }
      : { kind: "uncertain", reason: `Cannot read broker PID record: ${errorMessage(error)}` };
  }
  const first = raw.trim().split("\n")[0] ?? "";
  const pid = Number(first);
  if (!/^[1-9]\d*$/.test(first) || !Number.isSafeInteger(pid)) {
    return { kind: "uncertain", reason: "Broker PID record is invalid" };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return hasErrorCode(error, "ESRCH")
      ? { kind: "absent" }
      : { kind: "uncertain", reason: `Cannot establish broker PID ${pid}: ${errorMessage(error)}` };
  }
  return isBrokerPidReused(pid, raw, published) ? { kind: "absent" } : { kind: "live", pid };
}

async function previousBrokerWarning(): Promise<string | undefined> {
  const previousSockets = getPreviousBrokerSocketPaths();
  for (const socketPath of previousSockets) {
    // Migration probes are sequential and never register or send to old peers.
    if (isOwnedBrokerSocket(socketPath) && (await checkOneSocket(socketPath))) {
      return "An older agent-directory Intercom broker is still running. Its peers are not part of shared same-user discovery until they reload with the updated extension. Existing sessions and accepted work are untouched; no legacy fallback is used.";
    }
  }
  const previous = readBrokerOwner(join(getPiAgentDir(), "intercom", "broker.pid"));
  if (previous.kind !== "absent") {
    const owner = previous.kind === "live" ? `PID ${previous.pid}` : "with uncertain PID identity";
    return `Older Intercom broker ${owner} may still own accepted work. Its peers need to reload with the updated extension to join shared same-user discovery. Nothing was stopped or replaced; no legacy fallback is used.`;
  }
  return undefined;
}

export async function stopUnhealthyBrokerBeforeSpawn(): Promise<void> {
  if (await checkSocketConnectable()) {
    return;
  }
  const owner = readBrokerOwner(BROKER_PID);
  switch (owner.kind) {
    case "absent":
      return;
    case "live":
      throw new Error(
        `Intercom broker PID ${owner.pid} may still own accepted work but its socket is unhealthy; refusing to spawn a second broker. Let the broker exit normally, then retry.`,
      );
    case "uncertain":
      throw new Error(
        `${owner.reason}; refusing to spawn a second broker while ownership is uncertain.`,
      );
  }
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

export async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Each probe must finish before the next to avoid parallel socket attempts.
    if (await checkSocketConnectable()) {
      return;
    }
    // Polling waits between probes rather than starting an unbounded batch.
    await sleep(100);
  }
  throw new Error(
    `Broker failed to start within timeout. Startup claim: ${BROKER_SPAWN_LOCK}. Live or uncertain owners are not reclaimed.`,
  );
}
