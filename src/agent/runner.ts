import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentSession,
  CreateAgentSessionRuntimeFactory,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  attachmentSchema,
  commandSchema,
  type Command,
  type Launch,
  type Result,
} from "./contracts.ts";
import { launchAt, missing, read, runDirectory, write } from "./storage.ts";
import { alive, ownIdentity, published, shellCommand, shells, signalProcess } from "./process.ts";
import { errorText, loadSDK } from "./host.ts";
import { childUsage } from "./usage.ts";
import { initializeCwd, localCwdOwner } from "./cwd.ts";
import { ActorObservation, type ObservationStats } from "./observation.ts";
import type { ToolEvent } from "./observation-state.ts";

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
function guard(pi: ExtensionAPI, directory: string, token: string): void {
  pi.on("tool_call", (event) => {
    if (event.toolName === "delegate" || event.toolName === "agent_runs") {
      return { block: true, reason: "Only a main session may delegate or control children." };
    }
    const owner = pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo;
    if (
      event.toolName === "bash" &&
      typeof event.input.command === "string" &&
      owner &&
      (owner.source === "builtin" || localCwdOwner(owner))
    ) {
      // Preserve the selected local owner's cwd/env and leave remote/custom tools alone.
      const input = event.input;
      input.command = shellCommand(event.input.command, directory, token);
    }
    return;
  });
}
class Actor {
  private active?: Promise<void>;
  private stopping = false;
  private stopDeadline?: NodeJS.Timeout;
  private nextParentCheck = 0;
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
  private createRuntime(
    sdk: Awaited<ReturnType<typeof loadSDK>>,
  ): CreateAgentSessionRuntimeFactory {
    return async ({ sessionManager }) => {
      const launch = this.initial;
      if (!fs.existsSync(launch.sessionFile)) {
        throw new Error("Missing saved native session; refusing to create another.");
      }
      const settingsManager = sdk.SettingsManager.create(launch.cwd, launch.agentDir, {
        projectTrusted: launch.trusted,
      });
      const services = await sdk.createAgentSessionServices({
        cwd: launch.cwd,
        agentDir: launch.agentDir,
        settingsManager,
        resourceLoaderOptions: {
          additionalExtensionPaths: [launch.entry],
          extensionFactories: [
            {
              name: "codemode",
              builtin: true,
              factory: sdk.createCodemodeExtension({ mode: "on" }),
            },
            { name: "tool_search", builtin: true, factory: sdk.createToolSearchExtension() },
            { name: "mcp", builtin: true, factory: sdk.createMcpExtension() },
            (pi) => {
              guard(pi, this.dir, this.token);
              pi.on("session_start", (_event, ctx) => {
                this.context = { pi, ctx };
              });
              // Sparse tool lifecycle keeps the live view's tools even while nobody watches.
              const tool = (event: ToolEvent): void => this.observation?.tool(event);
              pi.on("tool_execution_start", tool);
              pi.on("tool_execution_update", tool);
              pi.on("tool_execution_end", tool);
            },
          ],
        },
      });
      const diagnostics = services.resourceLoader.getExtensions().errors;
      if (diagnostics.length > 0) {
        throw new Error(`Child extension load failed: ${JSON.stringify(diagnostics)}`);
      }
      const model = services.modelRuntime.getModel(launch.provider, launch.model);
      if (!model) {
        throw new Error(
          `Saved model ${launch.provider}/${launch.model} is unavailable; no fallback was used.`,
        );
      }
      return {
        ...(await sdk.createAgentSessionFromServices({
          services,
          sessionManager,
          model,
          thinkingLevel: launch.thinking,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
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
  async serve(): Promise<void> {
    const sdk = await loadSDK(this.initial.sdk);
    let runtime: Awaited<ReturnType<typeof sdk.createAgentSessionRuntime>> | undefined;
    try {
      runtime = await sdk.createAgentSessionRuntime(this.createRuntime(sdk), {
        cwd: this.initial.cwd,
        agentDir: this.initial.agentDir,
        sessionManager: sdk.SessionManager.open(
          this.initial.sessionFile,
          undefined,
          this.initial.cwd,
        ),
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
      if (this.initial.name !== undefined) {
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
      process.on("SIGTERM", this.stop);
      process.on("SIGINT", this.stop);
      while (!this.shouldExit()) {
        if (!this.stopping) {
          this.pending().forEach((command) => this.accept(command));
        }
        // Durable command readiness, not elapsed time, defines admission.
        // oxlint-disable-next-line no-await-in-loop
        await delay(100);
      }
      await this.active;
    } catch (error) {
      this.failure(error);
    } finally {
      process.off("SIGTERM", this.stop);
      process.off("SIGINT", this.stop);
      const observation: ObservationStats | undefined = this.observation?.close();
      await runtime?.dispose();
      if (this.stopping) {
        this.stopShells("SIGKILL");
      }
      clearTimeout(this.stopDeadline);
      write(path.join(this.dir, `shutdown-${this.token}.json`), {
        at: Date.now(),
        errors: this.errors,
        ...(observation === undefined ? {} : { observation }),
      });
      // Keep the process claim until a launcher proves this exact actor is gone.
    }
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
