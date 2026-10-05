import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChildMessageHeader,
  ObservedMessage,
  ReadonlyInput,
  ResourceLimitExceeded,
} from "../../shared/types.ts";
import { providerQualifiedModelId } from "../../shared/model-info.ts";
import {
  extractTextFromContent,
  extractToolArgsPreview,
  getFinalOutput,
} from "../../shared/utils.ts";
import {
  appendClaudeCodeMessage,
  claudeCodeMessageFromResult,
  writeClaudeCodeSessionMetadata,
} from "./claude-code.ts";
import type { ClaudeCodeResultEvent } from "./claude-types.ts";
import { ChildBoundaries } from "./child-boundaries.ts";
import type {
  ChildAttemptOptions,
  ChildAttemptResult,
  ChildEvent,
  ChildObservation,
} from "./child-attempt-types.ts";
import {
  addUsage,
  nativeUsageMetadata,
  validateNativeUsage,
  type NativeBaseline,
  type NativeUsageMetadata,
} from "./native-usage.ts";
import { compactObservedMessage } from "./child-observations.ts";
import {
  observedMessage,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requiredString,
} from "./child-message-validation.ts";
import { errorText, isObject, nonempty } from "./child-json.ts";
import {
  createMutationCompletionTracker,
  resolveCurrentPath,
  type MutationToolResult,
} from "./mutating-tool-guard.ts";
import {
  createRepeatedSubagentCallGuardState,
  recordToolEndForSubagentLoopGuard,
  recordToolStartForSubagentLoopGuard,
} from "./subagent-tool-loop-guard.ts";

interface EventControls {
  readonly observeLifecycle: (type?: string) => void;
  readonly stopping: () => boolean;
  readonly stop: (outcome: Pick<ChildAttemptResult, "error" | "timedOut" | "interrupted">) => void;
  readonly resourceLimit: (
    kind: ResourceLimitExceeded["kind"],
    limit: number,
    observed?: number,
  ) => void;
  readonly resetTimer: () => void;
  readonly reference: (entry: NativeUsageMetadata) => ChildObservation | undefined;
}

function childEvent(value: Readonly<Record<string, unknown>>): ChildEvent {
  const update = isObject(value.assistantMessageEvent) ? value.assistantMessageEvent : undefined;
  if (value.args !== undefined && !isObject(value.args)) {
    throw new SyntaxError("Invalid child tool arguments");
  }
  const type = optionalString(value.type, "child event type");
  const fields = {
    ...value,
    type,
    message: undefined,
    toolCallId: optionalString(value.toolCallId, "toolCallId"),
    toolName: optionalString(value.toolName, "toolName"),
    args: value.args,
    isError: optionalBoolean(value.isError, "isError"),
    assistantMessageEvent: update
      ? {
          ...update,
          type: requiredString(update.type, "assistant update type"),
          delta: optionalString(update.delta, "delta"),
          contentIndex: optionalNumber(update.contentIndex, "contentIndex"),
        }
      : undefined,
  };
  if (type === "message_end") {
    return {
      ...fields,
      type,
      message: value.message === undefined ? undefined : observedMessage(value.message),
    };
  }
  if (type === "message_start" || type === "message_update") {
    return {
      ...fields,
      type,
      message: value.message === undefined ? undefined : messageHeader(value.message),
    };
  }
  return fields;
}
function messageHeader(value: unknown): ChildMessageHeader {
  if (!isObject(value)) {
    throw new SyntaxError("Invalid native message header");
  }
  return {
    ...value,
    role: requiredString(value.role, "message role"),
    timestamp: optionalNumber(value.timestamp, "timestamp"),
  };
}

