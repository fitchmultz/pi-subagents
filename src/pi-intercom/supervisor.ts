import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import type { Message, SendResult } from "./types.ts";
import type { IntercomLifecycle } from "./lifecycle.ts";
import { resolveConnectedTarget, type IntercomConnection } from "./connection.ts";
import type { ReplyWait } from "./reply-wait.ts";
import type {
  ChildOrchestratorMetadata,
  ContactSupervisorToolParams,
  ToolResultLike,
} from "./runtime-types.ts";
import { formatChildOrchestratorMessage } from "./identity.ts";
import {
  formatSupervisorInterviewRequest,
  parseStructuredSupervisorReply,
  validateSupervisorInterviewRequest,
  type SupervisorInterviewRequest,
} from "./interview.ts";
import { errorMessage } from "./validation.ts";
import { formatAttachments } from "./message-format.ts";
import { toolError, toolText } from "./tool-arguments.ts";
import {
  createSupervisorQuestion,
  readQuestionState,
  recordQuestionDelivery,
  type SupervisorQuestion,
} from "../runs/shared/supervisor-questions.ts";
import { formatRunAction } from "../shared/status-format.ts";

type Lifecycle = Readonly<Pick<IntercomLifecycle, "identity" | "markActivity">>;
type Connection = Readonly<Pick<IntercomConnection, "ensure" | "syncIdentity" | "syncStatus">>;
type ReplyWaitHandle = Readonly<
  Pick<ReplyWait, "clearRetry" | "isWaitingFor" | "retarget" | "retry" | "wait" | "waiting">
>;

