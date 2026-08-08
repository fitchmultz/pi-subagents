import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { IntercomClient, type SendResult } from "./broker/client.ts";
import { isBrokerRunning, spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { SessionListOverlay } from "./ui/session-list.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { loadConfig, type IntercomConfig } from "./config.ts";
import type { SessionInfo, Message, Attachment, MessageDelivery, QueueMode } from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { formatPeerAwarenessHint, formatSessionTarget, formatTargetOptions, resolveSessionProjectId, targetDisplayName, resolveSessionTarget as resolveSessionTargetValue } from "./session-targets.ts";
import { registerSubagentLiveEventHandlers } from "./subagent-live-events.ts";

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const SUBAGENT_INTERCOM_IDENTITY_REQUEST_EVENT = "subagent:intercom-identity-request";
const SUBAGENT_INTERCOM_IDENTITY_RESPONSE_EVENT = "subagent:intercom-identity-response";
const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
const INTERCOM_DETACH_RESPONSE_TIMEOUT_MS = 500;
const INBOUND_FLUSH_DELAY_MS = 200;
const INBOUND_IDLE_RETRY_MS = 500;
const NON_UI_REPLACE_FLUSH_DELAY_MS = 1_600;
const PEER_AWARENESS_LIST_TIMEOUT_MS = 75;
const SUBAGENT_PROGRESS_UPDATE_MAX_AGE_MS = 60_000;
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";
const RECIPIENT_TURN_FAILED_PREFIX = "Recipient turn failed:";
const RECIPIENT_TURN_FAILED_ATTACHMENT = "pi-intercom-recipient-turn-failure";
const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface ChildOrchestratorMetadata {
  orchestratorTarget: string;
  runId: string;
  agent: string;
  index: string;
  sessionName?: string;
}

interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

interface PendingInboundMessage extends InboundMessageEntry {
  flushDelivery: "auto" | "passive" | "steer";
}

type RequestedDelivery = MessageDelivery | "auto";
type InboundDelivery = "trigger" | "followUp" | "steer" | "passive";

type ContactSupervisorReason = "need_decision" | "progress_update" | "interview_request";

interface SupervisorInterviewQuestion extends Record<string, unknown> {
  id: string;
  type: "single" | "multi" | "text" | "image" | "info";
  question: string;
  options?: unknown[];
}

interface SupervisorInterviewRequest extends Record<string, unknown> {
  title?: string;
  description?: string;
  questions: SupervisorInterviewQuestion[];
}

interface SupervisorInterviewReply {
  responses: Array<{ id: string; value: unknown }>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

type RecoveryAction = { action: "list" | "pending" | "send" | "status"; guidance?: string };

function failureDetails(reasonCode: string, nextActions: RecoveryAction[], details: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...details, reasonCode, nextActions };
}

function replyFailureReason(message: string): "no_pending_reply" | "ambiguous_reply_target" | "reply_failed" {
  if (message.startsWith("No active intercom context") || message.startsWith("No pending ask")) return "no_pending_reply";
  if (message.startsWith("Multiple pending asks") || message.includes("too short")) return "ambiguous_reply_target";
  return "reply_failed";
}

function getAssistantErrorMessage(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") {
    return null;
  }
  const errorMessage = typeof record.errorMessage === "string" && record.errorMessage.trim()
    ? record.errorMessage.trim()
    : undefined;
  if (record.stopReason === "error") {
    return errorMessage ?? "assistant turn failed";
  }
  return null;
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\n📎 ${att.name}\n${att.content}`;
    }
  }
  return text;
}
function readChildOrchestratorMetadata(): ChildOrchestratorMetadata | null {
  const orchestratorTarget = process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV]?.trim();
  const runId = process.env[SUBAGENT_RUN_ID_ENV]?.trim();
  const agent = process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim();
  const index = process.env[SUBAGENT_CHILD_INDEX_ENV]?.trim();
  if (!orchestratorTarget || !runId || !agent || !index) {
    return null;
  }
  const sessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
  return {
    orchestratorTarget,
    runId,
    agent,
    index,
    ...(sessionName ? { sessionName } : {}),
  };
}
function formatChildOrchestratorMessage(kind: "ask" | "update" | "interview", metadata: ChildOrchestratorMetadata, message: string): string {
  const heading = kind === "ask"
    ? "Subagent needs a supervisor decision."
    : kind === "interview"
      ? "Subagent requests a structured supervisor interview."
      : "Subagent progress update.";
  return [
    heading,
    `Run: ${metadata.runId}`,
    `Agent: ${metadata.agent}`,
    `Child index: ${metadata.index}`,
    metadata.sessionName ? `Child intercom target: ${metadata.sessionName}` : undefined,
    "",
    message,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function validateSupervisorInterviewRequest(input: unknown): { ok: true; interview: SupervisorInterviewRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "interview must be an object with a questions array" };
  }

  const raw = input as Record<string, unknown>;
  if (raw.title !== undefined && typeof raw.title !== "string") {
    return { ok: false, error: "interview.title must be a string when provided" };
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return { ok: false, error: "interview.description must be a string when provided" };
  }
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    return { ok: false, error: "interview.questions must be a non-empty array" };
  }

  const validTypes = new Set(["single", "multi", "text", "image", "info"]);
  const ids = new Set<string>();
  const questions: SupervisorInterviewQuestion[] = [];

  for (let index = 0; index < raw.questions.length; index++) {
    const questionInput = raw.questions[index];
    if (!questionInput || typeof questionInput !== "object" || Array.isArray(questionInput)) {
      return { ok: false, error: `interview.questions[${index}] must be an object` };
    }
    const question = questionInput as Record<string, unknown>;
    if (typeof question.id !== "string" || question.id.trim() === "") {
      return { ok: false, error: `interview.questions[${index}].id must be a non-empty string` };
    }
    const id = question.id.trim();
    if (ids.has(id)) {
      return { ok: false, error: `interview question id must be unique: ${id}` };
    }
    ids.add(id);

    if (typeof question.type !== "string" || !validTypes.has(question.type)) {
      return { ok: false, error: `interview.questions[${index}].type must be one of: single, multi, text, image, info` };
    }
    if (typeof question.question !== "string" || question.question.trim() === "") {
      return { ok: false, error: `interview.questions[${index}].question must be a non-empty string` };
    }
    if (question.context !== undefined && typeof question.context !== "string") {
      return { ok: false, error: `interview.questions[${index}].context must be a string when provided` };
    }
    let options: unknown[] | undefined;
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) {
        return { ok: false, error: `interview.questions[${index}].options must be an array when provided` };
      }
      options = [];
      for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
        const option = question.options[optionIndex];
        if (typeof option === "string") {
          const label = option.trim();
          if (!label) {
            return { ok: false, error: `interview.questions[${index}].options[${optionIndex}] must not be empty` };
          }
          options.push(label);
        } else if (!option || typeof option !== "object" || Array.isArray(option) || typeof (option as { label?: unknown }).label !== "string" || (option as { label: string }).label.trim() === "") {
          return { ok: false, error: `interview.questions[${index}].options[${optionIndex}] must be a non-empty string or an object with a non-empty label` };
        } else {
          options.push({ ...option, label: (option as { label: string }).label.trim() });
        }
      }
    }
    if ((question.type === "single" || question.type === "multi") && (!options || options.length === 0)) {
      return { ok: false, error: `interview.questions[${index}].options must be a non-empty array for ${question.type} questions` };
    }
    if (question.type !== "single" && question.type !== "multi" && options) {
      return { ok: false, error: `interview.questions[${index}].options is only valid for single and multi questions` };
    }

    questions.push({
      ...question,
      id,
      type: question.type as SupervisorInterviewQuestion["type"],
      question: question.question.trim(),
      ...(options ? { options } : {}),
    });
  }

  return {
    ok: true,
    interview: {
      ...raw,
      ...(typeof raw.title === "string" ? { title: raw.title.trim() } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
      questions,
    },
  };
}

function interviewOptionLabel(option: unknown): string {
  return typeof option === "string" ? option : (option as { label: string }).label;
}

function interviewExampleValue(question: SupervisorInterviewQuestion): unknown {
  if (question.type === "multi") {
    return question.options?.slice(0, 2).map(interviewOptionLabel) ?? [];
  }
  if (question.type === "single") {
    return question.options?.[0] !== undefined ? interviewOptionLabel(question.options[0]) : "option label";
  }
  if (question.type === "image") {
    return "image/file reference or description";
  }
  return "answer text";
}

function formatSupervisorInterviewRequest(interview: SupervisorInterviewRequest, message?: string): string {
  const lines: string[] = [];
  const title = interview.title?.trim();
  if (title) lines.push(`Interview: ${title}`);
  const description = interview.description?.trim();
  if (description) lines.push(description);
  const note = message?.trim();
  if (note) lines.push(`Child note: ${note}`);
  if (lines.length > 0) lines.push("");

  lines.push("Questions:");
  interview.questions.forEach((question, index) => {
    lines.push(`${index + 1}. [${question.id}] (${question.type}) ${question.question}`);
    if (typeof question.context === "string" && question.context.trim()) {
      lines.push(`   Context: ${question.context.trim()}`);
    }
    if (question.options?.length) {
      lines.push("   Options:");
      for (const option of question.options) {
        lines.push(`   - ${interviewOptionLabel(option)}`);
      }
    }
  });

  const responseExample = {
    responses: interview.questions
      .filter((question) => question.type !== "info")
      .map((question) => ({
        id: question.id,
        value: interviewExampleValue(question),
      })),
  };

  lines.push(
    "",
    "Supervisor reply instructions:",
    "Reply with plain JSON or a fenced ```json block using this stable shape. Use the question ids exactly. Info questions are context-only and do not need responses. For single questions, value is one option label. For multi questions, value is an array of option labels. For text/image questions, value is a string unless the question asks otherwise.",
    "",
    "```json",
    JSON.stringify(responseExample, null, 2),
    "```",
  );

  return lines.join("\n");
}

