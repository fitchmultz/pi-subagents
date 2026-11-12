import { isLinuxProcessReplaced } from "../../shared/linux-process.ts";
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
