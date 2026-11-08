import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { isLinuxProcessReplaced, readLinuxProcess } from "../pi-intercom/broker/pid.ts";
import { hasErrorCode } from "./unknown.ts";

const BIRTH_FIELDS = ["lstart=", "pgid="];

// macOS ships /bin/ps; resolving "ps" through PATH can spawn once per missing entry.
export const PS_COMMAND = process.platform === "darwin" ? "/bin/ps" : "ps";

interface AgentProcessExit {
  readonly pid?: number | undefined;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: number;
}

interface ChildWithPipedStdio {
  readonly stdout: ChildProcess["stdout"];
  readonly stderr: ChildProcess["stderr"];
  readonly on: ChildProcess["on"];
  readonly off: ChildProcess["off"];
}

interface ChildWithKill {
  readonly pid?: number | undefined;
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
  return groupLeader(pid, readPsFields(pid, BIRTH_FIELDS));
}

function groupLeader(pid: number, birth: string | undefined): string | undefined {
  return Number(birth?.split(" ").at(-1)) === pid ? birth : undefined;
}

// Always one PID: Darwin ps given several PIDs scans every process at many times the cost.
function psArguments(pid: number, fields: readonly string[]): string[] {
  return ["-p", String(pid), ...fields.flatMap((field) => ["-o", field])];
}

function psOptions(zone: string | undefined) {
  const env = { ...process.env, LC_ALL: "C", ...(zone === undefined ? {} : { TZ: zone }) };
  return { encoding: "utf8" as const, timeout: 1000, env };
}

function readPsFields(pid: number, fields: readonly string[], zone?: string): string | undefined {
  try {
    return execFileSync(PS_COMMAND, psArguments(pid, fields), {
      ...psOptions(zone),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/\s+/g, " ");
  } catch {
    return undefined;
  }
}

/** Nonblocking `readPsFields`; a failed run likewise observes nothing. */
function observePsFields(
  pid: number,
  fields: readonly string[],
  zone?: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(PS_COMMAND, psArguments(pid, fields), psOptions(zone), (error, stdout) => {
      resolve(error ? undefined : stdout.trim().replace(/\s+/g, " "));
    });
  });
}

// C-locale ps lstart (whole-second birth, in the reader's zone), then the process group.
const PS_IDENTITY = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) \d+$/;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

/** Parses a birth observed with TZ=UTC0. */
function utcBirth(birth: string | undefined): number {
  const [, month = "", day, hours, minutes, seconds, year] = PS_IDENTITY.exec(birth ?? "") ?? [];
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
function clockBound(clock: ProcessClock | undefined) {
  const before = readProcessClock();
  return clock !== undefined && before !== undefined && sameClock(clock, before)
    ? { clock, before }
    : undefined;
}

/** `elapsed` is observed after the bound's `before` read; the closing clock read follows both. */
function bornAfter(
  { clock, before }: { clock: ProcessClock; before: ProcessClock },
  elapsed = "",
): boolean {
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
    const bound = clockBound(clock);
    return bound !== undefined && bornAfter(bound, readPsFields(pid, ["etimes="]));
  }
  return published !== undefined && utcBirth(readPsFields(pid, BIRTH_FIELDS, "UTC0")) > published;
}

/**
 * Nonblocking `readChildProcessIdentity(pid) !== recorded && isChildProcessReplaced(...)` for
 * routine liveness. Signals still need the fresh synchronous proof.
 */
