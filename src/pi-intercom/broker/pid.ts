import { isLinuxProcessReplaced } from "../../shared/linux-process.ts";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import {
  isChildProcessReplaced,
  readChildProcessIdentity,
  readProcessClock,
} from "../../shared/post-exit-stdio-guard.ts";

/** Keep the numeric PID and native identity first for older readers. */
export function brokerPidRecord(): string {
  const identity = readChildProcessIdentity(process.pid);
  const clock = readProcessClock();
  return `${process.pid}\n${identity !== undefined ? `${identity}\n` : ""}${
    clock === undefined ? "" : `clock ${clock.boot} ${clock.namespace} ${clock.at}\n`
  }`;
}

export function isBrokerPidReused(pid: number, record: string, published?: number): boolean {
  return isBrokerProcessReplaced(pid, record.slice(record.indexOf("\n") + 1), published);
}

/** Publication is the observed file mtime, not an untrusted wall-clock field in the record. */
export function isBrokerProcessReplaced(pid: number, record: string, published?: number): boolean {
  if (process.platform === "linux") {
    return isLinuxProcessReplaced(pid, record);
  }
  const [identity = "", savedClock = ""] = record.trim().split("\n");
  const matched = /^clock ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) (time:\[\d+\]) (\d+)$/.exec(
    savedClock,
  );
  const [, boot, namespace, at] = matched ?? [];
  const clock =
    boot !== undefined && namespace !== undefined && at !== undefined
      ? { boot, namespace, at }
      : undefined;
  return isChildProcessReplaced(pid, identity, published, clock);
}

/** Holds the published endpoint identities until this broker exits. */
export class BrokerPublication {
  private socket: { path: string; identity: BigIntStats } | undefined;
  private pidFd: number | undefined;
  private readonly pidPath: string;

  constructor(pidPath: string) {
    this.pidPath = pidPath;
  }

  publish(socketPath: string): void {
    this.socket = { path: socketPath, identity: lstatSync(socketPath, { bigint: true }) };
    chmodSync(socketPath, 0o600);
    this.pidFd = openSync(this.pidPath, "w", 0o600);
    writeFileSync(this.pidFd, brokerPidRecord());
  }

  remove(): void {
    if (this.socket !== undefined) {
      removeEndpoint(this.socket.path, this.socket.identity);
    }
    if (this.pidFd !== undefined) {
      try {
        removeEndpoint(this.pidPath, fstatSync(this.pidFd, { bigint: true }));
      } finally {
        closeSync(this.pidFd);
        this.pidFd = undefined;
      }
    }
  }
}

function removeEndpoint(file: string, owned: BigIntStats): void {
  try {
    const current = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (current?.dev === owned.dev && current.ino === owned.ino) {
      unlinkSync(file);
    }
  } catch {
    // A missing or unreadable endpoint is not ours to remove.
  }
}