function validateSupervisorInterviewReply(value: unknown, interview: SupervisorInterviewRequest): SupervisorInterviewReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reply JSON must be an object with a responses array");
  }

  const responsesInput = (value as Record<string, unknown>).responses;
  if (!Array.isArray(responsesInput)) {
    throw new Error("reply JSON must include a responses array");
  }

  const questionById = new Map(interview.questions
    .filter((question) => question.type !== "info")
    .map((question) => [question.id, question]));
  const seenIds = new Set<string>();
  const responses: SupervisorInterviewReply["responses"] = [];

  for (let index = 0; index < responsesInput.length; index++) {
    const response = responsesInput[index];
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error(`responses[${index}] must be an object`);
    }

    const raw = response as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.trim() === "") {
      throw new Error(`responses[${index}].id must be a non-empty string`);
    }
    const id = raw.id.trim();
    const question = questionById.get(id);
    if (!question) {
      throw new Error(`responses[${index}].id must match a non-info interview question id`);
    }
    if (seenIds.has(id)) {
      throw new Error(`responses[${index}].id is duplicated: ${id}`);
    }
    seenIds.add(id);
    if (!Object.hasOwn(raw, "value")) {
      throw new Error(`responses[${index}].value is required`);
    }

    const value = raw.value;
    if (question.type === "single") {
      if (typeof value !== "string") throw new Error(`responses[${index}].value must be a string for single questions`);
      const optionLabels = new Set(question.options?.map(interviewOptionLabel));
      if (!optionLabels.has(value.trim())) throw new Error(`responses[${index}].value must match one of the question options`);
      responses.push({ id, value: value.trim() });
      continue;
    }

    if (question.type === "multi") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`responses[${index}].value must be an array of strings for multi questions`);
      }
      const optionLabels = new Set(question.options?.map(interviewOptionLabel));
      const selected = value.map((item) => item.trim());
      const invalid = selected.find((item) => !optionLabels.has(item));
      if (invalid) throw new Error(`responses[${index}].value contains an option that is not in the question options: ${invalid}`);
      responses.push({ id, value: selected });
      continue;
    }

    if (typeof value !== "string") {
      throw new Error(`responses[${index}].value must be a string for ${question.type} questions`);
    }
    responses.push({ id, value });
  }

  return { responses };
}

function parseStructuredSupervisorReply(text: string, interview: SupervisorInterviewRequest): { value?: SupervisorInterviewReply; error?: string } | undefined {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fencedMatch?.[1] ?? text).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    return undefined;
  }
  try {
    return { value: validateSupervisorInterviewReply(JSON.parse(candidate), interview) };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}
function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map(s => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
}
function parseSubagentIntercomPayload(payload: unknown): { to: string; message: string; requestId?: string; source?: "foreground" | "async" } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.to !== "string" || typeof record.message !== "string") {
    return null;
  }
  const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
  const source = record.source === "foreground" || record.source === "async" ? record.source : undefined;
  return { to: record.to, message: record.message, ...(requestId ? { requestId } : {}), ...(source ? { source } : {}) };
}
function resolveIntercomPresenceName(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}
function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string): { name: string } {
  const subagentIntercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
  return {
    name: subagentIntercomSessionName || resolveIntercomPresenceName(pi.getSessionName(), sessionId),
  };
}
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
function sessionBusyState(session: SessionInfo): "idle" | "busy" | "unknown" {
  if (session.acceptsAsks === true) return "idle";
  if (session.acceptsAsks === false) return "busy";
  const status = session.status ?? "";
  if (status === "idle" || status.startsWith("idle ") || status.startsWith("idle ·")) return "idle";
  if (status === "thinking" || status.startsWith("thinking ") || status.startsWith("thinking ·") || status.startsWith("tool:")) return "busy";
  return "unknown";
}
function formatIntercomAge(timestamp: number | undefined, now: number): string {
  return typeof timestamp === "number" && timestamp > 0
    ? `${formatDuration(Math.max(0, Math.floor((now - timestamp) / 1000)))} ago`
    : "none";
}
function sessionDeliveryGuidance(session: SessionInfo, isSelf: boolean): string {
  if (isSelf) return "self target unavailable; choose a peer from Other sessions; use pending/reply for inbound asks";
  const state = sessionBusyState(session);
  if (state === "idle") return "send defaults to steer and wakes; ask only if sender must stay alive for a required reply; queue only for intentional delay; passive discouraged";
  if (session.acceptsAsks === false) return "send defaults to steer; ask only if sender must stay alive for a required reply (default returns peer_idle); queue only for intentional delay; passive discouraged";
  if (state === "busy") return "send defaults to steer at the next tool boundary; ask only if sender must stay alive for a required reply; queue only for intentional delay; passive discouraged";
  return "state unknown; target is valid; send defaults to steer; ask only if sender must stay alive for a required reply; queue only for intentional delay; passive discouraged";
}
function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean, duplicates = new Set<string>(), allSessions: SessionInfo[] = [session], now = Date.now()): string {
  const name = session.name || "Unnamed session";
  const duplicateName = Boolean(session.name && duplicates.has(session.name.toLowerCase()));
  const healthTags: string[] = [];
  healthTags.push(`state:${sessionBusyState(session)}`);
  healthTags.push(`accepts_asks:${session.acceptsAsks === undefined ? "unknown" : session.acceptsAsks ? "true" : "false"}`);
  healthTags.push(`pending_asks:${typeof session.pendingAsks === "number" ? session.pendingAsks : "unknown"}`);
  healthTags.push(`last_intercom_activity:${formatIntercomAge(session.lastIntercomActivity, now)}`);
  if (typeof session.lastSeen === "number") {
    healthTags.push(`last_seen:${formatDuration(Math.max(0, Math.floor((now - session.lastSeen) / 1000)))} ago`);
  }
  const tags = [
    isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined,
    session.status,
    duplicateName ? `target:${formatSessionTarget(session, allSessions)}` : undefined,
    ...healthTags,
  ].filter((tag): tag is string => Boolean(tag));
  const target = formatSessionTarget(session, allSessions);
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${name} (${target}) — ${session.cwd} (${session.model})${suffix}\n  ↳ ${sessionDeliveryGuidance(session, isSelf)}`;
}
function formatSessionListSections(sessions: SessionInfo[], currentSessionId: string): string {
  const currentSession = sessions.find(s => s.id === currentSessionId);
  if (!currentSession) {
    throw new Error("Current session is missing from intercom session list.");
  }
  const duplicates = duplicateSessionNames(sessions);
  const otherSessions = sessions.filter(s => s.id !== currentSessionId);
  const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true, duplicates, sessions)}`;
  const otherSection = otherSessions.length === 0
    ? `**Other sessions:**\nNo other sessions connected. Start another intercom-enabled session with \`pi --name worker\`, then run \`intercom({ action: "list" })\` again. If you are dogfooding this local fork without installing it, start the peer with \`${localForkStartCommand()}\`.`
    : `**Other sessions:**\n${otherSessions.map(s => formatSessionListRow(s, currentSession.cwd, false, duplicates, sessions)).join("\n")}`;
  return `${currentSection}\n\n${otherSection}`;
}
function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function pendingAskPreview(message: Message): string {
  const text = message.content.text;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (text.startsWith("Subagent needs a supervisor decision.") || text.startsWith("Subagent requests a structured supervisor interview.")) {
    const run = text.match(/^Run:\s*(.+)$/m)?.[1]?.trim();
    const agent = text.match(/^Agent:\s*(.+)$/m)?.[1]?.trim();
    const childTarget = text.match(/^Child intercom target:\s*(.+)$/m)?.[1]?.trim();
    const body = text.split(/\n\s*\n/).slice(1).join(" ").replace(/\s+/g, " ").trim();
    return [
      text.startsWith("Subagent requests") ? "structured supervisor interview" : "supervisor decision",
      run ? `run=${run}` : undefined,
      agent ? `agent=${agent}` : undefined,
      childTarget ? `target=${childTarget}` : undefined,
      body ? `question=${previewText(body, 180)}` : undefined,
    ].filter((part): part is string => Boolean(part)).join(" · ");
  }
  return previewText(normalized, 180) ?? normalized;
}
function firstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
}

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

