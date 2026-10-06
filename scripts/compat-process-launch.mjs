import { fork } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

function commandFailure(command, args, code, signal) {
  const error = new Error(`${command} ${args.join(" ")} failed (${code ?? signal})`);
  error.status = code;
  error.signal = signal;
  return error;
}
function childStdio(stdio) {
  const descriptors =
    typeof stdio === "string" ? [stdio, stdio, stdio] : (stdio ?? ["ignore", "pipe", "pipe"]);
  if (descriptors.includes("ipc")) {
    throw new Error("Compatibility command IPC is reserved for its session guardian");
  }
  return [...descriptors, "ipc"];
}

// One real fork/IPC lifetime: command status may settle before inherited pipes
// close, but the private session leader stays reserved until explicit release.
export class GuardianCommand {
  #child;
  #ready;
  #closed;
  #cancelled;
  #resolveCancel;
  #releasing = false;
  #lost;
  #output = { stdout: "" };
  constructor(environment, options) {
    const decoder = new StringDecoder("utf8");
    this.#child = fork(new URL("./compat-process-guardian.mjs", import.meta.url), [], {
      env: environment,
      detached: true,
      execArgv: [],
      stdio: childStdio(options.stdio),
    });
    this.#closed = new Promise((resolve) => {
      this.#child.once("close", resolve);
    });
    this.#ready = new Promise((resolve, reject) => {
      this.#child.once("error", reject);
      this.#child.once("exit", (code, signal) => {
        if (!this.#releasing) {
          this.#lost = new Error(
            `Compatibility guardian ${this.#child.pid} exited before release (${code ?? signal})`,
          );
          reject(this.#lost);
        }
      });
      this.#child.on("message", (message) => {
        if (message.type === "ready") {
          resolve();
        }
        if (message.type === "cancelled") {
          this.#resolveCancel?.();
        }
      });
    });
    // Readiness can reject before execute attaches its continuation.
    this.#ready.catch(() => {
      /* execute and stop own readiness failure. */
    });
    this.#child.stdout?.on("data", (data) => {
      this.#output.stdout += decoder.write(data);
      if (!options.quiet) {
        process.stdout.write(data);
      }
    });
    this.#child.stdout?.on("end", () => {
      this.#output.stdout += decoder.end();
    });
    this.#child.stderr?.on("data", (data) => {
      process.stderr.write(data);
    });
  }
  get pid() {
    return this.#child.pid;
  }
  get lost() {
    return this.#lost;
  }
  #send(message) {
    return new Promise((resolve, reject) => {
      this.#child.send(message, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
  execute(request, signal, admit) {
    const { command, args, options } = request;
    const {
      timeout = 300_000,
      quiet: _quiet,
      stdio,
      env: _env,
      detached: _detached,
      ...commandOptions
    } = options;
    return new Promise((resolve, reject) => {
      const timeoutError = new Error(`${command} ${args.join(" ")} timed out after ${timeout}ms`);
      timeoutError.code = "ETIMEDOUT";
      const timer = setTimeout(() => {
        dispose();
        reject(timeoutError);
      }, timeout);
      const cancel = () => {
        dispose();
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      const dispose = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      };
      this.#child.on("message", (message) => {
        if (message.type === "exit") {
          dispose();
          if (message.code === 0) {
            resolve(this.#output);
          } else {
            reject(commandFailure(command, args, message.code, message.signal));
          }
        } else if (message.type === "error") {
          dispose();
          reject(Object.assign(new Error(message.error.message), message.error));
        }
      });
      this.#child.once("exit", () => {
        dispose();
        if (this.#lost) {
          reject(this.#lost);
        }
      });
      this.#ready
        .then(async () => {
          admit(this.pid);
          if (signal.aborted || this.#cancelled) {
            cancel();
            return;
          }
          await this.#send({
            type: "start",
            command,
            args,
            options: {
              ...commandOptions,
              cwd:
                commandOptions.cwd instanceof URL
                  ? fileURLToPath(commandOptions.cwd)
                  : commandOptions.cwd,
            },
            descriptors: childStdio(stdio).length - 1,
          });
        })
        .catch((error) => {
          dispose();
          reject(error);
        });
      if (signal.aborted) {
        cancel();
      }
    });
  }
  cancel() {
    if (this.#lost) {
      return Promise.reject(this.#lost);
    }
    this.#cancelled ??= new Promise((resolve, reject) => {
      this.#resolveCancel = resolve;
      this.#child.once("exit", () =>
        reject(this.#lost ?? new Error("Guardian lost before cancellation acknowledgment")),
      );
      this.#send({ type: "cancel" }).catch(reject);
    });
    return this.#cancelled;
  }
  async release() {
    this.#releasing = true;
    await this.#send({ type: "release" });
    await this.#closed;
  }
  abandon() {
    // Failed cleanup hands the live reservation to disconnect-only rescue,
    // while allowing the failing caller to exit and leave its roots intact.
    if (this.#child.connected) {
      this.#child.disconnect();
    }
    this.#child.stdout?.destroy();
    this.#child.stderr?.destroy();
    this.#child.unref();
  }
}
