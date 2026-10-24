import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  actor,
  alive,
  ensureActor,
  ownIdentity,
  requestStop,
  signalProcess,
  stopChildren,
} from "./process.ts";
import { isChild, errorText } from "./host.ts";
import {
  delegateSchema,
  runsSchema,
  resultSchema,
  attachmentSchema,
  admissionSchema,
  commandSchema,
  type Attachment,
  type Launch,
  type ProcessIdentity,
  type Result,
  type DelegateInput,
  type RunsInput,
} from "./contracts.ts";
import {
  enqueue,
  latest,
  launchAt,
  list,
  read,
  runDirectory,
  ownerDirectory,
  conversation,
  write,
} from "./storage.ts";
import { notifications, deliver, settle } from "./notifications.ts";
import { prepareLaunch } from "./launch.ts";
import { toolResult, projection, render, summaries } from "./view.ts";
import { legacyNotifications } from "./legacy.ts";
import { savedContinuation } from "./saved.ts";
import { executionCwd } from "./cwd.ts";
import { getPiAgentDir } from "../pi-intercom/agent-dir.ts";
import { registerCompactMessages, renderCompactResult } from "../shared/compact-cards.ts";

/** Native fork lifetime owner (`ctx.managedHost`); read structurally so official Pi stays supported. */
interface ManagedHost {
  readonly owner: { readonly pid: number };
  readonly ready: Promise<boolean>;
}
/** `handoff` and `provisional` mean another worker under the same launcher may still own these children. */
function retainsChildren(event: object): boolean {
  const disposition: unknown = Reflect.get(event, "disposition");
  return disposition === "handoff" || disposition === "provisional";
}
function managedHost(context: ExtensionContext): ManagedHost | undefined {
  const host: unknown = Reflect.get(context, "managedHost");
  if (typeof host !== "object" || host === null) {
    return undefined;
  }
  const owner: unknown = Reflect.get(host, "owner");
  const pid: unknown =
    typeof owner === "object" && owner !== null ? Reflect.get(owner, "pid") : undefined;
  const ready: unknown = Reflect.get(host, "ready");
  return typeof pid === "number" && Number.isSafeInteger(pid) && ready instanceof Promise
    ? { owner: { pid }, ready: ready.then((accepted) => accepted === true) }
    : undefined;
}

