import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import * as path from "node:path";
import { attachChildProcessLifecycle } from "../../shared/post-exit-stdio-guard.ts";
import type {
  AcceptanceVerifyCommand,
  AcceptanceVerifyResult,
} from "../../shared/types/acceptance.ts";

const MAX_VERIFY_OUTPUT_CHARS = 12_000;
class VerifyOutput {
  private value = "";
  private truncated = false;
  append(chunk: Buffer): void {
    const text = chunk.toString();
    const remaining = Math.max(0, MAX_VERIFY_OUTPUT_CHARS - this.value.length);
    this.value += text.slice(0, remaining);
    this.truncated ||= text.length > remaining;
  }
  read(): string | undefined {
    const trimmed = this.value.trim();
    if (trimmed.length === 0 && !this.truncated) {
      return undefined;
    }
    return this.truncated ? `${trimmed}${trimmed.length > 0 ? "\n" : ""}...[truncated]` : trimmed;
  }
}

function verifyStatus(
  exitCode: number | null,
  timedOut: boolean,
  cancelled: boolean,
  allowFailure: boolean,
): AcceptanceVerifyResult["status"] {
  if (cancelled) {
    return "failed";
  }
  if (timedOut) {
    return "timed-out";
  }
  if (exitCode === 0) {
    return "passed";
  }
  return allowFailure ? "allowed-failure" : "failed";
}

/** Owns the verification child, tree termination, output bounds, listeners and timer through close. */
export function runVerifyCommand(
  command: AcceptanceVerifyCommand,
  defaultCwd: string,
  signal?: AbortSignal,
): Promise<AcceptanceVerifyResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const cwd =
      command.cwd !== undefined && command.cwd.length > 0
        ? path.resolve(defaultCwd, command.cwd)
        : defaultCwd;
    const stdout = new VerifyOutput();
    const stderr = new VerifyOutput();
    let timedOut = false;
    let cancelled = false;
    const child = spawn(command.command, {
      cwd,
      env: { ...process.env, ...command.env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const lifecycle = attachChildProcessLifecycle(child);
    const abortListener =
      signal &&
      addAbortListener(signal, () => {
        cancelled = true;
        lifecycle.terminate();
      });
    const timeout = setTimeout(() => {
      timedOut = true;
      lifecycle.terminate();
    }, command.timeoutMs ?? 120_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    const cleanup = () => {
      clearTimeout(timeout);
      abortListener?.[Symbol.dispose]();
    };
    child.on("close", (exitCode) => {
      cleanup();
      resolve({
        id: command.id,
        command: command.command,
        cwd,
        exitCode,
        status: verifyStatus(exitCode, timedOut, cancelled, command.allowFailure === true),
        stdout: stdout.read(),
        stderr: cancelled ? "Verification cancelled." : stderr.read(),
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("error", (error) => {
      cleanup();
      resolve({
        id: command.id,
        command: command.command,
        cwd,
        exitCode: 1,
        status: command.allowFailure === true ? "allowed-failure" : "failed",
        stderr: error.message,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
