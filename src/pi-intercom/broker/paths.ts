import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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

/** A deployment can explicitly opt out of same-user discovery with a private runtime directory. */
export function getBrokerRuntimeDir(): string {
  const configured = process.env.PI_INTERCOM_RUNTIME_DIR;
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Intercom requires Unix user IDs and Unix domain sockets.");
  }
  const directory = configured ?? join("/tmp", `pi-intercom-${uid}`);
  if (
    !isAbsolute(directory) ||
    directory.includes("\0") ||
    Buffer.byteLength(join(directory, "broker.sock")) > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new Error("PI_INTERCOM_RUNTIME_DIR must be an absolute short Unix socket directory.");
  }
  return directory;
}

export function getBrokerSocketPath(): string {
  return join(getBrokerRuntimeDir(), "broker.sock");
}

export function prepareBrokerSocketPath(): string {
  const socketPath = getBrokerSocketPath();
  const brokerDir = dirname(socketPath);
  fs.mkdirSync(brokerDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(brokerDir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`Unsafe intercom socket directory: ${brokerDir}`);
  }
  fs.chmodSync(brokerDir, 0o700);
  return socketPath;
}
