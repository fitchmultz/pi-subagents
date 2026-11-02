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

// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);

/**
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {import("node:child_process").ExecFileOptionsWithStringEncoding & { detached: boolean }}
 */
function spawnOptions(cwd, env) {
  return { cwd, env, encoding: "utf8", detached: true, maxBuffer: 16 * 1024 * 1024 };
}

/**
 * A smoke-owned process: a direct execFile child or a discovered detached worker.
 * @typedef {object} ProcessEntry
 * @property {import("node:child_process").ChildProcess | { pid: number, kill(signal?: NodeJS.Signals | number): true }} child
 * @property {boolean | undefined} [broker]
 * @property {boolean | undefined} [exited]
 * @property {number | undefined} [stoppedAt]
 */
/**
 * @typedef {object} SmokeProcessOptions
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {number} timeoutMs
 * @property {AbortSignal} signal
 * @property {string} root
 */

/**
 * @param {string} dir
 * @returns {Generator<string, void, void>}
 */
export function* filesIn(/** @type {string} */ dir) {
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

export function processRef(/** @type {number} */ pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error("Invalid smoke-owned process ID");
  }
  return {
    pid,
    kill: (/** @type {NodeJS.Signals | number | undefined} */ signal) => process.kill(pid, signal),
  };
}

// This attempt owns only PIDs discovered from private run files or known direct children.
// Credentials and artifacts must remain available until all owned workers and the broker exit.
export class SmokeProcesses {
  // oxlint-disable-next-line typescript/prefer-readonly -- JSDoc class fields cannot express readonly
  /** @type {Map<number, ProcessEntry>} */ #processes = new Map();
  // oxlint-disable-next-line typescript/prefer-readonly -- JSDoc class fields cannot express readonly
  /** @type {SmokeProcessOptions} */ #options;

  constructor(/** @type {SmokeProcessOptions} */ { cwd, env, timeoutMs, signal, root }) {
    this.#options = { cwd, env, timeoutMs, signal, root };
  }