function claudeResult(value: Readonly<Record<string, unknown>>): ClaudeCodeResultEvent {
  const usage = isObject(value.usage) ? value.usage : undefined;
  const models = isObject(value.modelUsage) ? value.modelUsage : undefined;
  const modelUsage: Record<string, { contextWindow?: number; maxOutputTokens?: number }> = {};
  for (const [name, metadata] of Object.entries(models ?? {})) {
    if (!isObject(metadata)) {
      throw new SyntaxError("Invalid Claude model usage");
    }
    modelUsage[name] = {
      contextWindow: optionalNumber(metadata.contextWindow, "contextWindow"),
      maxOutputTokens: optionalNumber(metadata.maxOutputTokens, "maxOutputTokens"),
    };
  }
  return {
    ...value,
    type: optionalString(value.type, "type"),
    subtype: optionalString(value.subtype, "subtype"),
    is_error: optionalBoolean(value.is_error, "is_error"),
    api_error_status:
      value.api_error_status === null
        ? null
        : optionalNumber(value.api_error_status, "api_error_status"),
    result: optionalString(value.result, "result"),
    stop_reason: optionalString(value.stop_reason, "stop_reason"),
    session_id: optionalString(value.session_id, "session_id"),
    total_cost_usd: optionalNumber(value.total_cost_usd, "total_cost_usd"),
    usage: usage
      ? {
          input_tokens: optionalNumber(usage.input_tokens, "input_tokens"),
          output_tokens: optionalNumber(usage.output_tokens, "output_tokens"),
          cache_read_input_tokens: optionalNumber(
            usage.cache_read_input_tokens,
            "cache_read_input_tokens",
          ),
          cache_creation_input_tokens: optionalNumber(
            usage.cache_creation_input_tokens,
            "cache_creation_input_tokens",
          ),
        }
      : undefined,
    modelUsage: models ? modelUsage : undefined,
  };
}

function assistantStoppedCleanly(
  message: Extract<ObservedMessage, { role: "assistant" }>,
): boolean {
  return (
    message.stopReason === "stop" &&
    !nonempty(message.errorMessage) &&
    !message.content.some((part) => part.type === "toolCall")
  );
}

/** Owns live message facts and provisional accounting; native publication is verified at finish. */
export class ChildEventObserver {
  readonly result: ChildAttemptResult;
  readonly baseline: Set<string>;
  readonly acceptedEntries = new Map<string, NativeUsageMetadata>();
  readonly boundaries: ChildBoundaries;
  private readonly options: ReadonlyInput<ChildAttemptOptions>;
  private readonly controls: EventControls;
  private readonly baselineSnapshot: NativeBaseline;
  private readonly startedAt: number;
  private readonly streamId = randomUUID();
  private readonly mutations = createMutationCompletionTracker();
  private readonly toolLoop = createRepeatedSubagentCallGuardState();
  private nativeMessageCount = 0;
  private assistantTokens = 0;
  assistantError?: string;
  cleanAssistantStop = false;
  lastOutput = "";

  constructor(
    options: ReadonlyInput<ChildAttemptOptions>,
    baseline: NativeBaseline,
    controls: EventControls,
    startedAt: number,
  ) {
    this.options = options;
    this.controls = controls;
    this.baselineSnapshot = baseline;
    this.baseline = new Set(baseline.ids);
    this.startedAt = startedAt;
    this.result = {
      stderr: "",
      exitCode: 0,
      messages: [],
      model: options.model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      finalOutput: "",
      observedCompletedMutation: false,
      durationMs: 0,
      attemptBaseline: [...this.baseline],
    };
    this.boundaries = new ChildBoundaries(
      {
        config: options.nativeFinalization,
        maxTokens: options.maxTokens,
        maxExecutionTimeMs: options.maxExecutionTimeMs,
        onLimit: controls.resourceLimit,
        onReset: controls.resetTimer,
        onMarker: (marker) => {
          this.result.finalization = this.boundaries.snapshot();
          options.onEvent?.(marker, this.result);
        },
      },
      startedAt,
    );
  }
  sync(): void {
    this.result.finalization = this.boundaries.sync(this.result.messages, this.nativeMessageCount);
  }

