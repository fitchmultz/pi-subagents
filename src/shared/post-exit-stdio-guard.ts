import { execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { isLinuxProcessReplaced, readLinuxProcess } from "../pi-intercom/broker/pid.ts";
import { hasErrorCode } from "./unknown.ts";

interface AgentProcessExit {
  readonly pid?: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: number;
}

interface ChildWithPipedStdio {
  readonly stdout: ChildProcess["stdout"];
  readonly stderr: ChildProcess["stderr"];
  readonly on: ChildProcess["on"];
}

interface ChildWithKill {
  readonly pid?: number;
  readonly kill: (signal?: NodeJS.Signals | number) => boolean;
}

interface ProcessClock {
  readonly boot: string;
  readonly namespace: string;
  readonly at: string;
}

/** Capture only a real, cross-process clock context; unavailable context proves nothing. */
export function readProcessClock(): ProcessClock | undefined {
  if (process.platform !== "android") {
    return undefined;
  }
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const namespace = readlinkSync("/proc/self/ns/time");
    const at = process.hrtime.bigint();
    return at > 0n &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(boot) &&
      /^time:\[\d+\]$/.test(namespace)
      ? { boot, namespace, at: at.toString() }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Capture the detached group leader's birth identity; Pi may replace its command-line title. */
export function readChildProcessIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (process.platform === "linux") {
    return readLinuxProcess(pid)?.identity;
  }
  const identity = readPsFields(pid, ["lstart=", "pgid="]);
  return Number(identity?.split(" ").at(-1)) === pid ? identity : undefined;
}

function readPsFields(pid: number, fields: readonly string[], zone?: string): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), ...fields.flatMap((field) => ["-o", field])], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", ...(zone === undefined ? {} : { TZ: zone }) },
    })
      .trim()
      .replace(/\s+/g, " ");
  } catch {
    return undefined;
  }
}

// C-locale ps lstart (whole-second birth, in the reader's zone), then the process group.
const PS_IDENTITY = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) \d+$/;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

function readUtcBirth(pid: number): number {
  const [, month = "", day, hours, minutes, seconds, year] =
    PS_IDENTITY.exec(readPsFields(pid, ["lstart=", "pgid="], "UTC0") ?? "") ?? [];
  const index = MONTHS.indexOf(month);
  // Unreadable or malformed observations yield NaN, which never proves a later birth.
  return month.length === 3 && index % 3 === 0
    ? Date.UTC(
        Number(year),
        index / 3,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds),
      )
    : Number.NaN;
}

function sameClock(left: ProcessClock, right: ProcessClock): boolean {
  return left.boot === right.boot && left.namespace === right.namespace;
}

/** Android's elapsed age bounds birth in the saved monotonic clock, never wall time. */
function bornAfterClock(pid: number, clock: ProcessClock | undefined): boolean {
  const before = readProcessClock();
  if (clock === undefined || before === undefined || !sameClock(clock, before)) {
    return false;
  }
  const elapsed = readPsFields(pid, ["etimes="]) ?? "";
  const after = readProcessClock();
  if (after === undefined || !sameClock(before, after) || !/^\d+$/.test(elapsed)) {
    return false;
  }
  // Include displayed-second and native tick uncertainty. BOOTTIME age includes suspend,
  // unlike hrtime's MONOTONIC clock, so suspend only moves this lower bound earlier.
  const birth = BigInt(before.at) - (BigInt(elapsed) + 2n) * 1_000_000_000n;
  return BigInt(after.at) >= BigInt(before.at) && birth > BigInt(clock.at);
}

/**
 * True only when a live PID provably names a different process than an owner-published record.
 * Darwin identities are unzoned local times, so they are never compared across zones; only a
 * UTC-observed birth strictly after the record's publication proves replacement. Android uses
 * a conservative elapsed-age bound against its recorded boot-qualified monotonic clock.
 */
export function isChildProcessReplaced(
  pid: number,
  recorded: string,
  published?: number,
  clock?: ProcessClock,
): boolean {
  if (process.platform === "linux") {
    return isLinuxProcessReplaced(pid, recorded);
  }
  if (!PS_IDENTITY.test(recorded)) {
    return false;
  }
  if (process.platform === "android") {
    return bornAfterClock(pid, clock);
  }
  return published !== undefined && readUtcBirth(pid) > published;
}

function trySignalChild(child: ChildWithKill, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

export function isChildTreeAlive(child: ChildWithKill): boolean {
  if (child.pid !== undefined && child.pid !== 0) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "EPERM")) {
        return true;
      }
    }
  }
  try {
    return child.kill(0);
  } catch {
    return false;
  }
}

/** Signal the detached child's process group, falling back if it is not a group leader. */
export function trySignalChildTree(child: ChildWithKill, signal: NodeJS.Signals): boolean {
  if (child.pid !== undefined && child.pid !== 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall back when the child is not a process-group leader.
    }
  }
  return trySignalChild(child, signal);
}

