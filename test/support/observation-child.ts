import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  processSchema,
  resultSchema,
  type Launch,
  type ProcessIdentity,
  type Result,
} from "../../src/agent/contracts.ts";
import { loadSDK } from "../../src/agent/host.ts";
import { ensureActor, ownIdentity } from "../../src/agent/process.ts";
import { enqueue, ownerDirectory, read, runDirectory, write } from "../../src/agent/storage.ts";
import { record } from "./assertions.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
export const observationFixture = path.join(repo, "test/fixtures/observation-provider.ts");

export async function until(check: () => boolean, reason: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${reason}`);
    }
    // Poll actual durable publication or process death, not a readiness sleep.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}
export function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

export interface ObservedChildOptions {
  readonly sdk: string;
  readonly prompt: string;
  readonly gates?: readonly string[];
  /** Prepare the isolated root before the actor starts. */
  readonly before?: (root: string) => void;
}

/** A real detached native actor in a synthetic agent dir, driven only through durable files. */
export class ObservedChild {
  readonly root: string;
  readonly base: string;
  readonly launch: Launch;
  readonly directory: string;
  private readonly gates: readonly string[];
  private constructor(root: string, launch: Launch, gates: readonly string[]) {
    this.root = root;
    this.launch = launch;
    this.gates = gates;
    this.base = ownerDirectory(launch.agentDir, launch.owner);
    this.directory = runDirectory(this.base, launch.id);
  }
  static async start(options: ObservedChildOptions): Promise<ObservedChild> {
    // Unix socket paths are short; macOS tmpdir() is not.
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/pao-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: [observationFixture],
        defaultProjectTrust: "always",
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
    const sdk = await loadSDK(options.sdk);
    const owner = "observer-parent";
    const id = randomUUID();
    const directory = runDirectory(ownerDirectory(agentDir, owner), id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manager = sdk.SessionManager.create(cwd, directory);
    const sessionFile = manager.getSessionFile();
    if (sessionFile === undefined) {
      throw new Error("Native session did not allocate a file.");
    }
    fs.writeFileSync(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const launch: Launch = {
      version: 1,
      id,
      rootId: id,
      owner,
      cwd,
      agentDir,
      sdk: options.sdk,
      entry: path.join(repo, "src/agent/index.ts"),
      sessionFile,
      sessionId: manager.getSessionId(),
      prompt: options.prompt,
      context: "fresh",
      provider: "observation-fixture",
      model: "observation-model",
      thinking: "off",
      trusted: true,
      createdAt: Date.now(),
    };
    write(path.join(directory, "launch.json"), launch, true);
    const child = new ObservedChild(root, launch, options.gates ?? []);
    options.before?.(root);
    child.attach(true);
    await child.ensure();
    return child;
  }
  /** What a parent does before each command: start a generation unless one is alive. */
  async ensure(): Promise<void> {
    const previous = this.ready()?.token;
    // The detached actor copies this environment at spawn; the caller owns the runtime dir.
    const saved = { ...process.env };
    Object.assign(process.env, {
      PI_OFFLINE: "1",
      OBSERVATION_TEST_ROOT: this.root,
      OBSERVATION_GATES: this.gates.join(","),
    });
    try {
      await ensureActor(this.base, this.launch);
    } finally {
      for (const key of ["PI_OFFLINE", "OBSERVATION_TEST_ROOT", "OBSERVATION_GATES"]) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
    await until(() => (this.ready()?.token ?? previous) !== previous, "actor readiness");
  }
  attach(attached: boolean): void {
    write(path.join(this.base, "attachment.json"), {
      ...ownIdentity(),
      generation: "observation-test",
      attached,
    });
  }
  actor(): ProcessIdentity {
    const identity = read(path.join(this.directory, "actor.lock", "process.json"), processSchema);
    if (identity === undefined) {
      throw new Error("Actor claim is missing.");
    }
    return identity;
  }
  ready(): { readonly sessionId: string; readonly token: string } | undefined {
    const file = path.join(this.directory, "ready.json");
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const { sessionId, token } = record(JSON.parse(fs.readFileSync(file, "utf8")));
    if (typeof sessionId !== "string" || typeof token !== "string") {
      throw new Error("Malformed actor readiness.");
    }
    return { sessionId, token };
  }
  identity(): { token: string; rootId: string; sessionId: string; journal: string } {
    const ready = this.ready();
    if (ready === undefined) {
      throw new Error("Actor is not ready.");
    }
    return {
      token: ready.token,
      rootId: this.launch.rootId,
      sessionId: ready.sessionId,
      journal: this.launch.sessionFile,
    };
  }
  run(): void {
    enqueue(this.base, this.launch, "run");
  }
  file(name: string): string {
    return path.join(this.root, name);
  }
  async gate(name: string): Promise<Record<string, unknown>> {
    await until(() => fs.existsSync(this.file(`gate-${name}.json`)), `gate ${name}`);
    return record(JSON.parse(fs.readFileSync(this.file(`gate-${name}.json`), "utf8")));
  }
  release(name: string): void {
    fs.writeFileSync(this.file(`release-${name}`), "release");
  }
  async result(timeout = 120_000): Promise<Result> {
    const file = path.join(this.directory, "result.json");
    const { pid } = this.actor();
    const published = (): boolean => read(file, resultSchema) !== undefined;
    await until(() => published() || dead(pid), "native result", timeout);
    const result = read(file, resultSchema);
    if (result === undefined) {
      throw new Error(`Actor ${String(pid)} exited without a native result.`);
    }
    return result;
  }
  output(): string {
    return fs.readFileSync(path.join(this.directory, "output.txt"), "utf8");
  }
  /** Authoritative native journal records, parsed independently of the observation protocol. */
  journal(): Array<Record<string, unknown>> {
    return fs
      .readFileSync(this.launch.sessionFile, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => record(JSON.parse(line)));
  }
  listing(name: string): string[] {
    const directory = path.join(this.directory, name);
    return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  }
  /** Detach like an exiting main session; the actor stops itself. Returns its shutdown record. */
  async stop(): Promise<Record<string, unknown>> {
    const { pid, token } = this.actor();
    this.attach(false);
    try {
      await until(() => dead(pid), "actor exit after detachment", 30_000);
    } finally {
      if (!dead(pid)) {
        process.kill(-pid, "SIGKILL");
      }
    }
    return record(
      JSON.parse(fs.readFileSync(path.join(this.directory, `shutdown-${token}.json`), "utf8")),
    );
  }
  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
