import type { ChildProcess } from "node:child_process";
import type { AgentProcessExit } from "./types.ts";

interface PostExitStdioGuardOptions {
	idleMs: number;
	hardMs: number;
}

interface ChildWithPipedStdio {
	stdout: ChildProcess["stdout"];
	stderr: ChildProcess["stderr"];
	on: ChildProcess["on"];
}

interface ChildWithKill {
	pid?: number;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export function trySignalChild(child: ChildWithKill, signal: NodeJS.Signals): boolean {
	try {
		return child.kill(signal);
	} catch {
		return false;
	}
}

export function isChildTreeAlive(child: ChildWithKill): boolean {
	if (child.pid) {
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
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
	if (child.pid) {
		try {
			process.kill(-child.pid, signal);
			return true;
		} catch {
			// Fall back when the child is not a process-group leader.
		}
	}
	return trySignalChild(child, signal);
}

/** One lifetime for the owned process group, including descendants holding its pipes open. */
export function attachChildProcessLifecycle(child: ChildWithPipedStdio & ChildWithKill) {
	let closed = false;
	let exited = false;
	let stopping = false;
	let settledCleanup = false;
	let agentProcessExit: AgentProcessExit | undefined;
	let drainTimer: NodeJS.Timeout | undefined;
	let escalationTimer: NodeJS.Timeout | undefined;
	const clearDrain = () => {
		clearTimeout(drainTimer);
		drainTimer = undefined;
	};
	const clearTimers = () => {
		clearDrain();
		clearTimeout(escalationTimer);
		escalationTimer = undefined;
	};
	const signalTree = () => {
		// Pi print mode uses SIGTERM to dispose its own detached tool processes.
		const sent = trySignalChildTree(child, "SIGTERM");
		escalationTimer = setTimeout(() => {
			if (isChildTreeAlive(child)) trySignalChildTree(child, "SIGKILL");
		}, 3000);
		escalationTimer.unref();
		return sent;
	};
	const terminate = () => {
		// Cancellation overrides a pending or already-started successful settlement cleanup.
		settledCleanup = false;
		clearDrain();
		if (closed || stopping) return;
		stopping = true;
		signalTree();
	};
	const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
	child.on("exit", (code, signal) => {
		exited = true;
		agentProcessExit = { pid: child.pid, code, signal, at: Date.now() };
		clearTimers();
		// The leader may exit before resistant descendants release inherited stdio.
		trySignalChildTree(child, "SIGKILL");
	});
	const dispose = () => {
		closed = true;
		clearTimers();
		clearStdioGuard();
	};
	child.on("close", dispose);
	child.on("error", dispose);
	return {
		terminate,
		get stopping() { return stopping; },
		get agentProcessExit() { return agentProcessExit; },
		get settledCleanup() { return settledCleanup; },
		observeEvent(type: string | undefined) {
			if (closed || exited || stopping) return;
			if (type === "agent_settled") {
				if (drainTimer) return;
				drainTimer = setTimeout(() => {
					drainTimer = undefined;
					stopping = true;
					settledCleanup = signalTree();
				}, 1000);
				drainTimer.unref();
			} else if (type === "agent_start" || type === "turn_start" || type?.startsWith("message_") || type?.startsWith("tool_execution_")) {
				clearDrain();
			}
		},
	};
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
			try { child.stdout?.destroy(); } catch {}
		}
		if (!stderrEnded) {
			try { child.stderr?.destroy(); } catch {}
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
		if (!exited) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(destroyUnendedStdio, idleMs);
		idleTimer.unref?.();
	};

	child.stdout?.on("data", armIdleTimer);
	child.stderr?.on("data", armIdleTimer);
	child.stdout?.on("end", () => {
		stdoutEnded = true;
		if (stdoutEnded && stderrEnded) clearTimers();
	});
	child.stderr?.on("end", () => {
		stderrEnded = true;
		if (stdoutEnded && stderrEnded) clearTimers();
	});
	child.on("exit", () => {
		exited = true;
		armIdleTimer();
		if (hardTimer) return;
		hardTimer = setTimeout(destroyUnendedStdio, hardMs);
		hardTimer.unref?.();
	});
	child.on("close", clearTimers);
	child.on("error", clearTimers);

	return clearTimers;
}
