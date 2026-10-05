import { hasErrorCode } from "../../shared/unknown.ts";
import { spawn, spawnSync } from "node:child_process";
import { addAbortListener } from "node:events";
import { trySignalChildTree } from "../../shared/post-exit-stdio-guard.ts";

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

export function runGit(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

export function runGitChecked(cwd: string, args: readonly string[]): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    const message =
      [result.stderr.trim(), result.stdout.trim()].find((text) => text.length > 0) ??
      `git -C ${cwd} ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

interface SetupCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly input?: string;
  readonly timeoutMs?: number;
}

/** Owns the child, its bounded output, abort listener, and timeout until stdio closes. */
export function runSetupCommand(options: SetupCommand): Promise<GitResult> {
  const { command, args, cwd, signal, input, timeoutMs } = options;
  signal?.throwIfAborted();
  return new Promise<GitResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    const child = spawn(command, [...args], { cwd, detached: true, stdio: "pipe" });
    const terminate = () => {
      trySignalChildTree(child, "SIGKILL");
    };
    const abortListener = signal && addAbortListener(signal, terminate);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            failure = new Error(`worktree setup hook timed out after ${timeoutMs}ms`);
            terminate();
          }, timeoutMs);
    timer?.unref();
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 1024 * 1024) {
          failure ??= new Error(`${command} output exceeded 1048576 bytes`);
          terminate();
        } else if (stream === child.stdout) {
          stdout += chunk;
        } else {
          stderr += chunk;
        }
      });
    }
    child.on("error", (error) => {
      failure = error;
      terminate();
    });
    child.on("exit", (status) => {
      if (status !== 0) {
        terminate();
      }
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      abortListener?.[Symbol.dispose]();
      if (signal?.aborted === true) {
        resolve({ stdout, stderr, status });
      } else if (failure) {
        reject(failure);
      } else {
        resolve({ stdout, stderr, status });
      }
    });
    child.stdin.on("error", (error) => {
      if (hasErrorCode(error, "EPIPE")) {
        return;
      } // The hook may exit without reading its payload.
      failure = error;
      terminate();
    });
    child.stdin.end(input);
  }).then((result) => {
    // AbortSignal.throwIfAborted preserves arbitrary native cancellation reasons.
    signal?.throwIfAborted();
    return result;
  });
}

export async function runSetupGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await runSetupCommand({ command: "git", args: ["-C", cwd, ...args], cwd, signal });
  if (result.status !== 0) {
    throw new Error(
      [result.stderr.trim(), result.stdout.trim()].find((text) => text.length > 0) ??
        `git -C ${cwd} ${args.join(" ")} failed`,
    );
  }
  return result.stdout;
}
