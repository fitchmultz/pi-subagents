import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  attachChildProcessLifecycle,
  isChildTreeAlive,
  trySignalChildTree,
} from "../src/shared/post-exit-stdio-guard.ts";

const execFileAsync = promisify(execFile);

export function* filesIn(dir) {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* filesIn(file);
    } else if (entry.isFile()) {
      yield file;
    }
  }
}

export function processRef(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error("Invalid smoke-owned process ID");
  }
  return { pid, kill: (signal) => process.kill(pid, signal) };
}

// This attempt owns only PIDs discovered from private run files or known direct children.
// Credentials and artifacts must remain available until all owned workers and the broker exit.
export class SmokeProcesses {
  #processes = new Map();
  #options;

  constructor({ cwd, env, timeoutMs, signal, root }) {
    this.#options = { cwd, env, timeoutMs, signal, root };
  }

  #remember(pid, broker = false) {
    if (pid === undefined) {
      return;
    }
    if (!this.#processes.has(pid)) {
      this.#processes.set(pid, { child: processRef(pid) });
    }
    if (broker) {
      this.#processes.get(pid).broker = true;
    }
  }

  run(label, command, args, input) {
    const { cwd, env, timeoutMs, signal } = this.#options;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let discovery;
      let discoveryError;
      const finish = async (error, output) => {
        clearTimeout(timer);
        clearInterval(watcher);
        signal.removeEventListener("abort", cancel);
        await discovery;
        if (error) {
          reject(error);
        } else {
          resolve(output);
        }
      };
      const child = execFile(
        command,
        args,
        { cwd, env, encoding: "utf8", detached: true, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const output = `${stdout ?? ""}${stderr ?? ""}`;
          void finish(
            error
              ? new Error(
                  `${label} failed with ${error.code ?? "spawn error"}\nCommand: ${command} ${args.join(" ")}\n${output}`,
                )
              : undefined,
            output,
          );
        },
      );
      attachChildProcessLifecycle(child);
      if (child.pid) {
        const entry = { child };
        this.#processes.set(child.pid, entry);
        child.once("close", () => {
          entry.exited = !isChildTreeAlive(child);
        });
      }
      // Discover detached startup children even if their parent's startup fails.
      const watcher = setInterval(() => {
        discovery ??= this.#collect()
          .catch((error) => {
            if (error.message !== discoveryError) {
              console.error(`[real-pi-smoke] process discovery: ${error.message}`);
            }
            discoveryError = error.message;
          })
          .finally(() => {
            discovery = undefined;
          });
      }, 100);
      // The outer finally stops parents AND detached workers; rejecting must not kill parents first.
      const timer = setTimeout(() => {
        void finish(
          new Error(
            `${label} timed out after ${timeoutMs}ms\nCommand: ${command} ${args.join(" ")}`,
          ),
        );
      }, timeoutMs);
      const cancel = () => {
        void finish(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      child.stdin.on("error", () => {
        // A command may exit without reading RPC input; execFile reports its exit failure.
      });
      child.stdin.end(input);
    });
  }

  #readRunPids() {
    const { env } = this.#options;
    const runs = join(env.PI_CODING_AGENT_DIR, "sessions", "agent-runs");
    for (const file of filesIn(runs)) {
      if (basename(file) === "process.json" && basename(dirname(file)) === "actor.lock") {
        this.#remember(JSON.parse(readFileSync(file, "utf8")).pid);
      }
    }
    const brokerPid = join(env.PI_INTERCOM_RUNTIME_DIR, "broker.pid");
    if (existsSync(brokerPid)) {
      this.#remember(Number(readFileSync(brokerPid, "utf8").split("\n")[0]), true);
    }
  }

  async #discoverChildren(child) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-P", String(child.pid)], {
        env: this.#options.env,
        encoding: "utf8",
        timeout: 1000,
      });
      for (const pid of stdout.trim().split(/\s+/).filter(Boolean)) {
        this.#remember(Number(pid));
      }
    } catch (error) {
      if (error.code !== 1) {
        throw error;
      }
      // pgrep exit 1 means there are no matching children.
    }
  }

  async #collect() {
    this.#readRunPids();
    // Visit newly remembered grandchildren too, before signalling parents. Never scan argv globally.
    for (const entry of this.#processes.values()) {
      if (!entry.exited) {
        entry.exited = !isChildTreeAlive(entry.child);
      }
      if (!entry.exited) {
        // The Map expands during discovery; sequential traversal covers newly found grandchildren.
        // oxlint-disable-next-line no-await-in-loop
        await this.#discoverChildren(entry.child);
      }
    }
  }

  #alive() {
    const alive = [];
    for (const entry of this.#processes.values()) {
      if (!entry.exited) {
        entry.exited = !isChildTreeAlive(entry.child);
      }
      if (!entry.exited) {
        alive.push(entry);
      }
    }
    return alive;
  }

  #signal(alive) {
    const workers = alive.filter((entry) => !entry.broker);
    // Stop the broker last so exiting workers cannot restart it during cleanup.
    for (const entry of workers.length ? workers : alive) {
      if (!entry.stoppedAt) {
        entry.stoppedAt = Date.now();
        trySignalChildTree(entry.child, "SIGTERM");
      } else if (Date.now() - entry.stoppedAt >= 3000) {
        trySignalChildTree(entry.child, "SIGKILL");
      }
    }
  }

  async stop() {
    let lastError;
    while (true) {
      let collected = false;
      try {
        // Ownership discovery must finish before this iteration signals processes.
        // oxlint-disable-next-line no-await-in-loop
        await this.#collect();
        collected = true;
      } catch (error) {
        // Retain the controller and credentials if ownership cannot yet be read.
        if (error.message !== lastError) {
          console.error(`[real-pi-smoke] waiting for owned-process cleanup: ${error.message}`);
        }
        lastError = error.message;
      }
      const alive = this.#alive();
      if (collected && alive.length === 0) {
        return;
      }
      this.#signal(alive);
      // Recheck liveness after signals; concurrent polling would race tree cleanup.
      // oxlint-disable-next-line no-await-in-loop
      await delay(50);
    }
  }
}
