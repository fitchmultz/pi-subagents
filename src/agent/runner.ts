import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandSchema, type Command, type Launch } from "./contracts.ts";
import { commandIdentity, launchAt, read, runDirectory, write } from "./storage.ts";
import { ownIdentity, shells, signalProcess } from "./process.ts";
import { ParentCheck } from "./parent-check.ts";
import { errorText, loadSDK } from "./host.ts";
import { Parking, type ParkOutcome, type Runtime } from "./parking.ts";
import { UsageIndex } from "./usage.ts";
import { initializeCwd } from "./cwd.ts";
import { childRuntime } from "./child-runtime.ts";
import { ActorObservation, type ObservationStats } from "./observation.ts";
import { BackgroundWait, endSession, reporting } from "./background-work.ts";
import { saveResult, saveTerminalResult } from "./run-result.ts";
import { DirectoryWatch, Wake } from "./wake.ts";
import { parkedToken } from "./generation.ts";

interface LiveActor {
  readonly session: AgentSession;
  readonly context: { readonly pi: ExtensionAPI; readonly ctx: ExtensionContext };
  readonly observation: ActorObservation;
}
type ActorPhase =
  | { readonly kind: "unopened" }
  | { readonly kind: "live"; readonly actor: LiveActor }
  | { readonly kind: "finished" };
type StopPhase =
  | { readonly kind: "active" }
  | { readonly kind: "stopping"; deadline?: NodeJS.Timeout; ended?: Promise<void> | undefined };
