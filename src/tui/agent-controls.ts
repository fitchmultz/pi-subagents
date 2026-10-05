import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReadonlyInput, SubagentExecutionResult } from "../shared/types.ts";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { sendLiveSubagentMessage } from "../intercom/live-intercom.ts";
import { questionProcessAlive } from "../runs/shared/supervisor-questions.ts";
import { readableText, type AgentHistoryItem } from "./agent-history.ts";
import {
  short,
  resultText,
  UNAVAILABLE_ASSIGNMENT,
  PENDING_MESSAGE_NOTICE,
  type AgentTask,
  type AgentVisit,
  type Quote,
  type OutgoingMessage,
  type ExecuteControl,
} from "./view-model.ts";
import { AgentTaskStore } from "./task-store.ts";
import { ViewSession } from "./view-session.ts";
import { hasText, errorText } from "./text-values.ts";
const DIRECTION_MESSAGE = "subagent-human-direction";
interface ControlEffects {
  readonly execute: ExecuteControl;
  readonly changed: () => void;
  readonly save: () => void;
  readonly refreshSelected: (key: string) => void;
  readonly syncDraft: () => void;
}
interface SendDraft {
  readonly draft: string;
  readonly quote?: Quote;
  readonly text: string;
}
type SendGate =
  | { readonly kind: "send" }
  | { readonly kind: "ignore" }
  | { readonly kind: "notice"; readonly notice: NonNullable<AgentVisit["notice"]> };
