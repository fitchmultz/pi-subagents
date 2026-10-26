import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  attachmentSchema,
  commandSchema,
  type Command,
  type Launch,
  type Result,
} from "./contracts.ts";
import { launchAt, missing, read, runDirectory, write } from "./storage.ts";
import { alive, ownIdentity, published, shells, signalProcess } from "./process.ts";
import { errorText, loadSDK } from "./host.ts";
import { Parking, type Runtime } from "./parking.ts";
import { childUsage } from "./usage.ts";
import { initializeCwd } from "./cwd.ts";
import { childRuntime } from "./child-runtime.ts";
import { ActorObservation, type ObservationStats } from "./observation.ts";

function commandIdentity(file: string): string | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
}
function completionStatus(
  stopping: boolean,
  message: AssistantMessage | undefined,
  error: string | undefined,
): Result["status"] {
  if (stopping || message?.stopReason === "aborted") {
    return "stopped";
  }
  if (error !== undefined || !message || message.stopReason === "error") {
    return "failed";
  }
  return "completed";
}
class Actor {
  private active?: Promise<void>;
  private stopping = false;
  private stopDeadline?: NodeJS.Timeout;
  private nextParentCheck = 0;
  private parking = false;
  private current?: Launch;
  private readonly errors: string[] = [];
  private readonly started = new Set<string>();
  // Actor-local validation metadata only; never retain command prompts or receipt authority.
  private readonly validated = new Map<string, { identity: string; id: string }>();
  private session?: AgentSession;
  private observation?: ActorObservation;
  private context?: { pi: ExtensionAPI; ctx: ExtensionContext };
  private readonly base: string;
  private readonly initial: Launch;
  private readonly token: string;
  constructor(base: string, initial: Launch, token: string) {
    this.base = base;
    this.initial = initial;
    this.token = token;
  }
  private get dir(): string {
    return runDirectory(this.base, this.initial.rootId);
  }
  private response(baseline: ReadonlySet<string>) {
    const session = this.session;
    if (!session) {
      throw new Error("Native child session is not ready.");
    }
    const terminal = session.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          !baseline.has(entry.id) && entry.type === "message" && entry.message.role === "assistant",
      );
    if (terminal?.type !== "message" || terminal.message.role !== "assistant") {
      return;
    }
    return { id: terminal.id, message: terminal.message };
  }
  private saveResult(launch: Launch, baseline: ReadonlySet<string>, error?: string): void {
    const terminal = this.response(baseline);
    const message = terminal?.message;
    const accounting = this.usage(launch, baseline, terminal?.id);
    const output = this.output(message);
    const result: Result = {
      id: launch.id,
      owner: launch.owner,
      status: completionStatus(this.stopping, message, error),
      endedAt: Date.now(),
      terminalEntryId: accounting.accountingError === undefined ? terminal?.id : undefined,
      ...accounting,
      error:
        error ??
        message?.errorMessage ??
        (message ? undefined : "Native run produced no terminal assistant message."),
    };
    fs.writeFileSync(path.join(runDirectory(this.base, launch.id), "output.txt"), output, {
      mode: 0o600,
    });
    write(path.join(runDirectory(this.base, launch.id), "result.json"), result);
  }
  private usage(
    launch: Launch,
    baseline: ReadonlySet<string>,
    terminal?: string,
  ): Pick<Result, "contributions" | "accountingError" | "accountingPending"> {
    try {
      return { contributions: childUsage(launch, baseline, terminal) };
    } catch (error) {
      return {
        accountingError: errorText(error),
        ...(terminal !== undefined
          ? { accountingPending: { terminalCandidate: terminal, baseline: [...baseline] } }
          : {}),
      };
    }
  }
  private output(message: AssistantMessage | undefined): string {
    return (
      message?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") ?? ""
    );
  }
  private readonly stop = (): void => {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    write(path.join(this.dir, `stopping-${this.token}.json`), { at: Date.now() });
    write(path.join(this.dir, "stop-acknowledged.json"), { at: Date.now(), id: this.current?.id });
    this.session?.abort().catch((error: unknown) => {
      this.errors.push(errorText(error));
    });
    this.stopShells("SIGTERM");
    // Parent death leaves no parent-side escalation timer to stop an uncooperative tool.
    this.stopDeadline = setTimeout(() => {
      this.stopShells("SIGKILL");
      process.exit(1);
    }, 3000);
    this.stopDeadline.unref();
  };
  private stopShells(signal: NodeJS.Signals): void {
    try {
      for (const identity of shells(this.base, this.initial, this.token)) {
        try {
          signalProcess(identity, signal);
        } catch (error) {
          this.errors.push(errorText(error));
        }
      }
    } catch (error) {
      this.errors.push(errorText(error));
    }
  }
  private run(launch: Launch): void {
    const session = this.session;
    if (!session) {
      throw new Error("Native child session is not ready.");
    }
    this.current = launch;
    const baseline = new Set(session.sessionManager.getEntries().map((entry) => entry.id));
    this.observation?.working(true);
    this.active = (async () => {
      try {
        if (
          launch.provider !== this.initial.provider ||
          launch.model !== this.initial.model ||
          launch.thinking !== this.initial.thinking
        ) {
          throw new Error("Continuation model snapshot changed unexpectedly.");
        }
        await session.prompt(launch.prompt, { expandPromptTemplates: false });
        await session.waitForIdle();
        this.saveResult(launch, baseline);
      } catch (error) {
        this.saveResult(launch, baseline, errorText(error));
      } finally {
        this.active = undefined;
        this.current = undefined;
        this.observation?.working(false);
      }
    })();
  }
  private commandLaunch(command: Command): Launch | undefined {
    const receipt = path.join(this.dir, "admissions", `${command.id}.json`);
    if (fs.existsSync(receipt) || this.started.has(command.id)) {
      return undefined;
    }
    if (
      command.action === "run" &&
      fs.existsSync(path.join(runDirectory(this.base, command.runId), "successor.json"))
    ) {
      // A durable handoff supersedes even an unadmitted predecessor; never replay it.
      return undefined;
    }
    const launch = launchAt(this.base, command.runId, this.initial.owner);
    if (launch.rootId !== this.initial.rootId || launch.sessionFile !== this.initial.sessionFile) {
      throw new Error("Foreign conversation command.");
    }
    return launch;
  }
  private accept(command: Command): void {
    const session = this.session;
    if (!session) {
      throw new Error("Native child session is not ready.");
    }
    const receipt = path.join(this.dir, "admissions", `${command.id}.json`);
    const launch = this.commandLaunch(command);
    if (!launch) {
      return;
    }
    if (
      command.action === "run" &&
      (this.stopping || this.active !== undefined || !session.isIdle)
    ) {
      return;
    }
    this.started.add(command.id);
    const stale = this.staleCommand(command, launch, session);
    // This is queue admission, never a claim of native journal publication.
    write(
      receipt,
      {
        id: command.id,
        runId: launch.id,
        action: command.action,
        state: stale ? "stale" : "accepted",
        at: Date.now(),
      },
      true,
    );
    if (stale) {
      return;
    }
    this.applyCommand(command, launch, session);
  }
  private staleCommand(command: Command, launch: Launch, session: AgentSession): boolean {
    // Unbound legacy Stops cannot safely target this generation either.
    if (command.action === "stop") {
      return command.actorToken !== this.token;
    }
    return (
      command.action === "steer" &&
      (this.active === undefined || session.isIdle || this.current?.id !== launch.id)
    );
  }
  private applyCommand(command: Command, launch: Launch, session: AgentSession): void {
    if (command.action === "stop") {
      this.stop();
      return;
    }
    if (command.action === "run") {
      this.run(launch);
      return;
    }
    if (command.prompt === undefined) {
      throw new Error("Missing guidance.");
    }
    // Synchronous native queue admission cannot turn into an idle prompt after an await.
    session.agent.steer({
      role: "user",
      content: [{ type: "text", text: command.prompt }],
      timestamp: Date.now(),
    });
  }
  private pendingCommand(file: string): Command | undefined {
    const identity = commandIdentity(file);
    const cached = this.validated.get(file);
    if (
      identity !== undefined &&
      cached?.identity === identity &&
      fs.existsSync(path.join(this.dir, "admissions", `${cached.id}.json`))
    ) {
      return;
    }
    this.validated.delete(file);
    const command = read(file, commandSchema);
    // A replacement during validation must not inherit the old body's validated identity.
    if (command && identity !== undefined && commandIdentity(file) === identity) {
      this.validated.set(file, { identity, id: command.id });
    }
    return command;
  }
  private pending(): Command[] {
    const dir = path.join(this.dir, "commands");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => {
        const command = this.pendingCommand(path.join(dir, file));
        return command ? [command] : [];
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  private shouldExit(): boolean {
    const now = performance.now();
    if (!this.stopping && now >= this.nextParentCheck) {
      this.nextParentCheck = now + 1000;
      const file = path.join(this.base, "attachment.json");
      const attachment = published(file, read(file, attachmentSchema));
      if (attachment === undefined || !attachment.attached || !alive(attachment)) {
        this.stop();
      }
    }
    return this.stopping && this.active === undefined && (this.session?.isIdle ?? true);
  }
  private failure(error: unknown): void {
    const launch = this.current ?? this.initial;
    const result: Result = {
      id: launch.id,
      owner: launch.owner,
      status: this.stopping ? "stopped" : "failed",
      endedAt: Date.now(),
      error: errorText(error),
    };
    const directory = runDirectory(this.base, launch.id);
    if (!fs.existsSync(path.join(directory, "result.json"))) {
      fs.writeFileSync(path.join(directory, "output.txt"), "", { mode: 0o600 });
      write(path.join(directory, "result.json"), result);
    }
    process.exitCode = 1;
  }
  private async start(sdk: Awaited<ReturnType<typeof loadSDK>>, parked: Parking): Promise<Runtime> {
    const sessionManager = parked.open();
    const factory = childRuntime(sdk, this.initial, {
      directory: this.dir,
      token: this.token,
      saved: parked.saved,
      started: (pi, ctx) => {
        this.context = { pi, ctx };
      },
      tool: (event) => this.observation?.tool(event),
    });
    const runtime = await sdk.createAgentSessionRuntime(factory, {
      cwd: this.initial.cwd,
      agentDir: this.initial.agentDir,
      sessionManager,
    });
    this.session = runtime.session;
    await this.session.bindExtensions({
      mode: "print",
      onError: (error) => {
        this.errors.push(error.error);
      },
    });
    if (!this.context) {
      throw new Error("Child extension context is unavailable.");
    }
    initializeCwd(this.context.pi, this.context.ctx, this.initial.cwd, this.dir);
    if (this.initial.name !== undefined && !parked.saved) {
      this.session.sessionManager.appendSessionInfo(this.initial.name);
    }
    // Optional live view, bound before readiness; its faults never change native execution.
    this.observation = await ActorObservation.open(this.session, {
      token: this.token,
      rootId: this.initial.rootId,
      sessionId: this.session.sessionManager.getSessionId(),
    });
    write(path.join(this.dir, "actor.lock", "process.json"), {
      ...ownIdentity(),
      token: this.token,
    });
    write(path.join(this.dir, "ready.json"), {
      pid: process.pid,
      token: this.token,
      sessionId: this.session.sessionManager.getSessionId(),
      at: Date.now(),
    });
    parked.adopt();
    return runtime;
  }
  async serve(): Promise<void> {
    const sdk = await loadSDK(this.initial.sdk);
    const parked = new Parking(this.base, this.initial, this.token, sdk);
    let runtime: Runtime | undefined;
    try {
      runtime = await this.start(sdk, parked);
      process.on("SIGTERM", this.stop);
      process.on("SIGINT", this.stop);
      while (!this.shouldExit()) {
        if (!this.stopping) {
          this.pending().forEach((command) => this.accept(command));
        }
        // The parent/stop owner stays live while parking awaits the fence and native save.
        const owner = new AbortController();
        const watch = setInterval(() => {
          if (this.shouldExit() || this.stopping) {
            owner.abort();
          }
        }, 100);
        // oxlint-disable-next-line no-await-in-loop
        this.parking = await parked.park(runtime, {
          signal: owner.signal,
          pi: this.context?.pi,
          busy: this.stopping || this.active !== undefined || this.observation?.watched === true,
          // Commands and viewers that raced the fence or save keep this actor resident.
          admit: () => {
            this.pending().forEach((command) => this.accept(command));
            return (
              this.active === undefined && !this.stopping && this.observation?.watched !== true
            );
          },
          errors: this.errors,
        });
        clearInterval(watch);
        if (this.parking) {
          break;
        }
        // Durable command readiness, not elapsed time, defines admission.
        // oxlint-disable-next-line no-await-in-loop
        await delay(100);
      }
      await this.active;
    } catch (error) {
      this.failure(error);
    } finally {
      await this.finish(runtime);
    }
  }
  private async finish(runtime: Runtime | undefined): Promise<void> {
    process.off("SIGTERM", this.stop);
    process.off("SIGINT", this.stop);
    const observation: ObservationStats | undefined = this.observation?.close();
    if (!this.parking) {
      await runtime?.dispose();
    }
    if (this.stopping) {
      this.stopShells("SIGKILL");
    }
    clearTimeout(this.stopDeadline);
    write(path.join(this.dir, `shutdown-${this.token}.json`), {
      at: Date.now(),
      errors: this.errors,
      ...(observation === undefined ? {} : { observation }),
    });
    if (this.parking) {
      // Parked authority requires actual exit; no leftover extension handle may keep it alive.
      process.exit();
    }
    // Keep the process claim until a launcher proves this exact actor is gone.
  }
}
const base = process.argv.at(2);
const rootId = process.argv.at(3);
const token = process.argv.at(4);
const firstId = process.argv.at(5);
if (base === undefined || rootId === undefined || token === undefined || firstId === undefined) {
  throw new Error("Expected saved conversation and actor claim.");
}
await new Actor(base, launchAt(base, firstId, path.basename(base)), token).serve();