export async function observeChildProcessReplaced(
  pid: number,
  recorded: string,
  published?: number,
  clock?: ProcessClock,
): Promise<boolean> {
  if (process.platform === "linux") {
    return readChildProcessIdentity(pid) !== recorded && isLinuxProcessReplaced(pid, recorded);
  }
  if (
    !PS_IDENTITY.test(recorded) ||
    groupLeader(pid, await observePsFields(pid, BIRTH_FIELDS)) === recorded
  ) {
    return false;
  }
  if (process.platform === "android") {
    const bound = clockBound(clock);
    return bound !== undefined && bornAfter(bound, await observePsFields(pid, ["etimes="]));
  }
  if (published === undefined) {
    return false;
  }
  return utcBirth(await observePsFields(pid, BIRTH_FIELDS, "UTC0")) > published;
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
  private phase:
    | { readonly kind: "monitoring" }
    | { readonly kind: "settlement-delay"; readonly timer: NodeJS.Timeout }
    | { readonly kind: "terminating"; readonly escalation: NodeJS.Timeout | undefined }
    | { readonly kind: "closed"; readonly stopping: boolean } = { kind: "monitoring" };
  private settlementSignalAccepted = false;
  private exit?: AgentProcessExit;
  private readonly child: ChildWithPipedStdio & ChildWithKill;
  private readonly clearStdioGuard: () => void;
  constructor(child: ChildWithPipedStdio & ChildWithKill) {
    this.child = child;
    this.clearStdioGuard = attachPostExitStdioGuard(child);
    child.on("exit", (code, signal) => {
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
    if (this.phase.kind === "settlement-delay") {
      clearTimeout(this.phase.timer);
      this.phase = { kind: "monitoring" };
    }
  }
  private clearTimers(): void {
    this.clearDrain();
    if (this.phase.kind === "terminating") {
      clearTimeout(this.phase.escalation);
      this.phase = { kind: "terminating", escalation: undefined };
    }
  }
  private signalTree(): boolean {
    const escalation = setTimeout(() => {
      if (isChildTreeAlive(this.child)) {
        trySignalChildTree(this.child, "SIGKILL");
      }
    }, 3000);
    escalation.unref();
    this.phase = { kind: "terminating", escalation };
    // Pi print mode uses SIGTERM to dispose its own detached tool processes.
    return trySignalChildTree(this.child, "SIGTERM");
  }
  readonly terminate = (): void => {
    // Cancellation overrides pending or already-started successful settlement cleanup.
    this.settlementSignalAccepted = false;
    this.clearDrain();
    if (this.phase.kind === "monitoring") {
      this.signalTree();
    }
  };
  private dispose(): void {
    this.clearTimers();
    this.phase = { kind: "closed", stopping: this.stopping };
    this.clearStdioGuard();
  }
  get stopping(): boolean {
    return (
      this.phase.kind === "terminating" || (this.phase.kind === "closed" && this.phase.stopping)
    );
  }
  get agentProcessExit(): AgentProcessExit | undefined {
    return this.exit;
  }
  get settledCleanup(): boolean {
    return this.settlementSignalAccepted;
  }
  readonly observeEvent = (type: string | undefined): void => {
    if (
      this.phase.kind === "closed" ||
      this.exit !== undefined ||
      this.phase.kind === "terminating"
    ) {
      return;
    }
    if (type === "agent_settled") {
      if (this.phase.kind === "settlement-delay") {
        return;
      }
      const timer = setTimeout(() => {
        this.settlementSignalAccepted = this.signalTree();
      }, 1000);
      timer.unref();
      this.phase = { kind: "settlement-delay", timer };
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
  let state:
    | { readonly kind: "waiting" }
    | { readonly kind: "draining"; idle: NodeJS.Timeout | undefined; readonly hard: NodeJS.Timeout }
    | { readonly kind: "closed" } = { kind: "waiting" };
  let stdoutEnded = false;
  let stderrEnded = false;

  const destroyUnendedStdio = () => {
    if (state.kind !== "draining") {
      return;
    }
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
    cleanup();
  };

  const armIdleTimer = () => {
    if (state.kind !== "draining") {
      return;
    }
    clearTimeout(state.idle);
    state.idle = setTimeout(destroyUnendedStdio, 2000);
    state.idle.unref();
  };
  const stdoutEnd = () => {
    stdoutEnded = true;
    if (stderrEnded) {
      cleanup();
    }
  };
  const stderrEnd = () => {
    stderrEnded = true;
    if (stdoutEnded) {
      cleanup();
    }
  };
  const exited = () => {
    if (state.kind !== "waiting") {
      return;
    }
    const hard = setTimeout(destroyUnendedStdio, 8000);
    hard.unref();
    state = { kind: "draining", idle: undefined, hard };
    armIdleTimer();
  };
  function cleanup(): void {
    if (state.kind === "draining") {
      clearTimeout(state.idle);
      clearTimeout(state.hard);
    }
    state = { kind: "closed" };
    child.stdout?.off("data", armIdleTimer);
    child.stderr?.off("data", armIdleTimer);
    child.stdout?.off("end", stdoutEnd);
    child.stderr?.off("end", stderrEnd);
    child.off("exit", exited);
    child.off("close", cleanup);
    child.off("error", cleanup);
  }
  child.stdout?.on("data", armIdleTimer);
  child.stderr?.on("data", armIdleTimer);
  child.stdout?.on("end", stdoutEnd);
  child.stderr?.on("end", stderrEnd);
  child.on("exit", exited);
  child.on("close", cleanup);
  child.on("error", cleanup);
  return cleanup;
}