function inactiveGate(task: Readonly<AgentTask>, explicit: boolean): SendGate {
  const liveQuestion = task.question !== undefined && questionProcessAlive(task.question);
  if (task.child.state !== "live" && !liveQuestion && !explicit) {
    return {
      kind: "notice",
      notice: { continue: task.child.state === "blocked" ? "blocked" : "finished" },
    };
  }
  if (
    !liveQuestion &&
    task.child.state !== "live" &&
    (task.child.missingSession === true || !hasText(task.child.sessionFile))
  ) {
    return {
      kind: "notice",
      notice: "The saved conversation is unavailable. No agent was started; your draft is kept.",
    };
  }
  if (explicit && task.child.state !== "live" && !task.child.launch) {
    return {
      kind: "notice",
      notice: `This older run has no saved profile. Inspect it, then use agent_runs continue with agent: ${JSON.stringify(task.child.agent)} to explicitly choose the current profile. Your draft is kept.`,
    };
  }
  return { kind: "send" };
}
function duplicateMessage(visit: ReadonlyInput<AgentVisit>, text: string): boolean {
  return visit.outbox.some(
    (sent) =>
      sent.status !== "unconfirmed" &&
      sent.text === text &&
      JSON.stringify(sent.quote) === JSON.stringify(visit.quote),
  );
}
function sendGate(
  task: Readonly<AgentTask>,
  visit: ReadonlyInput<AgentVisit>,
  text: string,
  explicit: boolean,
): SendGate {
  if (task.child.identityUnavailable === true) {
    return { kind: "notice", notice: UNAVAILABLE_ASSIGNMENT };
  }
  if (task.child.activity?.status === "pending") {
    return { kind: "ignore" };
  }
  const gate = inactiveGate(task, explicit);
  if (gate.kind !== "send") {
    return gate;
  }
  return !explicit && duplicateMessage(visit, text)
    ? { kind: "notice", notice: PENDING_MESSAGE_NOTICE }
    : { kind: "send" };
}
function stoppable(task: Readonly<AgentTask> | undefined): task is Readonly<AgentTask> {
  return (
    task !== undefined &&
    task.child.identityUnavailable !== true &&
    (task.child.state === "live" || task.question !== undefined) &&
    task.child.activity?.status !== "pending"
  );
}
/** Authoritative control, delivery receipts and busy locks are separate from browse-only history. */
export class AgentControls {
  private readonly busy = new Set<string>();
  private readonly pi: ExtensionAPI;
  private readonly store: AgentTaskStore;
  private readonly session: ViewSession;
  private readonly effects: ControlEffects;
  constructor(
    pi: ExtensionAPI,
    store: AgentTaskStore,
    session: ViewSession,
    effects: ControlEffects,
  ) {
    this.pi = pi;
    this.store = store;
    this.session = session;
    this.effects = effects;
  }
  isBusy(key: string): boolean {
    return this.busy.has(key);
  }
  private ready(key: string): boolean {
    return this.session.live() && !this.busy.has(key);
  }
  private breadcrumb(task: Readonly<AgentTask>, text: string, quote?: Quote): void {
    const label = short(task.label, 42);
    this.pi.sendMessage(
      {
        customType: DIRECTION_MESSAGE,
        display: true,
        content: `For context only: the user sent this directly to ${label} (run ${task.run.runId}, child ${task.child.index}). No relay or approval is needed.\n\n${text}${quote ? `\n\nRegarding ${quote.title}:\n${quote.text}` : ""}`,
        details: { label, text, quote, runId: task.run.runId, index: task.child.index },
      },
      { triggerTurn: false },
    );
  }
  async send(key: string, text: string, continueExplicitly = false): Promise<void> {
    if (!hasText(text.trim()) || !this.ready(key)) {
      return;
    }
    this.effects.refreshSelected(key);
    const task = this.store.task(key),
      visit = this.store.visit(key),
      generation = this.session.generation;
    if (!task) {
      return;
    }
    const gate = sendGate(task, visit, text, continueExplicitly);
    if (gate.kind !== "send") {
      if (gate.kind === "notice") {
        visit.notice = gate.notice;
        this.effects.changed();
      }
      return;
    }
    const draft = { draft: visit.draft, quote: visit.quote, text };
    this.busy.add(key);
    visit.notice = undefined;
    this.effects.changed();
    try {
      if (task.question || task.child.state !== "live") {
        await this.answerOrContinue(key, task, draft);
      } else {
        await this.deliver(key, task, draft);
      }
    } catch (error) {
      if (this.session.live(generation)) {
        visit.notice = `Message not confirmed; draft kept. ${errorText(error)}`;
      }
    } finally {
      this.finishControl(key, generation, true);
    }
  }
  private async answerOrContinue(
    key: string,
    task: Readonly<AgentTask>,
    draft: SendDraft,
  ): Promise<void> {
    const generation = this.session.generation,
      question = task.question,
      visit = this.store.visit(key);
    const message = `${draft.text}${draft.quote ? `\n\nRegarding ${draft.quote.title}:\n${draft.quote.text}` : ""}`;
    const result = await this.effects.execute(
      {
        action: question ? "answer" : "resume",
        id: task.run.runId,
        index: task.child.index,
        ...(question ? { questionId: question.questionId } : {}),
        message,
        messageOrigin: "human",
      },
      this.session.context(),
    );
    if (!this.session.live(generation)) {
      return;
    }
    visit.notice = this.answerNotice(result, question !== undefined);
    if (result.isError === true) {
      return;
    }
    if (visit.draft === draft.draft) {
      visit.draft = "";
      visit.quote = undefined;
    }
    visit.outbox = visit.outbox.filter((sent) => sent.draft !== draft.draft);
    this.breadcrumb(task, draft.text, draft.quote);
  }
  private answerNotice(result: SubagentExecutionResult, question: boolean): string {
    if (result.isError === true) {
      return resultText(result);
    }
    return question
      ? "Answer saved; waiting for the child. This is not proof it has acted."
      : "Continuation started on the saved conversation.";
  }
  private async deliver(key: string, task: Readonly<AgentTask>, draft: SendDraft): Promise<void> {
    const generation = this.session.generation,
      visit = this.store.visit(key);
    const sent: OutgoingMessage = {
      id: randomUUID(),
      runId: task.run.runId,
      index: task.child.index,
      text: draft.text,
      draft: draft.draft,
      quote: draft.quote,
      at: Date.now(),
      status: "sending",
    };
    visit.outbox.push(sent);
    visit.lastSentId = sent.id;
    this.effects.save();
    const receipt = await sendLiveSubagentMessage(this.pi.events, {
      to: resolveSubagentIntercomTarget(task.run.runId, task.child.agent, task.child.index),
      message: draft.text,
      delivery: "steer",
      timeoutMs: 15_000,
      signal: this.session.signal,
      extra: {
        messageId: sent.id,
        human: {
          ownerSessionId: this.session.context().sessionManager.getSessionId(),
          runId: task.run.runId,
          index: task.child.index,
        },
        ...(draft.quote
          ? {
              attachments: [
                { type: "context", name: draft.quote.title, content: draft.quote.text },
              ],
            }
          : {}),
      },
    });
    if (!this.session.live(generation)) {
      return;
    }
    const accepted = receipt.accepted === true || receipt.delivered === true;
    sent.status = accepted ? "waiting" : "unconfirmed";
    sent.reason = receipt.reason;
    if (accepted) {
      this.breadcrumb(task, draft.text, draft.quote);
    } else {
      visit.notice = `Delivery unconfirmed. Your draft is kept. ${receipt.reason ?? "Check the conversation before retrying."}`;
    }
  }
  private finishControl(key: string, generation: number, sending: boolean): void {
    if (!this.session.live(generation)) {
      return;
    }
    this.busy.delete(key);
    this.effects.refreshSelected(key);
    if (sending) {
      this.effects.syncDraft();
      this.effects.save();
    } else {
      this.effects.changed();
    }
  }
  async stop(key: string): Promise<void> {
    if (!this.ready(key)) {
      return;
    }
    this.effects.refreshSelected(key);
    const task = this.store.task(key);
    if (!stoppable(task)) {
      return;
    }
    const generation = this.session.generation;
    this.busy.add(key);
    try {
      const result = await this.effects.execute(
        { action: "interrupt", id: task.run.runId, index: task.child.index },
        this.session.context(),
      );
      if (this.session.live(generation)) {
        this.store.visit(key).notice =
          result.isError === true
            ? resultText(result)
            : "Stop requested for this child only. Independent siblings continue; dependent workflow steps may not run.";
      }
    } catch (error) {
      if (this.session.live(generation)) {
        this.store.visit(key).notice = `Stop not confirmed: ${errorText(error)}`;
      }
    } finally {
      this.finishControl(key, generation, false);
    }
  }
  async changes(key: string): Promise<AgentHistoryItem | undefined> {
    const task = this.store.task(key),
      generation = this.session.generation;
    if (!task || !this.session.live()) {
      return;
    }
    const cwd = task.child.launch?.cwd ?? task.run.cwd;
    const result = await this.pi.exec(
      "git",
      ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
      { cwd, timeout: 10_000, signal: this.session.signal },
    );
    if (!this.session.live(generation)) {
      return;
    }
    const diff = readableText(result.stdout);
    return {
      id: "working-tree-changes",
      kind: "change",
      title: `Working tree changes · ${cwd}`,
      timestamp: Date.now(),
      text: "This is the working tree, not a claim that this child made every change. Untracked files are not included; inspect write/tool results for their full content.",
      diff: result.code === 0 ? (hasText(diff) ? diff : "No tracked changes.") : undefined,
      details: result.code === 0 ? undefined : readableText(result.stderr),
    };
  }
  dispose(): void {
    this.busy.clear();
  }
}