class Actor {
  private work:
    | { readonly kind: "idle" }
    | {
        readonly kind: "running";
        readonly launch: Launch;
        readonly task: Promise<void>;
        /** Set once the run stays open for the session's own background work. */
        wait?: BackgroundWait | undefined;
      } = { kind: "idle" };
  private phase: ActorPhase = { kind: "unopened" };
  private stopPhase: StopPhase = { kind: "active" };
  private nextParentCheck = 0;
  private parkOutcome: ParkOutcome = "resident";
  private readonly parent = new ParentCheck();
  // Raised when durable commands may need admission: change hints and stop.
  private readonly wake = new Wake();
  // A deferred run waits for an idle session, which has no command-file event.
  private deferredRun = false;
  private readonly errors: string[] = [];
  private readonly started = new Set<string>();
  // Actor-local validation metadata only; never retain command prompts or receipt authority.
  private readonly validated = new Map<string, { identity: string; id: string }>();
  private readonly accounting = new UsageIndex();
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
  private get stopping(): boolean {
    return this.stopPhase.kind === "stopping";
  }
  private get actor(): LiveActor | undefined {
    return this.phase.kind === "live" ? this.phase.actor : undefined;
  }
  private requireActor(): LiveActor {
    const actor = this.actor;
    if (!actor) {
      throw new Error("Native child session is not ready.");
    }
    return actor;
  }
  private readonly stop = (): void => {
    if (this.stopping) {
      return;
    }
    const actor = this.actor;
    const work = this.work;
    const ending: Extract<StopPhase, { kind: "stopping" }> = { kind: "stopping" };
    this.stopPhase = ending;
    this.wake.raise();
    write(path.join(this.dir, `stopping-${this.token}.json`), { at: Date.now() });
    write(path.join(this.dir, "stop-acknowledged.json"), {
      at: Date.now(),
      id: work.kind === "running" ? work.launch.id : undefined,
    });
    if (work.kind === "running") {
      work.wait?.end();
    }
    ending.ended = actor
      ? endSession(actor.session, (error) => {
          this.errors.push(errorText(error));
        })
      : undefined;
    this.stopShells("SIGTERM");
    // Parent death leaves no parent-side escalation timer to stop an uncooperative tool.
    ending.deadline = setTimeout(() => {
      this.stopShells("SIGKILL");
      process.exit(1);
    }, 3000);
    ending.deadline.unref();
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
    const { session } = this.requireActor();
    const baseline = new Set(session.sessionManager.getEntries().map((entry) => entry.id));
    const task = Promise.resolve().then(() => this.executeRun(launch, session, baseline));
    // executeRun saves its own failures; only a failing save rejects past it. That
    // rejection stays observed here even after the work slot returns to idle.
    const observed = task.catch((error: unknown) => this.observeBrokenRun(launch, error));
    this.work = { kind: "running", launch, task: observed };
    this.actor?.observation.working(true);
  }
  /** A run whose own save failed still ends with a terminal result and a recorded fault. */
  private observeBrokenRun(launch: Launch, error: unknown): void {
    this.errors.push(errorText(error));
    process.exitCode = 1;
    try {
      saveTerminalResult(this.base, launch, this.stopping, errorText(error));
    } catch (failure) {
      this.errors.push(errorText(failure));
    }
  }
  /** The refusal that must end an admitted run before its prompt, or undefined to start it. */
  private runRefusal(launch: Launch): string | undefined {
    if (
      launch.provider !== this.initial.provider ||
      launch.model !== this.initial.model ||
      launch.thinking !== this.initial.thinking
    ) {
      return "Continuation model snapshot changed unexpectedly.";
    }
    // Stop was admitted while this run was only scheduled; no prompt follows a stop.
    if (this.stopping) {
      return "Stopped before the run started; no prompt was submitted.";
    }
    return undefined;
  }
  private async executeRun(
    launch: Launch,
    session: AgentSession,
    baseline: ReadonlySet<string>,
  ): Promise<void> {
    const save = (error?: string): void => {
      const { accounting, stopping } = this;
      saveResult(this.base, launch, { session, baseline, accounting, stopping, error });
    };
    try {
      const refusal = this.runRefusal(launch);
      if (refusal !== undefined) {
        // The catch saves the refusal as the run's terminal result.
        throw new Error(refusal);
      }
      await session.prompt(launch.prompt, { expandPromptTemplates: false });
      if (!this.stopping && reporting(session)) {
        // The child's own background work can still wake it: its result is not final yet.
        // No await since the prompt: guidance for the now idle session always finds the wait.
        const wait = new BackgroundWait(
          session,
          path.join(runDirectory(this.base, launch.id), "waiting.json"),
        );
        const running = this.work;
        if (running.kind === "running" && running.launch.id === launch.id) {
          running.wait = wait;
        }
        await wait.settled();
      } else {
        await session.waitForIdle();
      }
      save();
    } catch (error) {
      save(errorText(error));
    } finally {
      this.work = { kind: "idle" };
      this.actor?.observation.working(false);
    }
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
    const { session } = this.requireActor();
    const receipt = path.join(this.dir, "admissions", `${command.id}.json`);
    const launch = this.commandLaunch(command);
    if (!launch) {
      return;
    }
    if (
      command.action === "run" &&
      (this.stopping || this.work.kind === "running" || !session.isIdle)
    ) {
      this.deferredRun = true;
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
    switch (command.action) {
      case "stop":
        return command.actorToken !== this.token;
      case "steer":
        // An idle session takes guidance only while its run waits on background work.
        return (
          this.work.kind !== "running" ||
          this.work.launch.id !== launch.id ||
          (session.isIdle && this.work.wait === undefined)
        );
      case "run":
        return false;
    }
  }
  private applyCommand(command: Command, launch: Launch, session: AgentSession): void {
    switch (command.action) {
      case "stop":
        this.stop();
        return;
      case "run":
        this.run(launch);
        return;
      case "steer":
        if (session.isIdle && this.work.kind === "running" && this.work.wait) {
          this.work.wait.guide(command.prompt);
          return;
        }
        // Synchronous native queue admission cannot turn into an idle prompt after an await.
        session.agent.steer({
          role: "user",
          content: [{ type: "text", text: command.prompt }],
          timestamp: Date.now(),
        });
    }
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
      // One observation at a time; a slow one keeps the regular schedule.
      const file = path.join(this.base, "attachment.json");
      this.parent.check(file, this.stop).catch((error: unknown) => {
        this.errors.push(errorText(error));
      });
    }
    return this.stopping && this.work.kind === "idle" && (this.actor?.session.isIdle ?? true);
  }
  /** Durable command readiness, not elapsed time, defines admission. */
  private async admitCommands(runtime: Runtime, parked: Parking): Promise<void> {
    // Queued commands create this directory; otherwise pending() does and the next pass arms.
    const directory = path.join(this.dir, "commands");
    const commands = new DirectoryWatch(directory, () => true, this.wake.raise);
    try {
      while (!this.shouldExit()) {
        // Each liveness tick also rechecks the directory for change hints the OS dropped.
        const watch = commands.ensure();
        if ((this.wake.take() || this.deferredRun || watch !== "watching") && !this.stopping) {
          this.deferredRun = false;
          this.pending().forEach((command) => this.accept(command));
        }
        if (await this.park(runtime, parked)) {
          return;
        }
        const polling = this.deferredRun || this.stopping || watch === "unwatched";
        const tick = Math.max(1, this.nextParentCheck - performance.now());
        await this.wake.sleep(polling ? 100 : tick);
      }
    } finally {
      // A verdict settling after the loop ends must not act.
      this.parent.cancel();
      commands.close();
    }
  }
  /** Parks a final-idle actor; the parent/stop owner stays live while preparation awaits. */
  private async park(runtime: Runtime, parked: Parking): Promise<boolean> {
    const owner = new AbortController();
    const actor = this.actor;
    const watch = setInterval(() => {
      if (this.shouldExit() || this.stopping) {
        owner.abort();
      }
    }, 100);
    try {
      this.parkOutcome = await parked.park(runtime, {
        signal: owner.signal,
        pi: actor?.context.pi,
        busy: this.stopping || this.work.kind === "running" || actor?.observation.watched === true,
        // Raced commands and viewers keep this actor resident; the loop admits after release.
        quiet: () => {
          const queued = this.pending().some((command) => this.commandLaunch(command));
          if (queued) {
            this.wake.raise();
          }
          const idle = this.work.kind === "idle" && !this.stopping;
          return !queued && idle && actor?.observation.watched !== true;
        },
        errors: this.errors,
      });
    } finally {
      clearInterval(watch);
    }
    return this.parkOutcome !== "resident";
  }
  private failure(error: unknown, unopened?: string): void {
    const launch = this.work.kind === "running" ? this.work.launch : this.initial;
    if (parkedToken(this.dir) !== undefined) {
      write(path.join(this.dir, `wake-failure-${this.token}.json`), {
        at: Date.now(),
        reason: errorText(error),
        ...(unopened !== undefined && parkedToken(this.dir) === unopened
          ? { beforeOpen: { actorToken: this.token, parkedToken: unopened } }
          : {}),
      });
    }
    saveTerminalResult(this.base, launch, this.stopping, errorText(error));
    process.exitCode = 1;
  }
  private async start(sdk: Awaited<ReturnType<typeof loadSDK>>, parked: Parking): Promise<Runtime> {
    const sessionManager = parked.open();
    let started: LiveActor["context"] | undefined;
    const factory = childRuntime(sdk, this.initial, {
      directory: this.dir,
      token: this.token,
      saved: parked.saved,
      started: (pi, ctx) => {
        started = { pi, ctx };
      },
      tool: (event) => this.actor?.observation.tool(event),
    });
    const runtime = await sdk.createAgentSessionRuntime(factory, {
      cwd: this.initial.cwd,
      agentDir: this.initial.agentDir,
      sessionManager,
    });
    try {
      // `session_start` fires during bindExtensions, after this call starts.
      await this.ready(runtime, parked, () => started);
    } catch (error) {
      // A runtime that never became ready is still disposed, so the failed actor exits.
      await runtime.dispose();
      throw error;
    }
    return runtime;
  }
  private async ready(
    runtime: Runtime,
    parked: Parking,
    started: () => LiveActor["context"] | undefined,
  ): Promise<void> {
    const { session } = runtime;
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        this.errors.push(error.error);
      },
    });
    const context = started();
    if (!context) {
      throw new Error("Child extension context is unavailable.");
    }
    initializeCwd(context.pi, context.ctx, this.initial.cwd, this.dir);
    if (this.initial.name !== undefined && !parked.saved) {
      session.sessionManager.appendSessionInfo(this.initial.name);
    }
    // Optional live view, bound before readiness; its faults never change native execution.
    const observation = await ActorObservation.open(session, {
      token: this.token,
      rootId: this.initial.rootId,
      sessionId: session.sessionManager.getSessionId(),
    });
    this.phase = { kind: "live", actor: { session, context, observation } };
    write(path.join(this.dir, "actor.lock", "process.json"), {
      ...ownIdentity(),
      token: this.token,
    });
    write(path.join(this.dir, "ready.json"), {
      pid: process.pid,
      token: this.token,
      sessionId: session.sessionManager.getSessionId(),
      at: Date.now(),
    });
    parked.adopt();
  }
  async serve(): Promise<void> {
    let runtime: Runtime | undefined;
    let parked: Parking | undefined;
    let parkedBeforeOpen: string | undefined;
    try {
      // Capture the old generation before SDK import or any native working-state operation.
      parkedBeforeOpen = parkedToken(this.dir);
      const sdk = await loadSDK(this.initial.sdk);
      parked = new Parking(this.base, this.initial, this.token, sdk);
      runtime = await this.start(sdk, parked);
      process.on("SIGTERM", this.stop);
      process.on("SIGINT", this.stop);
      await this.admitCommands(runtime, parked);
      if (this.work.kind === "running") {
        await this.work.task;
      }
    } catch (error) {
      this.failure(error, parked?.opened === true ? undefined : parkedBeforeOpen);
    } finally {
      await this.finish(runtime);
    }
  }
  private async finish(runtime: Runtime | undefined): Promise<void> {
    // Stop's cancellations need the session's job monitor, which disposal ends. The signal
    // handlers stay until then: the stopping parent's SIGTERM must not end this process first.
    const actor = this.actor;
    await (this.stopPhase.kind === "stopping" ? this.stopPhase.ended : undefined);
    process.off("SIGTERM", this.stop);
    process.off("SIGINT", this.stop);
    const observation: ObservationStats | undefined = actor?.observation.close();
    if (this.parkOutcome === "resident") {
      await runtime?.dispose();
    }
    if (this.stopping) {
      this.stopShells("SIGKILL");
    }
    clearTimeout(this.stopPhase.kind === "stopping" ? this.stopPhase.deadline : undefined);
    write(path.join(this.dir, `shutdown-${this.token}.json`), {
      at: Date.now(),
      errors: this.errors,
      ...(observation === undefined ? {} : { observation }),
    });
    this.phase = { kind: "finished" };
    if (this.parkOutcome !== "resident") {
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
