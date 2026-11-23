import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as loadedSDK from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  inspectActorClaim,
  possiblyLive,
  ensureActor,
  ownIdentity,
  parkFailure,
} from "./process.ts";
import { stopChildren, stopRun } from "./shutdown.ts";
import {
  publishAttachment,
  releasesAttachment,
  type AttachmentBinding,
  type AttachmentState,
} from "./attachment.ts";
import { isChild, errorText, managedHost, rememberSDK, retainsChildren } from "./host.ts";
import { serveParked } from "./parking.ts";
import { attachmentSchema, commandSchema, type Launch } from "./contracts.ts";
import { registerAgentTools, type DelegateInput, type RunsInput } from "./tool-schemas.ts";
import {
  enqueue,
  latest,
  launchAt,
  list,
  read,
  runDirectory,
  ownerDirectory,
  conversation,
  successor,
  write,
} from "./storage.ts";
import { notifications, deliver, settle } from "./notifications.ts";
import { prepareLaunch } from "./launch.ts";
import { renderReceipt, renderInventory, renderInspection } from "./view.ts";
import { legacyInputDirectories, reconcileLegacy } from "./legacy.ts";
import { pathStamp } from "./wake.ts";
import { CompletionWatches } from "./completion-watches.ts";
import { savedContinuation } from "./saved.ts";
import { continuationDecision, readRunState, runEscalation } from "./run-state.ts";
import { registerSubagentBackgroundWork } from "./background-work.ts";
import { executionCwd } from "./cwd.ts";
import { getPiAgentDir } from "../pi-intercom/agent-dir.ts";
import { registerCompactMessages } from "../shared/compact-cards.ts";
import { BackgroundReporter } from "../shared/background-reporting.ts";
import { CompletionSchedule } from "./completion-schedule.ts";
import { notifyInventory } from "./inventory-events.ts";
import { OverseerController } from "./overseer.ts";
import { resolveActiveEscalation } from "./overseer-pause.ts";

