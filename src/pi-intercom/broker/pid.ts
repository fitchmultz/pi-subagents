import { closeSync, openSync, readFileSync, readlinkSync } from "node:fs";

// Keep the first numeric line readable by older brokers/spawn guards.
// starttime is /proc/<pid>/stat field 22, in clock ticks; never round it to Number.
const IDENTITY =
  /^linux-v1 ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) (pid:\[\d+\]) (time:\[\d+\]) (\d+)$/;

function processIdentity(base: string, pid: number): string | undefined {
  const stat = readFileSync(`${base}/stat`, "utf8");
  // comm can contain spaces, newlines and ')'; fields after its final ')' are fixed.
  if (!stat.startsWith(`${pid} (`)) {
    return;
  }
  const startTicks = stat
    .slice(stat.lastIndexOf(")") + 2)
    .split(/\s+/)
    .at(19);
  if (startTicks === undefined) {
    return;
  }
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const pidNamespace = readlinkSync(`${base}/ns/pid`);
  // Linux applies the reader's time-namespace offset to stat.starttime.
  const timeNamespace = readlinkSync("/proc/self/ns/time");
  const identity = `linux-v1 ${bootId} ${pidNamespace} ${timeNamespace} ${startTicks}`;
  return IDENTITY.test(identity) ? identity : undefined;
}

function threadGroupLeader(status: string, pid: number): number | undefined {
  const tgid = Number(/^Tgid:[ \t]+(\d+)$/m.exec(status)?.[1]);
  if (
    !Number.isSafeInteger(tgid) ||
    tgid <= 0 ||
    Number(/^Pid:[ \t]+(\d+)$/m.exec(status)?.[1]) !== pid
  ) {
    return;
  }
  return tgid;
}

export function readLinuxProcess(pid: number): { tgid: number; identity?: string } | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  let fd: number | undefined;
  try {
    // A procfs mounted from an ancestor PID namespace has different PID numbers
    // from kill(2)/process.pid. Do not use that view to disprove broker identity.
    const self = readFileSync("/proc/self/status", "utf8");
    if (!new RegExp(`^NStgid:[ \\t]+${process.pid}$`, "m").test(self)) {
      return undefined;
    }
    // Pin this proc directory so separate metadata reads cannot cross PID reuse.
    fd = openSync(`/proc/${pid}`, "r");
    const base = `/proc/self/fd/${fd}`;
    const status = readFileSync(`${base}/status`, "utf8");
    const tgid = threadGroupLeader(status, pid);
    if (tgid === undefined) {
      return;
    }
    // Node writes process.pid (the thread-group leader), never a worker TID.
    if (tgid !== pid) {
      return { tgid };
    }
    const identity = processIdentity(base, pid);
    return identity !== undefined ? { tgid, identity } : undefined;
  } catch {
    // Unavailable procfs, permissions or incomplete observations prove nothing.
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export function brokerPidRecord(): string {
  const identity = readLinuxProcess(process.pid)?.identity;
  return `${process.pid}\n${identity !== undefined ? `${identity}\n` : ""}`;
}

export function isBrokerPidReused(pid: number, record: string): boolean {
  const current = readLinuxProcess(pid);
  if (!current) {
    return false;
  }
  if (current.tgid !== pid) {
    return true;
  }
  const saved = IDENTITY.exec(record.slice(record.indexOf("\n") + 1).trim());
  const actual = IDENTITY.exec(current.identity ?? "");
  if (!saved || !actual) {
    return false;
  }
  const [, boot, namespace, clock, start] = saved;
  const [, actualBoot, actualNamespace, actualClock, actualStart] = actual;
  // A clock-namespace change alone is not evidence that the process changed.
  return (
    boot !== actualBoot ||
    namespace !== actualNamespace ||
    (clock === actualClock && start !== actualStart)
  );
}