class AgentRuntime {
  private ctx?: ExtensionContext;
  // A managed launcher owns children across worker replacement; otherwise this process does.
  private host?: ManagedHost;
  private accepted = false;
  private base = "";
  private owner = "";
  private generation = "";
  private timer?: NodeJS.Timeout;
  private closing = false;
  private reset: Promise<void> = Promise.resolve();
  private readonly shutdown = new AbortController();
  private readonly child = isChild();
  private readonly agentDir = path.resolve(getPiAgentDir());
  private readonly pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }
  private checkMain(): void {
    if (isChild()) {
      throw new Error("Only a main session may delegate or control agent runs.");
    }
    if (this.closing || !this.ctx || this.base.length === 0) {
      throw new Error("Agent runtime is not attached.");
    }
  }
  private readonly scan = (): void => {
    if (this.closing || !this.ctx || this.child) {
      return;
    }
    try {
      const notices = notifications(this.ctx, this.base, this.owner);
      try {
        notices.unshift(...legacyNotifications(this.ctx));
      } catch (error) {
        console.error(`Legacy completion reconciliation: ${errorText(error)}`);
      }
      deliver(this.pi, this.ctx, notices);
    } catch (error) {
      console.error(`Agent completion reconciliation: ${errorText(error)}`);
    }
  };
  private start(context: ExtensionContext): Promise<void> | undefined {
    this.host = managedHost(context);
    if (this.host === undefined || this.accepted || this.child) {
      this.reset = this.reset.then(() => this.attach(context));
      return this.reset;
    }
    // Attach and publish only after the launcher retires rollback: an unready replacement
    // must neither adopt children nor append completions to a journal it may abandon.
    // Readiness follows session_start, so never await it here.
    this.owner = context.sessionManager.getSessionId();
    this.base = ownerDirectory(this.agentDir, this.owner);
    this.host.ready
      .then(async (accepted) => {
        if (accepted && !this.closing) {
          this.accepted = true;
          await this.start(context);
        }
      })
      .catch((error: unknown) => {
        console.error(`Agent runtime attachment: ${errorText(error)}`);
      });
    return undefined;
  }
  private ownerIdentity(): Omit<ProcessIdentity, "token"> {
    return ownIdentity(this.host?.owner.pid);
  }
  private async attach(context: ExtensionContext): Promise<void> {
    clearInterval(this.timer);
    this.ctx = context;
    if (this.child) {
      return;
    }
    this.owner = context.sessionManager.getSessionId();
    this.base = ownerDirectory(this.agentDir, this.owner);
    this.generation = randomUUID();
    await fs.promises.mkdir(this.base, { recursive: true, mode: 0o700 });
    write(path.join(this.base, "attachment.json"), {
      ...this.ownerIdentity(),
      generation: this.generation,
      attached: true,
    });
    if (this.closing) {
      return;
    }
    this.timer = setInterval(this.scan, 200);
    this.timer.unref();
  }
  private async dispose(retain: boolean): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.reset;
    if (!retain && this.base.length > 0) {
      const file = path.join(this.base, "attachment.json");
      const attachment = read(file, attachmentSchema);
      if (attachment !== undefined && this.releases(attachment)) {
        write(file, {
          ...this.ownerIdentity(),
          generation: attachment.generation,
          attached: false,
        });
        await stopChildren(this.base, this.owner);
      }
    }
    this.ctx = undefined;
  }
  private releases(attachment: Attachment): boolean {
    if (attachment.generation === this.generation) {
      return true;
    }
    // An unready replacement never attached, but exiting still releases the launcher-owned children.
    return (
      this.generation.length === 0 && attachment.attached && attachment.pid === this.host?.owner.pid
    );
  }
  private stop(launch: Launch) {
    const base = this.base;
    const { targets: live, command: id } = requestStop(base, launch);
    if (live.length === 0) {
      return {
        ...projection(base, launch, this.ctx),
        stopAcknowledged: false,
        note: "No matching live actor or owned shell; process exit code remains unknown.",
      };
    }
    const escalation = setTimeout(() => {
      try {
        live.forEach((target) => {
          signalProcess(target, "SIGKILL");
        });
      } catch (error) {
        console.error(`Agent stop escalation: ${errorText(error)}`);
      }
    }, 3000);
    escalation.unref();
    return {
      ...projection(base, launch, this.ctx),
      stopRequest: id,
      stopAcknowledged: false,
      note: "Stop requested; neither native admission nor process exit is implied.",
    };
  }
  private async delegate(
    input: DelegateInput,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ) {
    this.checkMain();
    await this.reset;
    if (signal?.aborted === true) {
      throw new Error("Delegation cancelled before launch.");
    }
    const launch = await prepareLaunch({
      input,
      context,
      base: this.base,
      owner: this.owner,
      agentDir: this.agentDir,
      thinking: context.thinkingLevel ?? this.pi.getThinkingLevel(),
      executionCwd: executionCwd(this.pi, context),
    });
    this.checkMain();
    enqueue(this.base, launch, "run");
    await ensureActor(this.base, launch, this.shutdown.signal);
    return toolResult({
      ...projection(this.base, launch, this.ctx),
      receipt: "launch",
      note: "Launch accepted, not completion or native receipt publication. Completion arrives as a notification; do other work or end the turn instead of polling.",
    });
  }
  private list(input: RunsInput) {
    const all = list(this.base)
      .map((id) => launchAt(this.base, id, this.owner))
      .sort((a, b) => a.createdAt - b.createdAt);
    const offset = input.offset ?? 0;
    const page = summaries(this.base, all.slice(offset, offset + 50), this.ctx);
    return toolResult({
      runs: page,
      offset,
      nextOffset: offset + page.length < all.length ? offset + page.length : undefined,
      total: all.length,
    });
  }
  private successor(launch: Launch, prompt: string): Launch | undefined {
    const id = randomUUID();
    const next: Launch = { ...launch, id, predecessor: launch.id, prompt, createdAt: Date.now() };
    fs.mkdirSync(runDirectory(this.base, id), { mode: 0o700 });
    write(path.join(runDirectory(this.base, id), "launch.json"), next, true);
    try {
      write(path.join(runDirectory(this.base, launch.id), "successor.json"), { id }, true);
    } catch (error) {
      fs.rmSync(runDirectory(this.base, id), { recursive: true });
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      return undefined;
    }
    return next;
  }
  private continuationResult(launch: Launch): Result | "pending" | undefined {
    const result = read(path.join(runDirectory(this.base, launch.id), "result.json"), resultSchema);
    if (result) {
      return result;
    }
    const admission = read(
      path.join(conversation(this.base, launch), "admissions", `${launch.id}.json`),
      admissionSchema,
    );
    if (!admission || admission.id !== launch.id || admission.action !== "run") {
      return "pending";
    }
    return;
  }
  private async retryContinuation(launch: Launch, input: RunsInput) {
    const identity = actor(this.base, launch);
    const command = read(
      path.join(conversation(this.base, launch), "commands", `${launch.id}.json`),
      commandSchema,
    );
    if (
      input.prompt !== launch.prompt ||
      (identity && alive(identity)) ||
      command?.id !== launch.id ||
      command.runId !== launch.id ||
      command.action !== "run"
    ) {
      throw new Error(
        `Run ${launch.id} is awaiting native admission. Retry requires the exact saved prompt, its existing queued Run command, and no live actor. Missing commands or ambiguous process claims require inspection. Admission or a canonical result arrives without polling: end the turn or do other work until the completion notification, then inspect once before sending another prompt. No new continuation was launched.`,
      );
    }
    // Only an unadmitted durable command is retryable; keep all process/shell claim guards.
    await ensureActor(this.base, launch, this.shutdown.signal);
    return toolResult({ ...projection(this.base, launch, this.ctx), receipt: "continuation" });
  }
  private async continue(launch: Launch, input: RunsInput) {
    if (input.prompt === undefined) {
      throw new Error("continue requires the entire new prompt.");
    }
    if (!fs.existsSync(launch.sessionFile)) {
      throw new Error("Missing saved native session; no process was launched.");
    }
    const completed = this.continuationResult(launch);
    if (completed === "pending") {
      return this.retryContinuation(launch, input);
    }
    const identity = actor(this.base, launch);
    if (!completed && identity && alive(identity)) {
      const command = enqueue(this.base, launch, "steer", { prompt: input.prompt });
      return toolResult({
        ...projection(this.base, launch, this.ctx),
        receipt: "guidance",
        command,
        note: "Guidance queued, not actual completion or model consumption.",
      });
    }
    const next = this.successor(launch, input.prompt);
    if (!next) {
      return toolResult({
        ...projection(this.base, latest(this.base, launch), this.ctx),
        receipt: "existing-successor",
      });
    }
    // Retain successor claims on ambiguous after-launch failures: no replay.
    enqueue(this.base, next, "run");
    await ensureActor(this.base, next, this.shutdown.signal);
    return toolResult({ ...projection(this.base, next, this.ctx), receipt: "continuation" });
  }
  private async continueSaved(input: RunsInput & { id: string }, context: ExtensionContext) {
    if (input.prompt === undefined) {
      throw new Error("continue requires the entire new prompt.");
    }
    const { launch, created } = savedContinuation({
      id: input.id,
      prompt: input.prompt,
      context,
      base: this.base,
      agentDir: this.agentDir,
    });
    if (created) {
      // The durable adoption claim survives ambiguous after-launch failures.
      enqueue(this.base, launch, "run");
      await ensureActor(this.base, launch, this.shutdown.signal);
    }
    return toolResult({
      ...projection(this.base, launch, this.ctx),
      receipt: created ? "continuation" : "existing-successor",
    });
  }
  private async runs(input: RunsInput, context: ExtensionContext) {
    this.checkMain();
    await this.reset;
    if (input.action === "list") {
      return this.list(input);
    }
    this.scan();
    if (input.id === undefined) {
      throw new Error("id is required.");
    }
    if (
      input.action === "continue" &&
      !fs.existsSync(path.join(runDirectory(this.base, input.id), "launch.json"))
    ) {
      return this.continueSaved({ ...input, id: input.id }, context);
    }
    const original = launchAt(this.base, input.id, this.owner);
    if (input.action === "inspect") {
      return render(this.base, original, this.ctx, input);
    }
    const launch = latest(this.base, original);
    if (input.action === "stop") {
      return toolResult(this.stop(launch));
    }
    return this.continue(launch, input);
  }
  register(): void {
    registerCompactMessages(this.pi, ["agent-completion", "subagent-notify"]);
    this.pi.on("session_start", (_event, context) => this.start(context));
    this.pi.on("turn_end", (event, context) => {
      // The public pending flag covers user input; the preview also includes custom messages.
      settle(this.owner, context.hasPendingMessages() || event.context.pendingMessages.length > 0);
    });
    this.pi.on("agent_settled", () => {
      this.scan();
    });
    this.pi.on("session_shutdown", (event) =>
      this.dispose(event.reason === "reload" || retainsChildren(event)),
    );
    if (this.child) {
      this.pi.on("tool_call", (event) => {
        if (event.toolName === "delegate" || event.toolName === "agent_runs") {
          return { block: true, reason: "Only main sessions may delegate or control agent runs." };
        }
        return;
      });
    }
    const execute: ToolDefinition<typeof delegateSchema>["execute"] = (...args) =>
      this.delegate(args[1], args[2], args[4]);
    this.pi.registerTool({
      name: "delegate",
      label: "Delegate",
      description:
        "Launch one child with exactly the supplied prompt. Fresh context by default; fork preserves the full native conversation. Main sessions only. Returns an asynchronous launch receipt; completion arrives later as a notification, so do other work or end the turn instead of polling.",
      parameters: delegateSchema,
      exposure: this.child ? "hidden" : "direct",
      renderResult: renderCompactResult,
      execute,
    });
    const runs: ToolDefinition<typeof runsSchema>["execute"] = (...args) =>
      this.runs(args[1], args[4]);
    this.pi.registerTool({
      name: "agent_runs",
      label: "Agent runs",
      description:
        "List, inspect, continue, or stop this native main session's durable child runs. No action waits for child completion; completions arrive as notifications. Inspect is paged with byte offsets and never interrupts a child. Continue requires the complete new prompt, reuses the saved conversation and returns a guidance or continuation receipt.",
      parameters: runsSchema,
      exposure: this.child ? "hidden" : "direct",
      renderResult: renderCompactResult,
      execute: runs,
    });
  }
}
export default function agents(pi: ExtensionAPI): void {
  new AgentRuntime(pi).register();
}
