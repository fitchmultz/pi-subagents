import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getPiAgentDir } from "../agent-dir.ts";

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function agentDigest(agentDir: string, uid?: number): string {
  return createHash("sha256")
    .update(uid === undefined ? agentDir : `${uid}:${agentDir}`)
    .digest("hex")
    .slice(0, 16);
}

/** Old agent-directory namespaces are inspected for migration, never used for routing. */
export function getPreviousBrokerSocketPaths(): readonly string[] {
  const agentDir = getPiAgentDir();
  const suffix = `pi-intercom-${agentDigest(agentDir, process.getuid?.())}`;
  const preferred = join(tmpdir(), suffix, "broker.sock");
  return [
    Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH_BYTES
      ? preferred
      : join("/tmp", suffix, "broker.sock"),
    join(tmpdir(), `pi-intercom-${agentDigest(agentDir)}.sock`),
  ];
}

export function isOwnedBrokerSocket(socketPath: string): boolean {
  try {
    const stat = fs.lstatSync(socketPath);
    const uid = process.getuid?.();
    return stat.isSocket() && (uid === undefined || stat.uid === uid);
  } catch {
    return false;
  }
}

function defaultRuntimeRoot(): string {
  if (process.platform !== "android") {
    return "/tmp";
  }
  return process.env.PREFIX === undefined ? tmpdir() : join(process.env.PREFIX, "tmp");
}

function runtimeDirectory(socketName: string, sibling = ""): string {
  const configured = process.env.PI_INTERCOM_RUNTIME_DIR;
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Intercom requires Unix user IDs and Unix domain sockets.");
  }
  const base = configured ?? join(defaultRuntimeRoot(), `pi-intercom-${uid}`);
  const directory = isAbsolute(base) && sibling !== "" ? `${resolve(base)}${sibling}` : base;
  if (
    !isAbsolute(directory) ||
    directory.includes("\0") ||
    Buffer.byteLength(join(directory, socketName)) > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new Error("PI_INTERCOM_RUNTIME_DIR must be an absolute short Unix socket directory.");
  }
  return directory;
}

/** A deployment can explicitly opt out of same-user discovery with a private runtime directory. */
export function getBrokerRuntimeDir(): string {
  return runtimeDirectory("broker.sock");
}

/** Read-only child observation endpoints share the runtime policy, not the broker namespace.
 * The endpoint name is a short token digest because the private runtime directory also counts
 * toward the Unix-socket path limit; a full token made nested test/deployment roots overflow. */
export function agentObservationSocketPath(token: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(token)) {
    throw new Error("Invalid actor token.");
  }
  const name = `obs-${createHash("sha256").update(token).digest("hex").slice(0, 16)}.sock`;
  return join(runtimeDirectory(name, "-agents"), name);
}

export function getBrokerSocketPath(): string {
  return join(getBrokerRuntimeDir(), "broker.sock");
}

/** Create or verify an owned, non-symlink, private socket directory. */
export function preparePrivateSocketPath(socketPath: string): string {
  const directory = dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`Unsafe intercom socket directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  return socketPath;
}

export function prepareBrokerSocketPath(): string {
  return preparePrivateSocketPath(getBrokerSocketPath());
}