  #remember(/** @type {number | undefined} */ pid, /** @type {boolean} */ broker = false) {
    if (pid === undefined) {
      return;
    }
    if (!this.#processes.has(pid)) {
      this.#processes.set(pid, { child: processRef(pid) });
    }
    if (broker) {
      const remembered = this.#processes.get(pid);
      if (remembered) {
        remembered.broker = true;
      }
    }
  }

  /**
   * @param {string} label
   * @param {string} command
   * @param {string[]} args
   * @param {string | ((child: import("node:child_process").ChildProcess) => void)} [input]
   * @returns {Promise<string>}
   */
  run(label, command, args, input) {
    const { cwd, env, timeoutMs, signal } = this.#options;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      /** @type {Promise<void> | undefined} */ let discovery;
      /** @type {string | undefined} */ let discoveryError;
      const finish = async (
        /** @type {Error | undefined} */ error,
        /** @type {string} */ output = "",
      ) => {
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
      const failure = (
        /** @type {import("node:child_process").ExecFileException | null} */ error,
        /** @type {string} */ output,
      ) =>
        error === null
          ? undefined
          : new Error(
              `${label} failed with ${error.code ?? "spawn error"}\nCommand: ${command} ${args.join(" ")}\n${output}`,
            );
      const child = execFile(command, args, spawnOptions(cwd, env), (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        // oxlint-disable-next-line typescript/no-floating-promises -- finish settles the outer promise by design
        void finish(failure(error, output), output);
      });
      attachChildProcessLifecycle(child);
      if (child.pid !== undefined) {
        /** @type {ProcessEntry} */ const entry = { child };
        this.#processes.set(child.pid, entry);
        child.once("close", () => {
          entry.exited = !isChildTreeAlive(child);
        });
      }
      // Discover detached startup children even if their parent's startup fails.
      const watcher = setInterval(() => {
        discovery ??= this.#collect()
          .catch((/** @type {unknown} */ error) => {
            const message = error instanceof Error ? error.message : JSON.stringify(error);
            if (message !== discoveryError) {
              console.error(`[real-pi-smoke] process discovery: ${message}`);
            }
            discoveryError = message;
          })
          .finally(() => {
            discovery = undefined;
          });
      }, 100);
      // The outer finally stops parents AND detached workers; rejecting must not kill parents first.
      const timer = setTimeout(() => {
        // oxlint-disable-next-line typescript/no-floating-promises -- finish settles the outer promise by design
        void finish(
          new Error(
            `${label} timed out after ${timeoutMs}ms\nCommand: ${command} ${args.join(" ")}`,
          ),
        );
      }, timeoutMs);
      const cancel = () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-floating-promises -- signal.reason is any; finish settles the outer promise
        void finish(/** @type {Error | undefined} */ (signal.reason));
      };
      signal.addEventListener("abort", cancel, { once: true });
      child.stdin?.on("error", () => {
        // A command may exit without reading RPC input; execFile reports its exit failure.
      });
      // A function input owns a persistent RPC stdin and closes it to request orderly shutdown.
      if (typeof input === "function") {
        input(child);
      } else {
        child.stdin?.end(input);
      }
    });
  }

  #readRunPids() {
    const { env } = this.#options;
    const agentDir = env.PI_CODING_AGENT_DIR;
    const runtimeDir = env.PI_INTERCOM_RUNTIME_DIR;
    if (agentDir === undefined || runtimeDir === undefined) {
      throw new Error(
        "PI_CODING_AGENT_DIR and PI_INTERCOM_RUNTIME_DIR are required for ownership discovery",
      );
    }
    const runs = join(agentDir, "sessions", "agent-runs");
    for (const file of filesIn(runs)) {
      if (basename(file) === "process.json" && basename(dirname(file)) === "actor.lock") {
        /** @type {{ pid: number }} */
        // oxlint-disable-next-line typescript/no-unsafe-assignment
        const record = JSON.parse(readFileSync(file, "utf8"));
        this.#remember(record.pid);
      }
    }
    const brokerPid = join(runtimeDir, "broker.pid");
    if (existsSync(brokerPid)) {
      this.#remember(Number(readFileSync(brokerPid, "utf8").split("\n")[0]), true);
    }
  }

  async #discoverChildren(/** @type {{ pid?: number | undefined }} */ child) {
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
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 1) {
        throw error;
      }
      // pgrep exit 1 means there are no matching children.
    }
  }

  async #collect() {
    this.#readRunPids();
    // Visit newly remembered grandchildren too, before signalling parents. Never scan argv globally.
    for (const entry of this.#processes.values()) {
      if (entry.exited !== true) {
        entry.exited = !isChildTreeAlive(entry.child);
      }
      // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- exited stays optional under tsc
      if (entry.exited !== true) {
        // The Map expands during discovery; sequential traversal covers newly found grandchildren.
        // oxlint-disable-next-line no-await-in-loop
        await this.#discoverChildren(entry.child);
      }
    }
  }

  #alive() {
    /** @type {ProcessEntry[]} */ const alive = [];
    for (const entry of this.#processes.values()) {
      if (entry.exited !== true) {
        entry.exited = !isChildTreeAlive(entry.child);
      }
      // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- exited stays optional under tsc
      if (entry.exited !== true) {
        alive.push(entry);
      }
    }
    return alive;
  }

  #signal(/** @type {ProcessEntry[]} */ alive) {
    const workers = alive.filter((entry) => entry.broker !== true);
    // Stop the broker last so exiting workers cannot restart it during cleanup.
    for (const entry of workers.length > 0 ? workers : alive) {
      if (entry.stoppedAt === undefined) {
        entry.stoppedAt = Date.now();
        trySignalChildTree(entry.child, "SIGTERM");
      } else if (Date.now() - entry.stoppedAt >= 3000) {
        trySignalChildTree(entry.child, "SIGKILL");
      }
    }
  }

  async stop() {
    /** @type {string | undefined} */ let lastError;
    while (true) {
      let collected = false;
      try {
        // Ownership discovery must finish before this iteration signals processes.
        // oxlint-disable-next-line no-await-in-loop
        await this.#collect();
        collected = true;
      } catch (error) {
        // Retain the controller and credentials if ownership cannot yet be read.
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        if (message !== lastError) {
          console.error(`[real-pi-smoke] waiting for owned-process cleanup: ${message}`);
        }
        lastError = message;
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