class AgentRuntime {
  private attachment: AttachmentState = { kind: "detached" };
  private readonly reporter = new BackgroundReporter(() => this.ctx);
  private readonly watches: CompletionWatches;
  private readonly schedule = new CompletionSchedule(
    () => this.scan(),
    () => this.recover(),
  );
  private awaited: ReadonlySet<string> = new Set();
  private observed = new Map<string, string>();
  private attachmentTail: Promise<void> = Promise.resolve();
  private readonly shutdown = new AbortController();
  private readonly child = isChild();
  private readonly agentDir = path.resolve(getPiAgentDir());
  private readonly pi: ExtensionAPI;
  private readonly overseer: OverseerController;
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.watches = new CompletionWatches(this.reporter, this.wake);
    this.overseer = new OverseerController(pi, () =>
      this.attachment.kind === "attached" ? this.base : undefined,
    );
  }
  private get binding(): AttachmentBinding {
    if (this.attachment.kind === "detached") {
      throw new Error("Agent runtime is not attached.");
    }
    return this.attachment.binding;
  }
  private get ctx(): ExtensionContext | undefined {
    return this.attachment.kind === "attaching" ||
      this.attachment.kind === "attached" ||
      this.attachment.kind === "failed"
      ? this.attachment.binding.context
      : undefined;
  }
  private get stopping(): boolean {
    return this.shutdown.signal.aborted;
  }
  private get base(): string {
    return this.binding.base;
  }
  private get owner(): string {
    return this.binding.owner;
  }
  private checkMain(): void {
    if (isChild()) {
      throw new Error("Only a main session may delegate or control agent runs.");
    }
    if (this.stopping || this.attachment.kind !== "attached") {
      throw new Error("Agent runtime is not attached.");
    }
  }
  private async attachedOwner(): Promise<{ readonly base: string; readonly owner: string }> {
    this.checkMain();
    await this.attachmentTail;
    this.checkMain();
    return { base: this.base, owner: this.owner };
  }
  private refuseIfAborted(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted === true) {
      throw new Error(message);
    }
  }
  private readonly wake = (): void => this.schedule.wake();
  private readonly recover = (): void => {
    for (const [file, seen] of this.observed) {
      if (pathStamp(file) !== seen) {
        this.wake();
        return;
      }
    }
  };
  private readonly scan = (): void => {
    this.schedule.cancelPoll();
    if (this.stopping || this.attachment.kind !== "attached" || this.child) {
      return;
    }
    const { context } = this.attachment.binding;
    const inputs = () => [this.base, ...legacyInputDirectories(), ...this.awaited];
    const before = new Map(inputs().map((file) => [file, pathStamp(file)]));
    let reconciled = true;
    try {
      const { notices, awaited } = notifications(context, this.base, this.owner);
      this.awaited = awaited;
      notices.unshift(...reconcileLegacy(context, this.reporter));
      deliver(this.pi, context, notices);
      if (notices.length > 0) {
        notifyInventory(this.base);
      }
      this.reporter.recover("completion-scan");
    } catch (error) {
      reconciled = false;
      this.reporter.report(
        "completion-scan",
        `Agent completion reconciliation: ${errorText(error)}`,
      );
    }
    this.observed = new Map(inputs().map((file) => [file, before.get(file) ?? ""]));
    const next = this.watches.update(this.base, legacyInputDirectories(), this.awaited);
    if (!reconciled || next === "poll") {
      this.schedule.pollIn(200);
    } else if (next === "rescan") {
      this.wake();
    }
  };
  private unwatch(): void {
    this.schedule.cancel();
    this.observed.clear();
    this.watches.close();
    this.awaited = new Set();
  }
  private start(context: ExtensionContext): Promise<void> | undefined {
    if (this.stopping) {
      return;
    }
    this.reporter.start();
    const owner = context.sessionManager.getSessionId();
    const host = managedHost(context);
    const binding = { context, owner, base: ownerDirectory(this.agentDir, owner), host };
    if (
      host === undefined ||
      this.attachment.kind === "attached" ||
      this.attachment.kind === "attaching" ||
      this.child
    ) {
      return this.queueAttachment(binding);
    }
    const waiting: AttachmentState = { kind: "waiting", binding };
    this.attachment = waiting;
    host.ready
      .then((accepted) => {
        if (accepted && !this.stopping && this.attachment === waiting) {
          return this.queueAttachment(binding);
        }
        return null;
      })
      .catch((error: unknown) => {
        this.reporter.report(undefined, `Agent runtime attachment: ${errorText(error)}`);
      });
    return undefined;
  }
  private queueAttachment(binding: AttachmentBinding): Promise<void> {
    const attempt = this.attachmentTail.then(() => this.attach(binding));
    this.attachmentTail = attempt.catch(() => {
      // The caller receives this attempt's failure; later lifecycle work only joins settlement.
    });
    return attempt;
  }
  private async attach(binding: AttachmentBinding): Promise<void> {
    this.unwatch();
    const attaching: AttachmentState = { kind: "attaching", binding, generation: randomUUID() };
    this.attachment = attaching;
    try {
      if (this.child) {
        this.attachment = { ...attaching, kind: "attached" };
        return;
      }
      await fs.promises.mkdir(binding.base, { recursive: true, mode: 0o700 });
      publishAttachment(binding.base, ownIdentity(binding.host?.owner.pid), attaching.generation);
      if (this.stopping) {
        return;
      }
      this.attachment = { ...attaching, kind: "attached" };
      this.overseer.publishLive(binding.base);
      this.schedule.pollIn(200);
      this.schedule.probeIn(1000);
    } catch (error) {
      this.attachment = { ...attaching, kind: "failed" };
      throw error;
    }
  }
  private async dispose(retain: boolean): Promise<void> {
    this.reporter.shutdown();
    this.unwatch();
    this.shutdown.abort();
    try {
      await this.attachmentTail;
      if (!retain && !this.child && this.attachment.kind !== "detached") {
        const file = path.join(this.base, "attachment.json");
        const attachment = read(file, attachmentSchema);
        if (attachment !== undefined && releasesAttachment(this.attachment, attachment)) {
          write(file, {
            ...ownIdentity(this.binding.host?.owner.pid),
            generation: attachment.generation,
            attached: false,
          });
          await stopChildren(this.base, this.owner, (message) =>
            this.reporter.report(undefined, message),
          );
        }
      }
    } finally {
      this.attachment = { kind: "detached" };
    }
  }
  private stop(launch: Launch) {
    return stopRun(this.base, launch, this.ctx, (message) =>
      this.reporter.report(undefined, message),
    );
  }
  private async delegate(
    input: DelegateInput,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ) {
    await this.attachedOwner();
    this.refuseIfAborted(signal, "Delegation cancelled before launch.");
    const prepared = this.overseer.prepareDelegation(input);
    const launch = await prepareLaunch({
      input,
      context,
      base: this.base,
      owner: this.owner,
      agentDir: this.agentDir,
      thinking: context.thinkingLevel ?? this.pi.getThinkingLevel(),
      executionCwd: executionCwd(this.pi, context),
      ...prepared,
    });
    this.checkMain();
    enqueue(this.base, launch, { action: "run" });
    this.refuseIfAborted(signal, "Delegation cancelled after preparation; no run was started.");
    await ensureActor(this.base, launch, this.shutdown.signal);
    return renderReceipt(this.base, launch, this.ctx, {
      receipt: "launch",
      note: "Launch accepted, not completion or native receipt publication. Completion arrives as a notification; do other work or end the turn instead of polling.",
    });
  }
  private async retryContinuation(launch: Launch, input: RunsInput) {
    const claim = inspectActorClaim(this.base, launch);
    const command = read(
      path.join(conversation(this.base, launch), "commands", `${launch.id}.json`),
      commandSchema,
    );
    if (
      input.prompt !== launch.prompt ||
      possiblyLive(claim) ||
      command?.id !== launch.id ||
      command.runId !== launch.id ||
      command.action !== "run"
    ) {
      throw new Error(
        `Run ${launch.id} is awaiting native admission. Retry requires the exact saved prompt, its existing queued Run command, and no live actor. Missing commands or ambiguous process claims require inspection. Admission or a canonical result arrives without polling: end the turn or do other work until the completion notification, then inspect once before sending another prompt. No new continuation was launched.`,
      );
    }
    await ensureActor(this.base, launch, this.shutdown.signal);
    return renderReceipt(this.base, launch, this.ctx, { receipt: "continuation" });
  }
  private activeOverseerLaunch() {
    return this.overseer.current.enabled
      ? { enabled: true as const, judge: this.overseer.current.judge }
      : undefined;
  }
  private continuePausedCheckpoint(launch: Launch, prompt: string | undefined) {
    const trimmed = prompt?.trim();
    const steer =
      trimmed !== undefined && trimmed.length > 0
        ? { id: randomUUID(), prompt: trimmed }
        : undefined;
    const released = resolveActiveEscalation(this.base, launch, "approved", steer);
    if (released === undefined) {
      return;
    }
    if (steer !== undefined) {
      enqueue(this.base, launch, { action: "steer", prompt: steer.prompt, id: steer.id });
    }
    notifyInventory(this.base, launch.id);
    if (steer !== undefined) {
      return renderReceipt(this.base, launch, this.ctx, {
        receipt: "guidance",
        command: steer.id,
        note: "Checkpoint released with steering correction queued (queue acceptance is not actual completion or model consumption).",
      });
    }
    return renderReceipt(this.base, launch, this.ctx, {
      receipt: "checkpoint-approved",
      note: "Checkpoint approved; child released to continue.",
    });
  }
  private continueLiveGuidance(launch: Launch, prompt: string | undefined) {
    if (runEscalation(this.base, launch, "running") !== undefined) {
      const receipt = this.continuePausedCheckpoint(launch, prompt);
      if (receipt !== undefined) {
        return receipt;
      }
    }
    if (prompt === undefined) {
      throw new Error(
        "continue requires the entire new prompt (only paused checkpoints may omit prompt).",
      );
    }
    const command = enqueue(this.base, launch, { action: "steer", prompt });
    return renderReceipt(this.base, launch, this.ctx, {
      receipt: "guidance",
      command,
      note: "Guidance queued, not actual completion or model consumption.",
    });
  }
  private async continue(launch: Launch, input: RunsInput) {
    if (!fs.existsSync(launch.sessionFile)) {
      throw new Error("Missing saved native session; no process was launched.");
    }
    const state = readRunState(this.base, launch);
    if (state.kind === "saved-unadmitted") {
      if (input.prompt === undefined) {
        throw new Error("continue requires the entire new prompt.");
      }
      return this.retryContinuation(launch, input);
    }
    const claim = state.kind === "admitted" ? inspectActorClaim(this.base, launch) : undefined;
    if (continuationDecision(state, possiblyLive(claim)) === "guidance") {
      return this.continueLiveGuidance(launch, input.prompt);
    }
    if (input.prompt === undefined) {
      throw new Error("continue requires the entire new prompt.");
    }
    parkFailure(this.base, launch);
    const next = successor(this.base, launch, input.prompt, {
      overseer: this.activeOverseerLaunch() ?? null,
    });
    if (!next) {
      return renderReceipt(this.base, latest(this.base, launch), this.ctx, {
        receipt: "existing-successor",
      });
    }
    enqueue(this.base, next, { action: "run" });
    await ensureActor(this.base, next, this.shutdown.signal);
    return renderReceipt(this.base, next, this.ctx, { receipt: "continuation" });
  }
  private async continueSaved(input: RunsInput & { id: string }, context: ExtensionContext) {
    if (input.prompt === undefined) {
      throw new Error("continue requires the entire new prompt.");
    }
    const { launch, kind } = savedContinuation({
      id: input.id,
      prompt: input.prompt,
      overseer: this.activeOverseerLaunch(),
      context,
      base: this.base,
      agentDir: this.agentDir,
    });
    if (kind === "created") {
      enqueue(this.base, launch, { action: "run" });
      await ensureActor(this.base, launch, this.shutdown.signal);
    }
    return renderReceipt(this.base, launch, this.ctx, {
      receipt: kind === "created" ? "continuation" : "existing-successor",
    });
  }
  private async runs(input: RunsInput, context: ExtensionContext) {
    await this.attachedOwner();
    if (input.action === "list") {
      const all = list(this.base).map((id) => launchAt(this.base, id, this.owner));
      return renderInventory(this.base, all, this.ctx, input);
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
      return renderInspection(this.base, original, this.ctx, input);
    }
    const launch = latest(this.base, original);
    if (input.action === "stop") {
      return this.stop(launch);
    }
    return this.continue(launch, input);
  }
  register(): void {
    registerCompactMessages(this.pi, [
      "agent-completion",
      "agent-escalation",
      "overseer-note",
      "subagent-notify",
    ]);
    if (!this.child) {
      this.overseer.register();
    }
    serveParked(
      this.pi,
      () => (this.child || !this.ctx ? undefined : { base: this.base, owner: this.owner }),
      this.shutdown.signal,
    );
    this.pi.on("session_start", (_event, context) => this.start(context));
    this.pi.on("turn_end", (event, context) => {
      if (
        this.attachment.kind === "attached" &&
        settle(this.owner, context.hasPendingMessages() || event.context.pendingMessages.length > 0)
      ) {
        this.wake();
      }
    });
    this.pi.on("agent_settled", () => this.scan());
    this.pi.on("session_shutdown", (event) =>
      this.dispose(event.reason === "reload" || retainsChildren(event)),
    );
    registerSubagentBackgroundWork(this.pi, () => {
      if (
        this.child ||
        this.stopping ||
        this.attachment.kind === "detached" ||
        this.attachment.kind === "failed"
      ) {
        return;
      }
      const { base, owner, context, host } = this.attachment.binding;
      return {
        base,
        owner,
        sessionManager: context.sessionManager,
        survivesRestart: host !== undefined,
        stop: (launch) => {
          if (!this.stopping && this.attachment.kind !== "detached") {
            this.stop(launch);
          }
        },
      };
    });
    if (this.child) {
      this.pi.on("tool_call", (event) => {
        if (event.toolName === "delegate" || event.toolName === "agent_runs") {
          return { block: true, reason: "Only main sessions may delegate or control agent runs." };
        }
        return;
      });
    }
    registerAgentTools(
      this.pi,
      this.child,
      (...args) => this.delegate(args[1], args[2], args[4]),
      (...args) => this.runs(args[1], args[4]),
    );
  }
}
export default function agents(pi: ExtensionAPI): void {
  rememberSDK(loadedSDK);
  new AgentRuntime(pi).register();
}
