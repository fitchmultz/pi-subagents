import { execFileSync, type ChildProcess } from "node:child_process";
import { readLinuxProcess } from "../pi-intercom/broker/pid.ts";
import type { AgentProcessExit } from "./types.ts";
import { hasErrorCode } from "./unknown.ts";

interface PostExitStdioGuardOptions {
  readonly idleMs: number;
  readonly hardMs: number;
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

/** Capture the detached group leader's birth identity; Pi may replace its command-line title. */
export function readChildProcessIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (process.platform === "linux") {
    return readLinuxProcess(pid)?.identity;
  }
  try {
    const identity = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid="], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    })
      .trim()
      .replace(/\s+/g, " ");
    return Number(identity.split(" ").at(-1)) === pid ? identity : undefined;
  } catch {
    return undefined;
  }
}

export function trySignalChild(child: ChildWithKill, signal: NodeJS.Signals): boolean {
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
    this.clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
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

export function attachPostExitStdioGuard(
  child: ChildWithPipedStdio,
  options: PostExitStdioGuardOptions,
): () => void {
  const { idleMs, hardMs } = options;
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
    idleTimer = setTimeout(destroyUnendedStdio, idleMs);
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
    hardTimer = setTimeout(destroyUnendedStdio, hardMs);
    hardTimer.unref();
  });
  child.on("close", clearTimers);
  child.on("error", clearTimers);

  return clearTimers;
}