interface ContactSupervisorToolParams {
  reason: ContactSupervisorReason;
  message?: string;
  interview?: unknown;
}

interface IntercomToolParams {
  action: "list" | "send" | "ask" | "reply" | "pending" | "status";
  to?: string;
  message?: string;
  attachments?: Attachment[];
  replyTo?: string;
  delivery?: MessageDelivery;
  queueMode?: QueueMode;
  threadId?: string;
  passive?: boolean;
}

type ToolRenderTheme = ExtensionContext["ui"]["theme"];
type ToolRenderContext = { args?: unknown; isError?: boolean; expanded?: boolean };

class ToolExecutionFailure extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

class AskDeliveryError extends Error {
  readonly result: SendResult;

  constructor(result: SendResult) {
    super(result.reason ?? "Session may not exist or has disconnected.");
    this.result = result;
  }
}

function throwIfToolError<T extends ToolResultLike>(result: T): T {
  if (!result.isError) return result;
  throw new ToolExecutionFailure(firstTextContent(result) || "Tool failed", result.details);
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function localForkStartCommand(): string {
  return `pi --name worker --extension ${shellQuote(path.join(PACKAGE_ROOT, "src", "pi-intercom", "index.ts"))} --skill ${shellQuote(path.join(PACKAGE_ROOT, "skills", "pi-intercom"))}`;
}
async function settleWithin<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    void Promise.resolve().then(operation).then((value) => finish(value), () => finish(null));
  });
}
export default function piIntercomExtension(pi: ExtensionAPI) {
  let client: IntercomClient | null = null;
  const config: IntercomConfig = loadConfig();
  const childOrchestratorMetadata = readChildOrchestratorMetadata();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let startupConnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  let lastIntercomActivity = 0;
  const activeTools = new Map<string, string>();
  const replyTracker = new ReplyTracker(config.askTimeoutMs);
  const pendingIdleMessages: PendingInboundMessage[] = [];
  const maxPendingIdleMessages = 100;
  let inboundFlushTimer: NodeJS.Timeout | null = null;
  let replyWaiter: {
    from: string;
    replyTo: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  } | null = null;
  function waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<Message> {
    if (replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectReplyWaiter(new Error(`No reply from "${from}" within ${Math.max(1, Math.round(config.askTimeoutMs / 60000))} minute(s)`));
      }, config.askTimeoutMs);
      timeout.unref?.();
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) {
          replyWaiter = null;
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }
  function rejectReplyWaiterForPeer(sessionId: string): void {
    if (replyWaiter?.from === sessionId) {
      rejectReplyWaiter(new Error(`Reply peer disconnected before answering: ${sessionId}`));
    }
  }
  async function sendAskTransaction(
    activeClient: IntercomClient,
    to: string,
    questionId: string,
    options: Parameters<IntercomClient["send"]>[1],
    signal: AbortSignal | undefined,
    onSent: (result: SendResult) => void,
  ): Promise<Message> {
    const replyPromise = waitForReply(to, questionId, signal);
    replyPromise.catch(() => undefined);
    try {
      if (signal?.aborted) throw new Error("Cancelled");
      const result = await activeClient.send(to, { ...options, messageId: questionId, expectsReply: true });
      if (!result.accepted) throw new AskDeliveryError(result);
      markIntercomActivity();
      syncPresenceStatus();
      onSent(result);
      return await replyPromise;
    } catch (error) {
      rejectReplyWaiter(toError(error));
      try {
        await replyPromise;
      } catch {
        // Cleanup only; preserve the transaction failure.
      }
      throw error;
    }
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function clearStartupConnectTimer(): void {
    if (!startupConnectTimer) {
      return;
    }
    clearTimeout(startupConnectTimer);
    startupConnectTimer = null;
  }
  function scheduleStartupConnection(ctx: ExtensionContext, generation: number): void {
    clearStartupConnectTimer();
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!getLiveContext(ctx, generation)) return;
      void ensureConnected("startup").catch(() => {
        if (!getLiveContext(ctx, generation)) return;
        client = null;
        scheduleReconnect();
      });
    }, 0);
    startupConnectTimer.unref?.();
  }
  function clearInboundFlushTimer(): void {
    if (!inboundFlushTimer) {
      return;
    }
    clearTimeout(inboundFlushTimer);
    inboundFlushTimer = null;
  }
  function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
    if (disposed || generation !== runtimeGeneration || !ctx) {
      return null;
    }
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) {
        return null;
      }
      void ctx.hasUI;
      return ctx;
    } catch {
      // A context that throws while reading session/UI state is no longer usable.
      return null;
    }
  }
  function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext?.hasUI) {
      return;
    }
    try {
      liveContext.ui.notify(message, level);
    } catch {
      // The UI can disappear during session shutdown/reload while async overlay work is settling.
    }
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  async function buildRegistration(): Promise<Omit<SessionInfo, "id">> {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = buildPresenceIdentity(pi, currentSessionId);
    const cwd = liveContext.cwd ?? process.cwd();
    return {
      name: identity.name,
      cwd,
      model: currentModel,
      projectId: await resolveSessionProjectId(cwd),
      lastSeen: Date.now(),
      status: currentStatus(),
      ...buildPresenceHealth(),
    };
  }
  function isRecipientIdle(ctx: ExtensionContext): boolean {
    if (agentRunning || activeTools.size > 0) return false;
    try {
      return ctx.isIdle();
    } catch {
      return false;
    }
  }
  function canAcceptAsks(): boolean {
    const liveContext = getLiveContext();
    return liveContext ? isRecipientIdle(liveContext) : false;
  }
  /** Build peer-health fields published via presence so askers can detect idle/non-accepting peers. */
  function buildPresenceHealth(): { pendingAsks: number; acceptsAsks: boolean; lastIntercomActivity: number } {
    return {
      pendingAsks: replyTracker.listPending().length,
      acceptsAsks: canAcceptAsks(),
      lastIntercomActivity,
    };
  }
  function markIntercomActivity(): void {
    lastIntercomActivity = Date.now();
  }
  function syncPresenceIdentity(sessionId: string): void {
    if (!client || !getLiveContext()) {
      return;
    }
    client.updatePresence({ ...buildPresenceIdentity(pi, sessionId), status: currentStatus(), ...buildPresenceHealth() });
  }
  function syncPresenceStatus(): void {
    if (!client || !currentSessionId || !getLiveContext()) {
      return;
    }
    client.updatePresence({ status: currentStatus(), ...buildPresenceHealth() });
  }
  function requestedDelivery(message: Message): RequestedDelivery {
    if (message.passive === true || message.delivery === "passive") return "passive";
    return message.delivery ?? (message.expectsReply === true ? "auto" : "steer");
  }
  function shouldTriggerTurn(message: Message): boolean {
    return requestedDelivery(message) !== "passive";
  }
  function queuedTriggerIndex(entries: PendingInboundMessage[]): number {
    const canTrigger = (entry: PendingInboundMessage) => entry.flushDelivery !== "passive" && shouldTriggerTurn(entry.message);
    const askIndex = entries.findIndex((entry) => canTrigger(entry) && entry.message.expectsReply === true);
    return askIndex === -1 ? entries.findIndex(canTrigger) : askIndex;
  }
  function currentSessionTargetMatches(to: string, resolvedTo?: string | null, activeClient?: IntercomClient): boolean {
    const targets = new Set<string>();
    const addTarget = (target: string | undefined | null) => {
      const trimmed = target?.trim();
      if (trimmed) targets.add(trimmed.toLowerCase());
    };
    addTarget(currentSessionId);
    addTarget(activeClient?.sessionId);
    addTarget(pi.getSessionName());
    if (currentSessionId) addTarget(buildPresenceIdentity(pi, currentSessionId).name);
    return Boolean(resolvedTo && activeClient?.sessionId && resolvedTo === activeClient.sessionId)
      || targets.has(to.trim().toLowerCase());
  }
  function sendIncomingMessage(entry: InboundMessageEntry, delivery: InboundDelivery, generation = runtimeGeneration): void {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      return;
    }
    if (delivery !== "passive") {
      replyTracker.queueTurnContext({ from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
    const options = delivery === "trigger"
      ? { triggerTurn: true }
      : delivery === "followUp" || delivery === "steer"
        ? { deliverAs: delivery }
        : undefined;
    pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
        display: true,
        details: entry,
      },
      options
    );
  }
  function isBlockingSubagentSupervisorMessage(entry: InboundMessageEntry): boolean {
    if (!entry.message.expectsReply) return false;
    const text = entry.bodyText.trimStart();
    return text.startsWith("Subagent needs a supervisor decision.")
      || text.startsWith("Subagent requests a structured supervisor interview.");
  }
  function isStaleSubagentProgressUpdate(entry: InboundMessageEntry, now = Date.now()): boolean {
    if (entry.message.expectsReply) return false;
    return entry.bodyText.trimStart().startsWith("Subagent progress update.")
      && now - entry.message.timestamp > SUBAGENT_PROGRESS_UPDATE_MAX_AGE_MS;
  }
  async function requestSubagentDetachForBlockingSupervisorMessage(entry: InboundMessageEntry): Promise<boolean> {
    if (!isBlockingSubagentSupervisorMessage(entry)) return false;
    const requestId = randomUUID();
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(accepted);
      };
      const timer = setTimeout(() => finish(false), INTERCOM_DETACH_RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      unsubscribe = pi.events.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload: unknown) => {
        if (!payload || typeof payload !== "object") return;
        const response = payload as { requestId?: unknown; accepted?: unknown };
        if (response.requestId !== requestId) return;
        finish(response.accepted === true);
      });
      try {
        pi.events.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId });
      } catch {
        finish(false);
      }
    });
  }
  function scheduleInboundFlush(delayMs = INBOUND_FLUSH_DELAY_MS): void {
    if (!getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    clearInboundFlushTimer();
    inboundFlushTimer = setTimeout(() => {
      inboundFlushTimer = null;
      flushIdleMessages(scheduledGeneration);
    }, delayMs);
    inboundFlushTimer.unref?.();
  }
  function flushIdleMessages(generation = runtimeGeneration): void {
    if (pendingIdleMessages.length === 0) {
      return;
    }
    const ctx = getLiveContext(runtimeContext, generation);
    if (!ctx) {
      return;
    }

    if (!isRecipientIdle(ctx)) {
      if (!ctx.hasUI && pendingIdleMessages.some((entry) => entry.flushDelivery === "steer")) {
        if (activeTools.size > 0) {
          scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
          return;
        }
        const now = Date.now();
        const entries = pendingIdleMessages.splice(0, pendingIdleMessages.length);
        for (const entry of entries) {
          if (entry.flushDelivery === "steer") {
            if (!isStaleSubagentProgressUpdate(entry, now)) sendIncomingMessage(entry, "trigger", generation);
          } else {
            pendingIdleMessages.push(entry);
          }
        }
        if (pendingIdleMessages.length > 0) scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
        return;
      }
      scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
      return;
    }

    const now = Date.now();
    const entries = pendingIdleMessages
      .splice(0, pendingIdleMessages.length)
      .filter((entry) => !isStaleSubagentProgressUpdate(entry, now));
    if (entries.length === 0) return;
    const triggerIndex = queuedTriggerIndex(entries);
    entries.forEach((entry, index) => {
      if (entry.flushDelivery === "passive") {
        sendIncomingMessage(entry, "passive");
        return;
      }
      if (entry.flushDelivery === "steer") {
        sendIncomingMessage(entry, "steer", generation);
        return;
      }
      sendIncomingMessage(entry, index === triggerIndex ? "trigger" : "followUp");
    });
  }
  function queueIdleMessage(entry: InboundMessageEntry, flushDelivery: PendingInboundMessage["flushDelivery"] = "auto", delayMs = INBOUND_FLUSH_DELAY_MS): void {
    let replacedPendingAsk = false;
    if (entry.message.queueMode === "replace" && entry.message.threadId) {
      for (let index = pendingIdleMessages.length - 1; index >= 0; index -= 1) {
        const pending = pendingIdleMessages[index];
        if (pending?.from.id === entry.from.id && pending.message.threadId === entry.message.threadId) {
          pendingIdleMessages.splice(index, 1);
          if (pending.message.expectsReply) {
            replyTracker.markReplied(pending.message.id);
            replacedPendingAsk = true;
          }
        }
      }
    }
    if (replacedPendingAsk) {
      syncPresenceStatus();
    }
    pendingIdleMessages.push({ ...entry, flushDelivery });
    while (pendingIdleMessages.length > maxPendingIdleMessages) {
      const dropped = pendingIdleMessages.shift();
      if (dropped?.message.expectsReply) replyTracker.markReplied(dropped.message.id);
    }
    scheduleInboundFlush(delayMs);
  }
  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      return;
    }
    if (replyWaiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === replyWaiter.from.toLowerCase()
        || from.id === replyWaiter.from;
      const replyMatches = message.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        markIntercomActivity();
        syncPresenceStatus();
        replyWaiter.resolve(message);
        return;
      }
    }
    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    replyTracker.recordIncomingMessage(from, message);
    markIntercomActivity();
    syncPresenceStatus();
    const entry = { from, message, replyCommand, bodyText };
    void (async () => {
      const activeContext = getLiveContext(liveContext, messageGeneration);
      if (!activeContext) {
        return;
      }
      const delivery = requestedDelivery(message);
      if (delivery === "queue" && message.queueMode === "replace") {
        if (!isRecipientIdle(activeContext) && !activeContext.hasUI) {
          queueIdleMessage(entry, "steer", NON_UI_REPLACE_FLUSH_DELAY_MS);
          return;
        }
        queueIdleMessage(entry, "auto");
        return;
      }
      if (!isRecipientIdle(activeContext)) {
        if (activeContext.hasUI && isBlockingSubagentSupervisorMessage(entry)) {
          await requestSubagentDetachForBlockingSupervisorMessage(entry);
          if (!getLiveContext(liveContext, messageGeneration)) {
            return;
          }
        }
        if (delivery === "steer") {
          sendIncomingMessage(entry, "steer", messageGeneration);
          return;
        }
        if (delivery === "queue" && message.queueMode !== "replace") {
          sendIncomingMessage(entry, "followUp", messageGeneration);
          return;
        }
        if (delivery === "passive") {
          queueIdleMessage(entry, "passive");
          return;
        }
        if (!activeContext.hasUI) {
          if (!message.expectsReply) {
            sendIncomingMessage(entry, "steer", messageGeneration);
            return;
          }
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const result = await activeClient.send(from.id, {
                text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
                replyTo: message.id,
              });
              if (result.delivered && getLiveContext(liveContext, messageGeneration)) {
                replyTracker.markReplied(message.id);
                markIntercomActivity();
                syncPresenceStatus();
              }
            } catch {
              // Best-effort reply; keep the busy non-interactive session running either way.
            }
          }
          return;
        }
        queueIdleMessage(entry, "auto");
        return;
      }
      if (getLiveContext(liveContext, messageGeneration)) {
        sendIncomingMessage(entry, delivery === "passive" ? "passive" : "trigger", messageGeneration);
      }
    })();
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from, message) => {
      const liveContext = getLiveContext();
      if (client !== nextClient || !liveContext) {
        return;
      }
      handleIncomingMessage(liveContext, from, message);
    });
    nextClient.on("session_left", (sessionId: string) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiterForPeer(sessionId);
      replyTracker.expireSender(sessionId);
      for (let index = pendingIdleMessages.length - 1; index >= 0; index -= 1) {
        const pending = pendingIdleMessages[index];
        if (pending?.from.id === sessionId && pending.message.expectsReply) {
          pendingIdleMessages.splice(index, 1);
        }
      }
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      if (!disposed) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
      // Keep broker/socket noise out of the TUI. Reconnect logic runs from the disconnect path.
    });
  }
  function scheduleReconnect(): void {
    if (disposed || reconnectTimer || reconnectPromise || !getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (scheduledGeneration !== runtimeGeneration || !getLiveContext()) {
        return;
      }
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
        // ensureConnected("background") already queued the next retry.
      });
    }, getReconnectDelayMs());
    reconnectTimer.unref?.();
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay" | "peer-awareness"): Promise<IntercomClient> {
    if (disposed) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    let nextReconnectPromise!: Promise<IntercomClient>;
    nextReconnectPromise = (async () => {
      const nextClient = new IntercomClient({ sendTimeoutMs: config.sendTimeoutMs, listTimeoutMs: config.listTimeoutMs });
      client = nextClient;
      attachClientHandlers(nextClient);
      try {
        if (reason !== "peer-awareness") {
          await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        }
        await nextClient.connect(await buildRegistration(), `pi-${createHash("sha256").update(currentSessionId).digest("hex").slice(0, 32)}`);
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        reconnectAttempt = 0;
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (reason === "background" && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
        throw toError(error);
      } finally {
        if (reconnectPromise === nextReconnectPromise) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  async function resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null> {
    const sessions = await activeClient.listSessions();
    const resolution = resolveSessionTargetValue(sessions, nameOrId);
    if (resolution.status === "found") {
      return resolution.target!.id;
    }
    if (resolution.status === "ambiguous") {
      throw new Error(`Target "${nameOrId}" matches multiple sessions. Use one of these targets: ${formatTargetOptions(resolution.matches, sessions)}.`);
    }
    if (resolution.status === "prefix_too_short") {
      throw new Error(`Target "${nameOrId}" is too short. Use the displayed target from intercom list, such as ${formatTargetOptions(resolution.matches, sessions)}.`);
    }
    return null;
  }
  /** Look up a connected peer's latest published health by session id. Returns null if unavailable. */
  async function resolvePeerHealth(activeClient: IntercomClient, sessionId: string): Promise<SessionInfo | null> {
    try {
      const sessions = await activeClient.listSessions();
      return sessions.find((session) => session.id === sessionId) ?? null;
    } catch {
      // If health cannot be resolved, callers keep the normal reply wait.
      return null;
    }
  }
  /** A peer is considered idle/not-accepting only when it explicitly publishes acceptsAsks === false. */
  function peerDeclinesAsks(health: SessionInfo | null): boolean {
    return health?.acceptsAsks === false;
  }
  function deliverLocalSubagentRelayMessage(sender: "subagent-control" | "subagent-result", status: string, messageText: string): void {
    const now = Date.now();
    sendIncomingMessage({
      from: {
        id: sender,
        name: sender,
        cwd: runtimeContext?.cwd ?? process.cwd(),
        model: sender,
        status,
      },
      message: {
        id: randomUUID(),
        timestamp: now,
        content: { text: messageText },
      },
      bodyText: messageText,
    }, "trigger");
  }
  function recordSubagentDeliveryError(entryType: string, to: string, message: string, error: unknown): void {
    pi.appendEntry(entryType, {
      to,
      message,
      error: getErrorMessage(error),
      timestamp: Date.now(),
    });
  }
  function emitResultDelivery(requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (!requestId) return;
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
      requestId,
      delivered,
      ...(error ? { error: getErrorMessage(error) } : {}),
    });
  }
  function relaySubagentIntercomPayload(payload: unknown, options: {
    sender: "subagent-control" | "subagent-result";
    status: string;
    errorEntryType: string;
    acknowledge?: boolean;
  }): void {
    const parsed = parseSubagentIntercomPayload(payload);
    if (!parsed) return;

    const relayGeneration = runtimeGeneration;
    void (async () => {
      const relayStillLive = () => !runtimeStarted || Boolean(getLiveContext(runtimeContext, relayGeneration));
      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to)) {
        if ((options.sender === "subagent-result" && parsed.source === "foreground")
          || (options.sender === "subagent-control" && (parsed.source === "foreground" || parsed.source === "async"))) {
          if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
          return;
        }
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      let activeClient: IntercomClient;
      let target: string;
      try {
        activeClient = await ensureConnected("background");
        target = await resolveSessionTarget(activeClient, parsed.to) ?? parsed.to;
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
        return;
      }

      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to, target, activeClient)) {
        if ((options.sender === "subagent-result" && parsed.source === "foreground")
          || (options.sender === "subagent-control" && (parsed.source === "foreground" || parsed.source === "async"))) {
          if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
          return;
        }
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      try {
        const result = await activeClient.send(target, { text: parsed.message });
        if (!relayStillLive()) return;
        if (!result.accepted) {
          const error = new Error(result.reason ?? "Session may not exist or has disconnected.");
          recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
          if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
          return;
        }
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
      }
    })();
  }
  // Subagent event bridges (live/health/control/result) are torn down on session_shutdown.
  // Re-register them on session_start so they survive an in-process restart; the guard skips
  // the first start (already registered at load) and only restores after a shutdown cleared them.
  function registerSubagentEventBridges(): Array<() => void> {
    return [
      ...registerSubagentLiveEventHandlers({
        events: pi.events,
        ensureConnected: () => ensureConnected("background"),
        resolveSessionTarget,
        currentSessionTargetMatches,
        getLivenessCheck: () => {
          const generation = runtimeGeneration;
          return () => !runtimeStarted || Boolean(getLiveContext(runtimeContext, generation));
        },
      }),
      pi.events.on(SUBAGENT_INTERCOM_IDENTITY_REQUEST_EVENT, (payload) => {
        const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
        if (typeof requestId === "string" && client?.isConnected() && client.sessionId) {
          pi.events.emit(SUBAGENT_INTERCOM_IDENTITY_RESPONSE_EVENT, { requestId, sessionId: client.sessionId });
        }
      }),
      pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
        relaySubagentIntercomPayload(payload, {
          sender: "subagent-control",
          status: "needs_attention",
          errorEntryType: "intercom_control_error",
        });
      }),
      pi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
        relaySubagentIntercomPayload(payload, {
          sender: "subagent-result",
          status: "result",
          errorEntryType: "intercom_result_error",
          acknowledge: true,
        });
      }),
    ];
  }
  let eventUnsubscribes = registerSubagentEventBridges();
  let eventBridgesActive = true;
  pi.on("session_start", (_event, ctx) => {
    if (!eventBridgesActive) {
      eventUnsubscribes = registerSubagentEventBridges();
      eventBridgesActive = true;
    }
    disposed = false;
    runtimeStarted = true;
    runtimeGeneration += 1;
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearStartupConnectTimer();
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentModel = ctx.model?.id ?? "unknown";
    agentRunning = false;
    lastIntercomActivity = 0;
    activeTools.clear();
    scheduleStartupConnection(ctx, runtimeGeneration);
  });

  pi.on("session_shutdown", async () => {
    for (const unsubscribe of eventUnsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Best effort cleanup for reload/session replacement.
      }
    }
    eventUnsubscribes = [];
    eventBridgesActive = false;
    disposed = true;
    runtimeGeneration += 1;
    clearStartupConnectTimer();
    clearReconnectTimer();
    rejectReplyWaiter(new Error("Session shutting down"));
    replyTracker.reset();
    pendingIdleMessages.length = 0;
    clearInboundFlushTimer();
    agentRunning = false;
    activeTools.clear();
    if (client) {
      await client.disconnect();
      client = null;
    }
    runtimeContext = null;
    currentSessionId = null;
  });
  pi.on("turn_end", () => {
    if (!getLiveContext()) {
      return;
    }
    replyTracker.endTurn();
    scheduleInboundFlush(0);
  });
  pi.on("message_end", (event) => {
    const activeClient = client;
    const context = replyTracker.currentTurn();
    const errorMessage = getAssistantErrorMessage((event as { message?: unknown }).message);
    if (!activeClient?.isConnected() || !context?.message.expectsReply || !errorMessage) {
      return;
    }
    const replyTo = context.message.id;
    void activeClient.send(context.from.id, {
      text: `${RECIPIENT_TURN_FAILED_PREFIX} ${errorMessage}`,
      replyTo,
      attachments: [{
        type: "context",
        name: RECIPIENT_TURN_FAILED_ATTACHMENT,
        content: errorMessage,
      }],
    }).then((result) => {
      if (result.delivered) {
        replyTracker.markReplied(replyTo);
      }
    }).catch(() => {
      // Best-effort failure propagation; the local error remains visible in the recipient session.
    });
  });
  pi.on("agent_start", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = true;
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.set(event.toolCallId, event.toolName);
    syncPresenceStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.delete(event.toolCallId);
    syncPresenceStatus();
    flushIdleMessages();
  });
  pi.on("agent_settled", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = false;
    activeTools.clear();
    replyTracker.endAgent();
    syncPresenceStatus();
    scheduleInboundFlush(0);
  });
  pi.on("turn_start", (_event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentSessionId = ctx.sessionManager.getSessionId();
    syncPresenceIdentity(ctx.sessionManager.getSessionId());
    replyTracker.beginTurn();
  });
  pi.on("model_select", (event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentModel = event.model.id;
    if (client) {
      client.updatePresence({
        ...buildPresenceIdentity(pi, ctx.sessionManager.getSessionId()),
        model: event.model.id,
        status: currentStatus(),
      });
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (childOrchestratorMetadata) return;
    const generation = runtimeGeneration;
    if (!getLiveContext(ctx, generation)) return;

    const deadline = Date.now() + PEER_AWARENESS_LIST_TIMEOUT_MS;
    let activeClient = client?.isConnected() ? client : null;
    if (!activeClient) {
      clearStartupConnectTimer();
      const brokerAvailable = await settleWithin(() => isBrokerRunning(), PEER_AWARENESS_LIST_TIMEOUT_MS);
      const connectBudgetMs = deadline - Date.now();
      if (brokerAvailable && connectBudgetMs > 0) {
        activeClient = await settleWithin(() => ensureConnected("peer-awareness"), connectBudgetMs);
      }
      if (!activeClient) {
        if (getLiveContext(ctx, generation)) scheduleStartupConnection(ctx, generation);
        return;
      }
    }

    const currentBrokerSessionId = activeClient.sessionId;
    const remainingMs = deadline - Date.now();
    if (!currentBrokerSessionId || remainingMs <= 0 || !getLiveContext(ctx, generation)) return;

    const sessions = await settleWithin(() => activeClient.listSessions(), remainingMs);
    if (!sessions || client !== activeClient || !getLiveContext(ctx, generation)) return;
    const hint = formatPeerAwarenessHint(sessions, currentBrokerSessionId);
    if (!hint) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${hint}` };
  });

  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText);
  });

  if (childOrchestratorMetadata) {
    pi.registerTool({
      name: "contact_supervisor",
      label: "Contact Supervisor",
      description: "Subagent-only tool for contacting the supervisor agent that delegated this task. Use need_decision only when this child cannot safely continue without a decision, approval, or product/API/scope clarification; this steers the supervisor at its next tool boundary and keeps the child alive for the reply. Use interview_request only when multiple structured answers are all required before safe progress; this also steers and waits. Use progress_update only for a concise material update that may intentionally wait behind active supervisor work; this uses deferred delivery and does not wait. Do not use for routine completion handoffs.",
      promptSnippet: "Subagent-only: steer the supervisor for blocking decisions or structured interviews; intentionally defer concise material updates. Do not use for routine completion handoffs.",
      promptGuidelines: [
        "Use contact_supervisor with reason='need_decision' when a subagent cannot safely continue without a decision, approval, or product/API/scope clarification; it steers the supervisor and waits for the reply.",
        "Use contact_supervisor with reason='interview_request' only when the child cannot safely continue until it receives multiple structured answers in one blocking steered exchange.",
        "Use contact_supervisor with reason='progress_update' only for a concise material update that may intentionally wait behind active supervisor work; delivery is deferred and coalesced.",
        "Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
      ],
      parameters: Type.Object({
        reason: StringEnum(["need_decision", "progress_update", "interview_request"] as const, {
          description: "Contact reason: 'need_decision' and 'interview_request' steer the supervisor and wait for a reply; 'progress_update' intentionally defers a non-blocking update",
        }),
        message: Type.Optional(Type.String({
          description: "Decision request, optional interview note, or meaningful progress update for the supervisor",
        })),
        interview: Type.Optional(Type.Object({
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          questions: Type.Array(Type.Object({
            id: Type.String(),
            type: StringEnum(["single", "multi", "text", "image", "info"] as const, { description: "Question type: single, multi, text, image, or info" }),
            question: Type.String(),
            options: Type.Optional(Type.Array(Type.Any())),
            context: Type.Optional(Type.String()),
          })),
        }, { description: "Structured interview request for reason='interview_request'" })),
      }),
      async execute(_toolCallId: string, params: ContactSupervisorToolParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        return throwIfToolError(await (async () => {
        const reason = params.reason as ContactSupervisorReason;
        if (reason !== "need_decision" && reason !== "progress_update" && reason !== "interview_request") {
          return {
            content: [{ type: "text", text: "Invalid reason. Use 'need_decision', 'interview_request', or 'progress_update'." }],
            isError: true,
            details: { error: true },
          };
        }
        if ((reason === "need_decision" || reason === "progress_update") && typeof params.message !== "string") {
          return {
            content: [{ type: "text", text: `Missing 'message' parameter for reason '${reason}'.` }],
            isError: true,
            details: { error: true },
          };
        }
        const interviewValidation = reason === "interview_request"
          ? validateSupervisorInterviewRequest(params.interview)
          : undefined;
        if (interviewValidation?.ok === false) {
          return {
            content: [{ type: "text", text: `Invalid interview request: ${interviewValidation.error}` }],
            isError: true,
            details: { error: true },
          };
        }
        const supervisorInterview = interviewValidation?.ok === true ? interviewValidation.interview : undefined;

        let connectedClient: IntercomClient;
        try {
          connectedClient = await ensureConnected("tool");
        } catch (error) {
          return {
            content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }

        syncPresenceIdentity(ctx.sessionManager.getSessionId());

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            isError: true,
            details: { error: true },
          };
        }

        const metadata = childOrchestratorMetadata;
        let sendTo: string;
        try {
          sendTo = await resolveSessionTarget(connectedClient, metadata.orchestratorTarget) ?? metadata.orchestratorTarget;
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to resolve supervisor target: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            isError: true,
            details: { error: true },
          };
        }
        if (sendTo === connectedClient.sessionId) {
          return {
            content: [{ type: "text", text: "Cannot message the current session" }],
            isError: true,
            details: { error: true },
          };
        }

        if (reason === "progress_update") {
          const message = params.message as string;
          try {
            const result = await connectedClient.send(sendTo, {
              text: formatChildOrchestratorMessage("update", metadata, message),
              delivery: "queue",
              queueMode: "replace",
              threadId: `subagent-progress:${metadata.runId}:${metadata.agent}:${metadata.index}`,
            });
            if (!result.accepted) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, accepted: result.accepted, delivered: false, reason: result.reason },
              };
            }
            markIntercomActivity();
            syncPresenceStatus();
            pi.appendEntry("intercom_sent", {
              to: metadata.orchestratorTarget,
              message: { text: message, reason },
              messageId: result.id,
              timestamp: Date.now(),
              subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
            });
            return {
              content: [{ type: "text", text: result.queued ? `Progress update queued for supervisor ${metadata.orchestratorTarget}` : `Progress update sent to supervisor ${metadata.orchestratorTarget}` }],
              isError: false,
              details: { messageId: result.id, accepted: result.accepted, delivered: result.delivered, queued: result.queued === true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send progress update: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        if (replyWaiter) {
          return {
            content: [{ type: "text", text: "Already waiting for a reply" }],
            isError: true,
            details: { error: true },
          };
        }

        const questionId = randomUUID();
        const requestText = reason === "interview_request"
          ? formatChildOrchestratorMessage("interview", metadata, formatSupervisorInterviewRequest(supervisorInterview!, typeof params.message === "string" ? params.message : undefined))
          : formatChildOrchestratorMessage("ask", metadata, params.message as string);
        try {
          const replyMessage = await sendAskTransaction(connectedClient, sendTo, questionId, { text: requestText, delivery: "steer" }, signal, (sendResult) => {
            pi.appendEntry("intercom_sent", {
              to: metadata.orchestratorTarget,
              message: {
                text: reason === "interview_request" ? requestText : params.message,
                reason,
                ...(reason === "interview_request" ? { interview: supervisorInterview } : {}),
              },
              messageId: sendResult.id,
              timestamp: Date.now(),
              subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
            });
          });
          const replyText = replyMessage.content.text;
          const replyAttachments = replyMessage.content.attachments?.length
            ? formatAttachments(replyMessage.content.attachments)
            : "";
          const structuredReply = reason === "interview_request" ? parseStructuredSupervisorReply(replyText, supervisorInterview!) : undefined;
          pi.appendEntry("intercom_received", {
            from: metadata.orchestratorTarget,
            message: { text: replyText, attachments: replyMessage.content.attachments },
            messageId: replyMessage.id,
            timestamp: replyMessage.timestamp,
            subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
          });
          return {
            content: [{ type: "text", text: `**Reply from supervisor:**\n${replyText}${replyAttachments}` }],
            isError: false,
            ...(structuredReply
              ? { details: structuredReply.value !== undefined ? { structuredReply: structuredReply.value } : { structuredReplyParseError: structuredReply.error } }
              : {}),
          };
        } catch (error) {
          if (error instanceof AskDeliveryError) {
            return {
              content: [{ type: "text", text: `Message to "${metadata.orchestratorTarget}" was not delivered: ${error.message}` }],
              isError: true,
              details: { error: true },
            };
          }
          const errorMessage = getErrorMessage(error);
          return {
            content: [{ type: "text", text: errorMessage === "Cancelled" ? "Cancelled" : `Failed: ${errorMessage}` }],
            isError: true,
            details: { error: true },
          };
        }
        })());
      },
      renderCall(args: ContactSupervisorToolParams, theme: ToolRenderTheme) {
        const reason = typeof args.reason === "string" ? args.reason : "contact";
        const messagePreview = previewText(args.message, 96);
        const interview = args.interview && typeof args.interview === "object" ? args.interview as { title?: unknown } : undefined;
        let text = theme.fg("toolTitle", theme.bold("contact_supervisor "));
        text += theme.fg(reason === "need_decision" ? "warning" : reason === "progress_update" ? "muted" : "accent", reason);
        if (typeof interview?.title === "string" && interview.title.trim()) {
          text += " " + theme.fg("accent", interview.title.trim());
        }
        if (messagePreview) {
          text += "\n  " + theme.fg("dim", messagePreview);
        }
        return new Text(text, 0, 0);
      },
      renderResult(result: ToolResultLike, { isPartial }: { isPartial: boolean }, theme: ToolRenderTheme, context: ToolRenderContext) {
        if (isPartial) {
          return new Text(theme.fg("warning", "Waiting for supervisor..."), 0, 0);
        }
        const details = result.details as { accepted?: boolean; delivered?: boolean; queued?: boolean; error?: boolean; messageId?: string; reason?: string; structuredReplyParseError?: string } | undefined;
        const textContent = firstTextContent(result);
        const failed = Boolean(context.isError || details?.error === true || details?.accepted === false);
        const parseWarning = typeof details?.structuredReplyParseError === "string";
        let text = failed
          ? theme.fg("error", "✗ ")
          : parseWarning
            ? theme.fg("warning", "⚠ ")
            : theme.fg("success", "✓ ");
        text += theme.fg(failed ? "error" : "text", textContent);
        if (parseWarning) {
          text += "\n" + theme.fg("warning", `Structured reply parse issue: ${details.structuredReplyParseError}`);
        }
        return new Text(text, 0, 0);
      },
    } as never);
  }

  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another pi session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.
Non-blocking send defaults to steer for guidance, answers, corrections, or blockers that may affect active work. Use queue only when delay is intentional; use ask only when this process must remain alive waiting for the reply.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "send", to: "session-name", message: "..." })  → Send live coordination (defaults to steer)
  intercom({ action: "ask", to: "session-name", delivery: "steer", message: "..." })   → Blocking wait only when sender must stay alive
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Coordinate with local Pi sessions. Non-blocking send defaults to steer for live agent guidance; queue only for intentional delay and ask only for a required blocking reply.",
    promptGuidelines: [
      "Action='send' defaults to delivery='steer' for agent-to-agent guidance, answers, corrections, blockers, or other context that may affect active work.",
      "Use delivery='queue' only when delay is intentional, and passive only when the recipient model should not see the message now.",
      "Treat inbound steered messages as supplemental coordination within the active task: incorporate relevant context and continue; replace the task only when the message explicitly says so.",
      "Use action='reply' for an active inbound ask. Otherwise respond with send plus steer; use blocking ask only when this process must stay alive and cannot safely continue without the answer.",
    ],

    parameters: Type.Object({
      action: StringEnum(["list", "send", "ask", "reply", "pending", "status"] as const, {
        description: "Action: 'list', 'send', 'ask', 'reply', 'pending', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action)",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: StringEnum(["file", "snippet", "context"] as const),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading or responding to an 'ask')",
      })),
      delivery: Type.Optional(StringEnum(["queue", "steer", "passive"] as const, {
        description: "Delivery mode. Omitted send delivery defaults to 'steer', which injects after the current tool call. Use 'queue' only to intentionally wait behind active work; 'passive' does not wake the recipient model.",
      })),
      queueMode: Type.Optional(StringEnum(["stack", "replace"] as const, {
        description: "For delivery='queue': 'stack' keeps all messages; 'replace' keeps only the latest undelivered message for the same threadId.",
      })),
      threadId: Type.Optional(Type.String({
        description: "Stable topic key for queueMode='replace'.",
      })),
      passive: Type.Optional(Type.Boolean({
        description: "For action='send' only: legacy alias for delivery='passive'. Discouraged for agent-to-agent messages.",
      })),
    }),

    async execute(_toolCallId: string, params: IntercomToolParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      return throwIfToolError(await (async () => {
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          isError: true,
          details: { error: true },
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { action, to, message, attachments, replyTo, delivery, queueMode, threadId, passive } = params;
      if (passive !== undefined && action !== "send") {
        return {
          content: [{ type: "text", text: "'passive' is only valid for action='send'" }],
          isError: true,
          details: { error: true },
        };
      }
      if (delivery === "passive" && action !== "send") {
        return {
          content: [{ type: "text", text: "delivery='passive' is only valid for action='send'. Passive delivery is for human-visible breadcrumbs and is discouraged for agent-to-agent coordination; normal send defaults to steer. Use ask with delivery='steer' only when the sender must stay alive and cannot safely continue without the reply." }],
          isError: true,
          details: { error: true },
        };
      }
      if ((delivery !== undefined || queueMode !== undefined || threadId !== undefined) && action !== "send" && action !== "ask") {
        return {
          content: [{ type: "text", text: "'delivery', 'queueMode', and 'threadId' are only valid for action='send' or action='ask'" }],
          isError: true,
          details: failureDetails(queueMode !== undefined || delivery === "queue" || threadId !== undefined ? "invalid_queue_arguments" : "invalid_delivery_arguments", [{ action: "send", guidance: "Use delivery options only with send or ask." }], { error: true }),
        };
      }
      if (passive === true && delivery !== undefined && delivery !== "passive") {
        return {
          content: [{ type: "text", text: "'passive' cannot be combined with a non-passive delivery mode" }],
          isError: true,
          details: { error: true },
        };
      }
      if (threadId !== undefined && queueMode !== "replace") {
        return {
          content: [{ type: "text", text: "'threadId' is only valid with queueMode='replace'" }],
          isError: true,
          details: failureDetails("invalid_queue_arguments", [{ action: "send", guidance: "Use threadId only with delivery='queue' and queueMode='replace'." }], { error: true }),
        };
      }
      if (queueMode === "replace" && (!threadId || !threadId.trim())) {
        return {
          content: [{ type: "text", text: "queueMode='replace' requires a non-empty threadId" }],
          isError: true,
          details: failureDetails("invalid_queue_arguments", [{ action: "send", guidance: "Provide a non-empty threadId with delivery='queue' and queueMode='replace'." }], { error: true }),
        };
      }
      const deliveryMode = (passive === true ? "passive" : delivery) as MessageDelivery | undefined;
      const cleanedThreadId = typeof threadId === "string" ? threadId.trim() : undefined;
      if (queueMode !== undefined && deliveryMode !== "queue") {
        return {
          content: [{ type: "text", text: "'queueMode' is only valid with delivery='queue'. Use queue only for intentionally deferred work; otherwise omit queueMode and use default-steered send for live agent coordination. Avoid passive for agent-to-agent coordination." }],
          isError: true,
          details: failureDetails("invalid_queue_arguments", [{ action: "send", guidance: "Set delivery='queue', or omit queueMode and threadId." }], { error: true }),
        };
      }

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            if (!mySessionId) throw new Error("Current intercom session id is unavailable.");
            const sessions = await connectedClient.listSessions();
            return {
              content: [{ type: "text", text: formatSessionListSections(sessions, mySessionId) }],
              isError: false,
              details: { sessionCount: sessions.length },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "send": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }
          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            if (!replyTo && config.confirmSend && ctx.hasUI) {
              const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
              const confirmed = await ctx.ui.confirm(
                "Send Message",
                `Send to "${to}":\n\n${message}${attachmentText}`,
              );
              if (!confirmed) {
                return {
                  content: [{ type: "text", text: "Message cancelled by user" }],
                  isError: false,
                };
              }
            }
            const result = await connectedClient.send(sendTo, {
              text: message,
              attachments,
              replyTo,
              delivery: deliveryMode,
              queueMode: queueMode as QueueMode | undefined,
              threadId: cleanedThreadId,
              passive: passive === true,
            });
            if (!result.accepted) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: failureDetails("delivery_failed", [{ action: "list" }, { action: "send", guidance: "Retry with an exact active recipient target." }], { messageId: result.id, accepted: result.accepted, delivered: false, reason: result.reason }),
              };
            }
            markIntercomActivity();
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo, delivery: deliveryMode, queueMode, threadId: cleanedThreadId, passive: passive === true },
              messageId: result.id,
              timestamp: Date.now(),
            });
            if (replyTo) {
              replyTracker.markReplied(replyTo);
            }
            syncPresenceStatus();
            const replyModeHint = replyTo
              ? ""
              : deliveryMode === "passive"
                ? " (passive; recipient model was not woken)"
                : deliveryMode === "steer"
                  ? " (steers active recipient after the current tool call)"
                  : deliveryMode === "queue"
                    ? " (intentionally deferred behind active recipient work)"
                    : " (defaults to steer; wakes idle recipients and steers active recipients after the current tool call)";
            return {
              content: [{ type: "text", text: result.queued ? `Message queued for ${to} (${result.reason ?? "queued"})` : `Message sent to ${to}${replyModeHint}` }],
              isError: false,
              details: { messageId: result.id, accepted: result.accepted, delivered: result.delivered, queued: result.queued === true, reasonCode: result.queued ? "message_queued" : "message_accepted" },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
              isError: true,
              details: failureDetails(getErrorMessage(error).startsWith("Target ") ? "ambiguous_target" : "send_failed", [{ action: "list" }, { action: "send", guidance: "Retry with an exact active recipient target." }], { error: true }),
            };
          }
        }

        case "ask": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          if (replyWaiter) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply" }],
              isError: true,
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }
          let questionId: string | undefined;

          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                isError: true,
                details: { error: true },
              };
            }
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const peerHealth = await resolvePeerHealth(connectedClient, sendTo);
            const peerIdle = peerDeclinesAsks(peerHealth) && deliveryMode === undefined;
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                isError: true,
                details: { error: true },
              };
            }
            questionId = randomUUID();
            const sendOptions = {
              text: message,
              attachments,
              replyTo,
              delivery: deliveryMode,
              queueMode: queueMode as QueueMode | undefined,
              threadId: cleanedThreadId,
            };
            const recordSent = (sendResult: SendResult) => pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo, delivery: deliveryMode, queueMode, threadId: cleanedThreadId },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            let replyMessage: Message;
            if (peerIdle) {
              const sendResult = await connectedClient.send(sendTo, { ...sendOptions, messageId: questionId, expectsReply: true });
              if (!sendResult.accepted) throw new AskDeliveryError(sendResult);
              markIntercomActivity();
              syncPresenceStatus();
              recordSent(sendResult);
              return {
                content: [{ type: "text", text: `Delivered ask to ${to}; peer reports it is not accepting asks right now (peer_idle).` }],
                isError: false,
                details: { messageId: sendResult.id, delivered: true, replied: false, reason: "peer_idle", reasonCode: "recipient_not_accepting_asks", nextActions: [{ action: "send", guidance: "Use default-steered send for non-blocking live coordination; queue only when delay is intentional." }] },
              };
            }
            replyMessage = await sendAskTransaction(connectedClient, sendTo, questionId, sendOptions, _signal, recordSent);
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            pi.appendEntry("intercom_received", {
              from: to,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            const recipientTurnFailure = replyMessage.content.attachments?.some((attachment) => attachment.name === RECIPIENT_TURN_FAILED_ATTACHMENT);
            if (recipientTurnFailure) {
              return {
                content: [{ type: "text", text: replyText }],
                isError: true,
                details: failureDetails("recipient_turn_failed", [{ action: "status" }, { action: "send", guidance: "Send recovery context after the recipient is healthy." }], { error: true, recipientTurnFailed: true, messageId: replyMessage.id, replyTo: questionId }),
              };
            }
            return {
              content: [{ type: "text", text: `**Reply from ${to}:**\n${replyText}${replyAttachments}` }],
              isError: false,
            };
          } catch (error) {
            if (error instanceof AskDeliveryError) {
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${error.message}` }],
                isError: true,
                details: failureDetails("delivery_failed", [{ action: "list" }, { action: "send", guidance: "Retry with an exact active recipient target." }], { error: true, messageId: error.result.id, accepted: false, delivered: false, reason: error.result.reason }),
              };
            }
            const errorMessage = getErrorMessage(error);
            const timedOut = errorMessage.startsWith("No reply from");
            return {
              content: [{ type: "text", text: `Failed: ${errorMessage}` }],
              isError: true,
              details: failureDetails(timedOut ? "reply_timeout" : errorMessage.startsWith("Target ") ? "ambiguous_target" : "ask_failed", [{ action: "status" }, { action: "list" }, { action: "send", guidance: "Check the recipient before retrying; the original ask may still be seen." }], { error: true, ...(questionId ? { messageId: questionId } : {}) }),
            };
          }
        }

        case "reply": {
          if (!message) {
            return {
              content: [{ type: "text", text: "Missing 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          try {
            const target = replyTracker.resolveReplyTarget({ to, replyTo });
            if (target.from.id === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const result = await connectedClient.send(target.from.id, {
              text: message,
              attachments,
              replyTo: target.message.id,
            });
            if (!result.accepted) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Reply to "${target.from.name || target.from.id}" was not delivered: ${errorText}` }],
                isError: true,
                details: failureDetails("delivery_failed", [{ action: "pending" }, { action: "send", guidance: "Send a new message if the original sender is no longer available." }], { messageId: result.id, accepted: result.accepted, delivered: false, queued: result.queued === true, reason: result.reason, replyTo: target.message.id }),
              };
            }
            replyTracker.markReplied(target.message.id);
            markIntercomActivity();
            syncPresenceStatus();
            pi.appendEntry("intercom_sent", {
              to: target.from.name || target.from.id,
              message: { text: message, replyTo: target.message.id },
              messageId: result.id,
              timestamp: Date.now(),
            });
            return {
              content: [{ type: "text", text: `Reply sent to ${target.from.name || target.from.id}` }],
              isError: false,
              details: { messageId: result.id, delivered: true, replyTo: target.message.id, reasonCode: "reply_sent" },
            };
          } catch (error) {
            const errorMessage = getErrorMessage(error);
            const reasonCode = replyFailureReason(errorMessage);
            return {
              content: [{ type: "text", text: `Failed to reply: ${errorMessage}` }],
              isError: true,
              details: failureDetails(reasonCode, reasonCode === "no_pending_reply"
                ? [{ action: "pending" }, { action: "send", guidance: "Use send with an explicit recipient when there is no inbound ask to reply to." }]
                : [{ action: "pending" }, { action: "list" }], { error: true, ...(replyTo ? { replyTo } : {}) }),
            };
          }
        }

        case "pending": {
          const pendingAsks = replyTracker.listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              isError: false,
            };
          }

          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = pendingAskPreview(message);
            const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
            const sender = from.name ? `${from.name} (${formatSessionTarget(from, pendingAsks.map((ask) => ask.from))})` : from.id;
            const replyTo = JSON.stringify(message.id);
            return `- ${sender} · replyTo: ${replyTo} · ${elapsedSeconds}s ago · ${preview}\n  Reply: intercom({ action: "reply", replyTo: ${replyTo}, message: "..." })`;
          });
          return {
            content: [{ type: "text", text: `**Pending asks:**\n${lines.join("\n")}` }],
            isError: false,
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            if (!mySessionId) throw new Error("Current intercom session id is unavailable.");
            const sessions = await connectedClient.listSessions();
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nActive sessions: ${sessions.length}\n\n${formatSessionListSections(sessions, mySessionId)}`,
              }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            isError: true,
            details: { error: true },
          };
      }
      })());
    },
    renderCall(args: IntercomToolParams, theme: ToolRenderTheme) {
      const action = typeof args.action === "string" ? args.action : "intercom";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messagePreview = previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("intercom "));
      text += theme.fg(action === "ask" ? "warning" : action === "reply" ? "success" : "accent", action);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (attachmentCount > 0) {
        text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      }
      if (messagePreview) {
        text += "\n  " + theme.fg("dim", messagePreview);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result: ToolResultLike, { expanded, isPartial }: { expanded?: boolean; isPartial: boolean }, theme: ToolRenderTheme, context: ToolRenderContext) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Intercom working..."), 0, 0);
      }
      const details = result.details as { accepted?: boolean; delivered?: boolean; queued?: boolean; error?: boolean; messageId?: string; reason?: string; sessionCount?: number } | undefined;
      const failed = Boolean(context.isError || details?.error === true || details?.accepted === false);
      const action = context.args && typeof context.args === "object" && "action" in context.args
        ? (context.args as { action?: unknown }).action
        : undefined;
      if (!failed && action === "list" && !expanded) {
        const summary = details?.sessionCount === undefined
          ? "Sessions listed"
          : `${details.sessionCount} session${details.sessionCount === 1 ? "" : "s"}`;
        return new Text(`${theme.fg("success", "✓ ")}${theme.fg("text", summary)} ${theme.fg("dim", "(Ctrl+O to expand)")}`, 0, 0);
      }
      let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      text += theme.fg(failed ? "error" : "text", firstTextContent(result));
      if (details?.messageId && !expanded) {
        text += theme.fg("dim", ` (${details.messageId.slice(0, 8)})`);
      }
      if (details?.reason && expanded) {
        text += "\n" + theme.fg("dim", `Reason: ${details.reason}`);
      }
      return new Text(text, 0, 0);
    },
  } as never);

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    const overlayGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, overlayGeneration);
    if (!liveContext?.hasUI) return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      if (!getLiveContext(ctx, overlayGeneration)) return;
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        notifyIfLive(ctx, "Current session is missing from intercom session list", "error", overlayGeneration);
        return;
      }
      currentSession = foundCurrentSession;
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }

    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (tui, theme, keybindings, done) => new SessionListOverlay(tui, theme, keybindings, currentSession, sessions, done),
      { overlay: true }
    ).catch(() => undefined);

    if (!selectedSession || !getLiveContext(ctx, overlayGeneration)) return;

    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    const targetLabel = targetDisplayName(selectedSession, [...sessions, currentSession]);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done),
      { overlay: true }
    ).catch(() => undefined);

    if (result?.sent && result.messageId && result.text && getLiveContext(ctx, overlayGeneration)) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text, expectsReply: result.expectsReply },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      notifyIfLive(ctx, `${result.expectsReply ? "Ask sent" : "Message sent"} to ${targetLabel}`, "info", overlayGeneration);
    }
  }

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