/** Process-group settlement, cancellation, and descendant cleanup have one owner. */
interface ChildProcessLifecycle {
  readonly terminate: () => void;
  readonly stopping: boolean;
  readonly agentProcessExit: AgentProcessExit | undefined;
  readonly settledCleanup: boolean;
  readonly observeEvent: (type: string | undefined) => void;
}
function activityEvent(type: string | undefined): boolean {
  return (
    type === "agent_start" ||
    type === "turn_start" ||
    type?.startsWith("message_") === true ||
    type?.startsWith("tool_execution_") === true
  );
}
class OwnedChildLifecycle implements ChildProcessLifecycle {
  private closed = false;
  private exited = false;
  private isStopping = false;
  private isSettledCleanup = false;
  private exit?: AgentProcessExit;
  private drainTimer?: NodeJS.Timeout;
  private escalationTimer?: NodeJS.Timeout;
  private readonly child: ChildWithPipedStdio & ChildWithKill;
  private readonly clearStdioGuard: () => void;
  constructor(child: ChildWithPipedStdio & ChildWithKill) {
    this.child = child;
    this.clearStdioGuard = attachPostExitStdioGuard(child);
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exit = { pid: child.pid, code, signal, at: Date.now() };
      this.clearTimers();
      // The leader may exit before resistant descendants release inherited stdio.
      trySignalChildTree(child, "SIGKILL");
    });
    child.on("close", () => {
      this.dispose();
    });
    child.on("error", () => {
      this.dispose();
    });
  }
  private clearDrain(): void {
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
  }
  private clearTimers(): void {
    this.clearDrain();
    clearTimeout(this.escalationTimer);
    this.escalationTimer = undefined;
  }
  private signalTree(): boolean {
    // Pi print mode uses SIGTERM to dispose its own detached tool processes.
    const sent = trySignalChildTree(this.child, "SIGTERM");
    this.escalationTimer = setTimeout(() => {
      if (isChildTreeAlive(this.child)) {
        trySignalChildTree(this.child, "SIGKILL");
      }
    }, 3000);
    this.escalationTimer.unref();
    return sent;
  }
  readonly terminate = (): void => {
    // Cancellation overrides pending or already-started successful settlement cleanup.
    this.isSettledCleanup = false;
    this.clearDrain();
    if (!this.closed && !this.isStopping) {
      this.isStopping = true;
      this.signalTree();
    }
  };
  private dispose(): void {
    this.closed = true;
    this.clearTimers();
    this.clearStdioGuard();
  }
  get stopping(): boolean {
    return this.isStopping;
  }
  get agentProcessExit(): AgentProcessExit | undefined {
    return this.exit;
  }
  get settledCleanup(): boolean {
    return this.isSettledCleanup;
  }
  readonly observeEvent = (type: string | undefined): void => {
    if (this.closed || this.exited || this.isStopping) {
      return;
    }
    if (type === "agent_settled") {
      if (this.drainTimer) {
        return;
      }
      this.drainTimer = setTimeout(() => {
        this.drainTimer = undefined;
        this.isStopping = true;
        this.isSettledCleanup = this.signalTree();
      }, 1000);
      this.drainTimer.unref();
    } else if (activityEvent(type)) {
      this.clearDrain();
    }
  };
}
/** One lifetime for the owned process group, including descendants holding its pipes open. */
export function attachChildProcessLifecycle(
  child: ChildWithPipedStdio & ChildWithKill,
): ChildProcessLifecycle {
  return new OwnedChildLifecycle(child);
}

function attachPostExitStdioGuard(child: ChildWithPipedStdio): () => void {
  let exited = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;

  const destroyUnendedStdio = () => {
    if (!stdoutEnded) {
      try {
        child.stdout?.destroy();
      } catch {
        // The process has exited; failed pipe destruction must not prevent other cleanup.
      }
    }
    if (!stderrEnded) {
      try {
        child.stderr?.destroy();
      } catch {
        // The process has exited; failed pipe destruction must not prevent other cleanup.
      }
    }
  };

  const clearTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = undefined;
    }
  };

  const armIdleTimer = () => {
    if (!exited) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(destroyUnendedStdio, 2000);
    idleTimer.unref();
  };

  child.stdout?.on("data", armIdleTimer);
  child.stderr?.on("data", armIdleTimer);
  child.stdout?.on("end", () => {
    stdoutEnded = true;
    if (stderrEnded) {
      clearTimers();
    }
  });
  child.stderr?.on("end", () => {
    stderrEnded = true;
    if (stdoutEnded) {
      clearTimers();
    }
  });
  child.on("exit", () => {
    exited = true;
    armIdleTimer();
    if (hardTimer) {
      return;
    }
    hardTimer = setTimeout(destroyUnendedStdio, 8000);
    hardTimer.unref();
  });
  child.on("close", clearTimers);
  child.on("error", clearTimers);

  return clearTimers;
}