  private prepare(raw: Readonly<Record<string, unknown>>): ChildEvent {
    let event = childEvent(raw);
    if (event.type === "message_end" && !event.message) {
      throw new Error("Child message_end event is missing its message");
    }
    if (event.type !== "message_update") {
      this.sync();
    }
    if (event.type === "subagent.native_baseline") {
      this.reconcileBaseline(raw);
    }
    if (event.type === "subagent.native") {
      event = { ...event, ...this.observeNative(raw) };
    }
    return this.observeLifecycleAndClaude(event, raw);
  }
  private observeLifecycleAndClaude(
    event: ChildEvent,
    raw: Readonly<Record<string, unknown>>,
  ): ChildEvent {
    const isClaudeResult =
      this.options.claudeCodeInvocation !== undefined && event.type === "result";
    this.controls.observeLifecycle(isClaudeResult ? "agent_settled" : event.type);
    return isClaudeResult
      ? { type: "message_end", message: this.observeClaude(claudeResult(raw)) }
      : event;
  }
  process(
    raw: Readonly<Record<string, unknown>>,
    textWritten: boolean,
  ): { messageCount: number; message?: ObservedMessage } {
    const event = this.prepare(raw);
    const loopFailure = this.observeTool(event);
    let mutation: MutationToolResult | undefined;
    if (event.type === "message_end" && event.message) {
      this.observeMessage(event.message, textWritten);
      if (event.message.role === "toolResult") {
        mutation = this.observeMutation(event.message);
      }
    }
    this.result.durationMs = Date.now() - this.startedAt;
    this.options.onEvent?.(event, this.result, mutation);
    if (nonempty(loopFailure) && !this.controls.stopping()) {
      this.result.terminalFailure = true;
      this.controls.stop({ error: loopFailure });
    }
    if (event.type === "message_end") {
      this.sync();
    }
    this.enforceTokenLimit();
    return { messageCount: this.nativeMessageCount, message: this.result.messages.at(-1) };
  }
  private enforceTokenLimit(): void {
    const tokens = this.assistantTokens - this.boundaries.assistantTokens;
    if (this.options.maxTokens !== undefined && tokens >= this.options.maxTokens) {
      this.controls.resourceLimit("maxTokens", this.options.maxTokens, tokens);
    }
  }

  private reconcileBaseline(value: Readonly<Record<string, unknown>>): void {
    const ids: unknown = value.entryIds;
    if (
      !this.baselineSnapshot.legacy ||
      value.sessionId !== this.baselineSnapshot.sessionId ||
      !Array.isArray(ids)
    ) {
      throw new Error("Cannot reconcile native legacy baseline");
    }
    const entryIds = ids.map((id: unknown) => requiredString(id, "baseline entry ID"));
    if (
      new Set(entryIds).size !== this.baselineSnapshot.entryCount ||
      entryIds.some((id) => id.length === 0)
    ) {
      throw new Error("Cannot reconcile native legacy baseline");
    }
    this.baseline.clear();
    this.baseline.add(requiredString(value.sessionId, "baseline session ID"));
    for (const id of entryIds) {
      this.baseline.add(id);
    }
    this.result.attemptBaseline = [...this.baseline];
  }

  private observeNative(value: Readonly<Record<string, unknown>>): {
    nativeReferences: { messageNumber?: number; entryId: string }[];
    referenceState: string;
  } {
    if (!Array.isArray(value.entries)) {
      throw new SyntaxError("Invalid native entries observation");
    }
    const entries = value.entries.map((entry: unknown) => nativeUsageMetadata(entry));
    this.result.nativeSessionId = requiredString(value.sessionId, "native session ID");
    this.result.terminalLeafId =
      value.leafId === null ? null : optionalString(value.leafId, "leafId");
    this.result.terminalEntryId = entries.at(-1)?.id ?? this.result.terminalEntryId;
    this.result.effectiveConfiguration = this.configuration(value.configuration);
    const nativeReferences: { messageNumber?: number; entryId: string }[] = [];
    for (const entry of entries) {
      if (value.persisted !== true) {
        this.acceptedEntries.set(entry.id, entry);
      } else if (entry.message && !this.baseline.has(entry.id)) {
        const observation = this.controls.reference(entry);
        if (observation) {
          nativeReferences.push({ messageNumber: observation.number, entryId: entry.id });
        }
      }
    }
    return { nativeReferences, referenceState: "observed" };
  }
  private configuration(value: unknown): ChildAttemptResult["effectiveConfiguration"] {
    if (value === undefined) {
      return;
    }
    if (!isObject(value)) {
      throw new SyntaxError("Invalid native configuration");
    }
    return {
      model: optionalString(value.model, "configuration.model"),
      thinking: optionalString(value.thinking, "configuration.thinking"),
      modelRecordedAt: optionalNumber(value.modelRecordedAt, "configuration.modelRecordedAt"),
    };
  }