interface SupervisorOwners {
  readonly pi: ExtensionAPI;
  readonly lifecycle: Lifecycle;
  readonly connection: Connection;
  readonly wait: ReplyWaitHandle;
}
interface DecisionRequest {
  readonly reason: "need_decision" | "interview_request";
  readonly message?: string;
  readonly interview?: SupervisorInterviewRequest;
  readonly signal?: AbortSignal;
  readonly ctx: ExtensionContext;
}
interface Notification {
  readonly question: ReadonlyInput<SupervisorQuestion>;
  readonly text: string;
  readonly reason: DecisionRequest["reason"];
}
function validateContact(params: ContactSupervisorToolParams): ToolResultLike | undefined {
  const { reason, message } = params;
  if (!["need_decision", "progress_update", "interview_request"].includes(reason)) {
    return toolError(
      "Invalid reason. Use 'need_decision', 'interview_request', or 'progress_update'.",
    );
  }
  if ((reason === "need_decision" || reason === "progress_update") && typeof message !== "string") {
    return toolError(`Missing 'message' parameter for reason '${reason}'.`);
  }
  return;
}
function replyDetails(
  questionId: string,
  text: string,
  interview: SupervisorInterviewRequest | undefined,
): Readonly<Record<string, unknown>> {
  const structured = interview ? parseStructuredSupervisorReply(text, interview) : undefined;
  if (structured?.value) {
    return { questionId, structuredReply: structured.value };
  }
  if (structured?.error !== undefined && structured.error !== "") {
    return { questionId, structuredReplyParseError: structured.error };
  }
  return { questionId };
}
/** Owns durable supervisor questions and every wake-notification attempt. */
export class IntercomSupervisor {
  private readonly owners: SupervisorOwners;
  private readonly metadata: ChildOrchestratorMetadata;
  private readonly notifications = new Set<Promise<void>>();
  constructor(owners: SupervisorOwners, metadata: ChildOrchestratorMetadata) {
    this.owners = owners;
    this.metadata = metadata;
  }
  async drain(): Promise<void> {
    await Promise.allSettled(this.notifications);
  }
  private createQuestion(request: DecisionRequest): {
    readonly question: ReadonlyInput<SupervisorQuestion>;
    readonly text: string;
  } {
    const { reason, interview, ctx } = request;
    const body = interview
      ? formatSupervisorInterviewRequest(interview, request.message)
      : (request.message ?? "");
    const metadata = this.metadata;
    const question = createSupervisorQuestion({
      runId: metadata.runId,
      ownerTarget: metadata.orchestratorTarget,
      agent: metadata.agent,
      index: Number(metadata.index),
      childSessionId: ctx.sessionManager.getSessionId(),
      childTarget:
        metadata.sessionName ??
        this.owners.lifecycle.identity(ctx.sessionManager.getSessionId()).name,
      sessionFile: ctx.sessionManager.getSessionFile() ?? "",
      cwd: ctx.cwd,
      pid: process.pid,
      reason,
      message: body,
      ...(interview ? { interview } : {}),
    });
    const text = formatChildOrchestratorMessage(
      interview ? "interview" : "ask",
      metadata,
      [
        `Question ID: ${question.questionId}`,
        `Answer after reconnect/reload: ${formatRunAction("answer", question.runId, { questionId: question.questionId, message: "..." }, Number(process.env.PI_SUBAGENT_DEPTH) > 1)}`,
        body,
      ].join("\n"),
    );
    return { question, text };
  }
  private ownNotification(operation: () => Promise<void>): void {
    const task = Promise.resolve().then(operation);
    this.notifications.add(task);
    task
      .then(
        () => {
          this.notifications.delete(task);
        },
        (error: unknown) => {
          this.notifications.delete(task);
          console.error("Intercom supervisor notification failed:", error);
        },
      )
      .catch((error: unknown) => {
        console.error("Intercom supervisor notification cleanup failed:", error);
      });
  }
  private scheduleNotification(notification: Notification): void {
    let retryAfter = 0;
    let failureLogged = false;
    const { question, text, reason } = notification;
    const active = () => this.owners.wait.isWaitingFor(question.questionId);
    const logFailure = (error: unknown) => {
      if (active() && !failureLogged) {
        this.owners.pi.appendEntry("intercom_question_notification_error", {
          questionId: question.questionId,
          error: errorMessage(error),
        });
        failureLogged = true;
      }
    };
    const recordNotification = (to: string, sent: SendResult) => {
      if (sent.accepted || !failureLogged) {
        this.owners.pi.appendEntry("intercom_sent", {
          to,
          messageId: question.questionId,
          message: { text, reason },
          accepted: sent.accepted,
          timestamp: Date.now(),
        });
      }
      failureLogged ||= !sent.accepted;
    };
    const notify = async () => {
      if (!active() || Date.now() < retryAfter) {
        return;
      }
      this.owners.wait.clearRetry(question.questionId);
      let retry = true;
      try {
        const client = await this.owners.connection.ensure("tool");
        if (!active()) {
          return;
        }
        const to =
          (await resolveConnectedTarget(client, this.metadata.orchestratorTarget)) ??
          this.metadata.orchestratorTarget;
        if (!active()) {
          return;
        }
        this.owners.wait.retarget(question.questionId, to);
        // A thrown send may have lost only its acknowledgement; replay only explicit rejection.
        retry = false;
        const sent = await client.send(to, {
          text,
          messageId: question.questionId,
          expectsReply: true,
          delivery: "steer",
        });
        if (!active()) {
          return;
        }
        retry = !sent.accepted;
        recordNotification(to, sent);
      } catch (error) {
        logFailure(error);
      } finally {
        if (retry && active()) {
          retryAfter = Date.now() + 1000;
          this.owners.wait.retry(question.questionId, () => {
            this.ownNotification(notify);
          });
        }
      }
    };
    this.ownNotification(notify);
  }
  private async decision(request: DecisionRequest): Promise<ToolResultLike> {
    if (this.owners.wait.waiting) {
      throw new Error("Already waiting for a reply");
    }
    if (request.signal?.aborted === true) {
      throw new Error("Cancelled");
    }
    const { question, text } = this.createQuestion(request);
    const reply = this.owners.wait.wait({
      from: this.metadata.orchestratorTarget,
      replyTo: question.questionId,
      signal: request.signal,
      question,
    });
    this.scheduleNotification({ question, text, reason: request.reason });
    const message = await reply;
    return this.answer(question, message, request.interview);
  }
  private answer(
    question: ReadonlyInput<SupervisorQuestion>,
    message: Message,
    interview: SupervisorInterviewRequest | undefined,
  ): ToolResultLike {
    this.owners.pi.appendEntry("intercom_received", {
      from: this.metadata.orchestratorTarget,
      questionId: question.questionId,
      message: message.content,
      messageId: message.id,
      timestamp: message.timestamp,
    });
    recordQuestionDelivery(question, {
      kind: "live",
      runId: question.runId,
      deliveredAt: Date.now(),
    });
    const details = replyDetails(question.questionId, message.content.text, interview);
    const origin = readQuestionState(question).answer?.origin;
    return toolText(
      `**${origin === "human" ? "Direct user answer (human origin)" : "Reply from supervisor"}:**\n${message.content.text}${formatAttachments(message.content.attachments ?? [])}`,
      details,
    );
  }
  private async progress(
    message: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResultLike> {
    let client;
    try {
      client = await this.owners.connection.ensure("tool");
    } catch (error) {
      return toolError(`Intercom not connected: ${errorMessage(error)}`);
    }
    this.owners.connection.syncIdentity(ctx.sessionManager.getSessionId());
    if (signal?.aborted === true) {
      return toolError("Cancelled");
    }
    let to: string;
    try {
      to =
        (await resolveConnectedTarget(client, this.metadata.orchestratorTarget)) ??
        this.metadata.orchestratorTarget;
    } catch (error) {
      return toolError(`Failed to resolve supervisor target: ${errorMessage(error)}`);
    }
    if (this.cancelled(signal)) {
      return toolError("Cancelled");
    }
    if (to === client.sessionId) {
      return toolError("Cannot message the current session");
    }
    try {
      const result = await client.send(to, {
        text: formatChildOrchestratorMessage("update", this.metadata, message),
        delivery: "steer",
      });
      return this.progressReceipt(message, result);
    } catch (error) {
      return toolError(`Failed to send progress update: ${errorMessage(error)}`);
    }
  }
  private progressReceipt(message: string, result: SendResult): ToolResultLike {
    if (!result.accepted) {
      return toolError(
        `Message to "${this.metadata.orchestratorTarget}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`,
        {
          messageId: result.id,
          accepted: result.accepted,
          delivered: false,
          reason: result.reason,
        },
      );
    }
    this.owners.lifecycle.markActivity();
    this.owners.connection.syncStatus();
    this.owners.pi.appendEntry("intercom_sent", {
      to: this.metadata.orchestratorTarget,
      message: { text: message, reason: "progress_update" },
      messageId: result.id,
      timestamp: Date.now(),
      subagent: {
        runId: this.metadata.runId,
        agent: this.metadata.agent,
        index: this.metadata.index,
      },
    });
    return toolText(
      `Progress update accepted for supervisor ${this.metadata.orchestratorTarget}. Queued for the next tool boundary; broker acceptance does not confirm the supervisor has read or acted on it.`,
      {
        messageId: result.id,
        accepted: result.accepted,
        delivered: result.delivered,
        queued: result.queued === true,
      },
    );
  }
  private cancelled(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
  }
  async execute(
    params: ContactSupervisorToolParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResultLike> {
    const { reason, message } = params;
    const invalid = validateContact(params);
    if (invalid) {
      return invalid;
    }
    if (reason === "progress_update") {
      return await this.progress(message ?? "", signal, ctx);
    }
    const validation =
      reason === "interview_request"
        ? validateSupervisorInterviewRequest(params.interview)
        : undefined;
    if (validation?.ok === false) {
      return toolError(`Invalid interview request: ${validation.error}`);
    }
    return await this.decision({
      reason,
      message,
      interview: validation?.ok === true ? validation.interview : undefined,
      signal,
      ctx,
    });
  }
}
