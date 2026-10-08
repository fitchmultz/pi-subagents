import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import { Fault, log, wait } from "./bridge-protocol.ts";
import type { LaunchPolicy } from "./bridge-launch-policy.ts";

const FRAME_LIMIT = 4 * 1024 * 1024;
function launchEnvironment(packageRoot: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PI_SUBAGENT_")),
  );
  return { ...environment, PI_PACKAGE_DIR: packageRoot };
}

// Native RpcClient lacks public EOF/exit/UI control and retains/reprints unbounded stderr.
// This owner implements only get_state and dialog cancellation, never a remote RPC proxy.
export class RpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  status: "starting" | "idle" | "running" | "stopping" | "exited" = "starting";
  failure?: Fault;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discarding = false;
  private sequence = 0;
  private pending?: {
    readonly id: string;
    readonly resolve: (data: UnknownRecord) => void;
    readonly reject: (error: Readonly<Error>) => void;
  };
  private stopping?: Promise<void>;
  private stderrBytes = 0;
  private exitObserved = false;

  constructor(policy: LaunchPolicy, cwd: string, sessionFile: string) {
    this.child = spawn(process.execPath, this.arguments(policy, sessionFile), {
      cwd,
      env: launchEnvironment(policy.packageRoot),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolveExit) => {
      this.child.once("close", (code, signal) => {
        this.exitObserved = true;
        this.buffer = "";
        this.discarding = false;
        this.status = "exited";
        this.fail(new Fault(503, "session_exited", "Launched Pi process exited."));
        log("launch_exit", { pid: this.child.pid, code, signal, stderrBytes: this.stderrBytes });
        resolveExit();
      });
    });
    this.child.once("error", () =>
      this.fail(new Fault(503, "launch_failed", "Pi process could not start.")),
    );
    this.child.stdin.on("error", () => {
      this.fail(new Fault(503, "rpc_closed", "Pi RPC input closed."));
      this.cleanup();
    });
    this.child.stdout.once("end", () => {
      this.fail(new Fault(503, "rpc_closed", "Pi RPC output closed."));
      this.cleanup();
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream.on("error", () => {
        this.fail(new Fault(503, "rpc_closed", "Pi RPC output failed."));
        this.cleanup();
      });
    }
    this.child.stdout.on("data", (chunk: Buffer) => this.read(this.decoder.write(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Drain without retaining or exposing diagnostics, including credential-bearing extension errors.
      this.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrBytes + chunk.length);
    });
  }
  get pid(): number | undefined {
    return this.child.pid;
  }
  private arguments(policy: LaunchPolicy, sessionFile: string): string[] {
    const args = [
      policy.cli,
      "--mode",
      "rpc",
      "--session",
      sessionFile,
      "--provider",
      policy.provider,
      "--model",
      policy.model,
      policy.trustProject ? "--approve" : "--no-approve",
    ];
    if (!policy.discoverResources) {
      args.push(
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
      );
    }
    if (policy.offline) {
      args.push("--offline");
    }
    for (const extension of policy.extensions) {
      args.push("--extension", extension);
    }
    return args;
  }
  private fail(error: Readonly<Fault>): void {
    this.failure ??= error;
    this.pending?.reject(this.failure);
    this.pending = undefined;
  }
  private retainedChunk(chunk: string): string {
    if (!this.discarding) {
      return chunk;
    }
    const end = chunk.indexOf("\n");
    if (end < 0) {
      return "";
    }
    this.discarding = false;
    return chunk.slice(end + 1);
  }
  private read(chunk: string): void {
    this.buffer += this.retainedChunk(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > FRAME_LIMIT) {
        this.oversize(line);
      } else {
        this.record(line);
      }
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer) > FRAME_LIMIT) {
      this.discarding = this.oversize(this.buffer);
      this.buffer = "";
    }
  }
  private oversize(prefix: string): boolean {
    // Native event serializers put the discriminant first; responses may put their request ID first.
    // ponytail: drain large native data events through LF; use token streaming if producer headers change.
    const header = /^\{"type":"([a-z_]+)"[,}]/.exec(prefix.slice(0, 256));
    const event = header?.[1];
    if (
      event !== undefined &&
      !["response", "extension_ui_request", "agent_start", "agent_settled"].includes(event)
    ) {
      log("rpc_event_discarded", { pid: this.pid, result: "oversized" });
      return true;
    }
    this.protocolFailure();
    return false;
  }
  private protocolFailure(): void {
    this.fail(new Fault(503, "rpc_invalid", "Pi RPC output violated its bounded JSONL contract."));
    this.cleanup();
  }
  private record(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      this.protocolFailure();
      return;
    }
    if (!isRecord(data)) {
      this.protocolFailure();
      return;
    }
    if (data.type === "response" && data.id === this.pending?.id) {
      this.response(data);
    } else if (data.type === "extension_ui_request") {
      this.dialog(data);
    } else if (!this.failure) {
      this.event(data.type);
    }
  }
  private event(type: unknown): void {
    if (type === "agent_start") {
      this.status = "running";
    } else if (type === "agent_settled") {
      this.status = "idle";
    }
  }
  private response(data: UnknownRecord): void {
    const pending = this.pending;
    this.pending = undefined;
    if (data.success === true && data.command === "get_state" && isRecord(data.data)) {
      pending?.resolve(data.data);
    } else {
      pending?.reject(new Fault(503, "rpc_failed", "Pi RPC state request failed."));
    }
  }
  private dialog(data: UnknownRecord): void {
    if (
      typeof data.method !== "string" ||
      !["confirm", "select", "input", "editor"].includes(data.method)
    ) {
      return;
    }
    if (typeof data.id === "string") {
      this.write({ type: "extension_ui_response", id: data.id, cancelled: true });
    }
    this.fail(
      new Fault(
        409,
        "interaction_required",
        "Pi requested unsupported interactive input; dialog cancelled and session stopped.",
      ),
    );
    this.cleanup();
  }
  private write(
    command: Readonly<
      | Extract<RpcCommand, { type: "get_state" }>
      | Extract<RpcExtensionUIResponse, { cancelled: true }>
    >,
  ): void {
    // Only one bounded state request can be in flight; no arbitrary input or growing write queue.
    if (!this.child.stdin.write(`${JSON.stringify(command)}\n`)) {
      this.fail(new Fault(503, "rpc_backpressure", "Pi RPC input is not being consumed."));
      this.cleanup();
    }
  }
  async state(signal: AbortSignal): Promise<UnknownRecord> {
    if (this.failure) {
      throw this.failure;
    }
    const id = `state-${++this.sequence}`;
    const result = new Promise<UnknownRecord>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.write({ type: "get_state", id });
    });
    try {
      return await wait(result, signal);
    } finally {
      this.pending = undefined;
    }
  }
  ready(): void {
    if (this.failure || this.exitObserved) {
      throw this.failure ?? new Fault(503, "session_exited", "Pi exited during startup.");
    }
    if (this.status === "starting") {
      this.status = "idle";
    }
  }
  private cleanup(): void {
    this.stop().catch(() => log("launch_cleanup", { pid: this.child.pid, result: "failed" }));
  }
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }
  private async shutdown(): Promise<void> {
    if (this.exitObserved) {
      return;
    }
    this.status = "stopping";
    this.fail(new Fault(410, "session_stopped", "Launched session is stopping."));
    this.child.stdin.end();
    const terminate = setTimeout(() => {
      this.child.kill("SIGTERM");
    }, 1000);
    const kill = setTimeout(() => {
      this.child.kill("SIGKILL");
    }, 3000);
    const deadline = AbortSignal.timeout(8000);
    try {
      await wait(this.exited, deadline);
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }
}