  private observeClaude(event: ClaudeCodeResultEvent): ObservedMessage {
    const invocation = this.options.claudeCodeInvocation;
    if (!invocation) {
      throw new Error("Missing Claude invocation");
    }
    this.result.accounting = {
      state: "incomplete",
      error:
        "Claude Code did not provide the complete native usage/cost receipt. Reported totals and its audit were retained.",
    };
    if (this.options.structuredOutput && event.structured_output !== undefined) {
      fs.mkdirSync(path.dirname(this.options.structuredOutput.outputPath), { recursive: true });
      fs.writeFileSync(
        this.options.structuredOutput.outputPath,
        `${JSON.stringify(event.structured_output)}\n`,
        "utf8",
      );
    }
    const message = claudeCodeMessageFromResult(event, invocation.model.inputModel);
    if (nonempty(this.options.sessionFile)) {
      writeClaudeCodeSessionMetadata(this.options.sessionFile, {
        sessionId: nonempty(event.session_id) ? event.session_id : invocation.sessionId,
        model: invocation.model.inputModel,
        cliModel: invocation.model.cliModel,
        family: invocation.model.family,
        context: invocation.model.context,
        updatedAt: Date.now(),
      });
      const { result: _result, structured_output: _structured, ...observation } = event;
      appendClaudeCodeMessage(this.options.sessionFile, message, observation);
    }
    return message;
  }

  private observeTool(event: ChildEvent): string | undefined {
    let loopFailure: string | undefined;
    if (event.type === "tool_execution_start") {
      loopFailure = recordToolStartForSubagentLoopGuard({
        state: this.toolLoop,
        ...event,
        toolName: event.toolName,
        args: event.args,
      });
      this.mutations.recordToolStart({
        id: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        path: resolveCurrentPath(event.toolName, event.args),
        startedAt: Date.now(),
      });
      const args = extractToolArgsPreview(event.args ?? {});
      if (nonempty(event.toolName)) {
        this.options.onOutput?.(`${event.toolName}${args.length > 0 ? `: ${args}` : ""}\n`);
      }
    } else if (event.type === "tool_execution_end") {
      loopFailure = recordToolEndForSubagentLoopGuard({
        state: this.toolLoop,
        ...event,
        toolName: event.toolName,
        isError: event.isError,
      });
    }
    return loopFailure;
  }
  private observeMutation(
    message: Extract<ObservedMessage, { role: "toolResult" }>,
  ): MutationToolResult | undefined {
    const mutation = this.mutations.recordToolResult(message);
    if (mutation?.completedMutation === true) {
      this.result.observedCompletedMutation = true;
    }
    return mutation;
  }

  private observeMessage(message: ObservedMessage, textWritten: boolean): void {
    if (message.role === "assistant" && !message.usage) {
      this.result.accounting = {
        state: "incomplete",
        error: "Required assistant usage is unavailable; execution was not repeated.",
      };
    }
    const final = getFinalOutput([message]);
    if (final.length > 0) {
      this.lastOutput = final;
    }
    this.result.messages.push(compactObservedMessage(message));
    if (["assistant", "user", "toolResult"].includes(message.role)) {
      this.nativeMessageCount++;
    }
    this.result.messageCount = this.nativeMessageCount;
    const text = this.emitMessageText(message, textWritten);
    if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
      this.observeUsage(message);
    }
    if (message.role === "assistant") {
      this.observeAssistant(message, text);
    }
  }
  private emitMessageText(message: ObservedMessage, textWritten: boolean): string {
    const text = extractTextFromContent(message.content);
    if (textWritten) {
      this.options.onOutput?.("\n");
    } else if (this.options.claudeCodeInvocation && text.length > 0) {
      this.options.onOutput?.(`${text}\n`);
    }
    return text;
  }
  private observeUsage(
    message: Extract<ObservedMessage, { role: "assistant" | "toolResult" }>,
  ): void {
    if (!message.usage) {
      return;
    }
    try {
      addUsage(this.result.usage, message.usage, {
        id: `stream:${this.streamId}:${this.result.messages.length}`,
        provider: message.role === "assistant" ? message.provider : undefined,
        model: message.role === "assistant" ? (message.responseModel ?? message.model) : undefined,
      });
      validateNativeUsage(message.usage);
    } catch (error) {
      this.result.accounting = { state: "incomplete", error: errorText(error) };
    }
  }
  private observeAssistant(
    message: Extract<ObservedMessage, { role: "assistant" }>,
    text: string,
  ): void {
    this.result.model ??= providerQualifiedModelId(message.provider, message.model);
    this.result.usage.turns++;
    this.assistantTokens += (message.usage?.input ?? 0) + (message.usage?.output ?? 0);
    if (nonempty(message.errorMessage)) {
      this.assistantError = message.errorMessage;
    }
    this.cleanAssistantStop = assistantStoppedCleanly(message);
    if (this.cleanAssistantStop && text.trim().length > 0) {
      this.assistantError = undefined;
    }
  }
}
