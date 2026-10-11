import type { ReadonlyDeep } from "type-fest";
import type { ChildEvent } from "../shared/child-attempt.ts";
import type { ResolvedControlConfig } from "../../shared/types.ts";
import { extractTextFromContent, extractToolArgsPreview } from "../../shared/utils.ts";
import { buildControlEvent } from "../shared/subagent-control.ts";
import {
  createMutatingFailureState,
  type MutationToolResult,
  recordMutatingFailure,
  resetMutatingFailureState,
  resolveCurrentPath,
  shouldEscalateMutatingFailures,
  summarizeRecentMutatingFailures,
} from "../shared/mutating-tool-guard.ts";
import { stripAcceptanceReport } from "../shared/acceptance.ts";
import { updateStreamingText } from "../shared/streaming-text.ts";
import {
  appendRecentStepOutput,
  clearStepCurrentActivity,
  type RunnerStatusPayload,
} from "./runner-status.ts";

interface ObserverHooks {
  readonly clearAttention: (index: number) => void;
  readonly notify: (event: ReadonlyDeep<ReturnType<typeof buildControlEvent>>) => void;
  readonly scheduleWrite: () => void;
}

function messageUsage(message: unknown): Readonly<{ input: number; output: number }> | undefined {
  if (typeof message !== "object" || message === null || !("usage" in message)) {
    return;
  }
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) {
    return;
  }
  return {
    input: "input" in usage && typeof usage.input === "number" ? usage.input : 0,
    output: "output" in usage && typeof usage.output === "number" ? usage.output : 0,
  };
}

/** Owns the live event projection and mutating-tool failure windows. */
export class RunnerChildObserver {
  private readonly statusPayload: RunnerStatusPayload;
  private readonly controlConfig: ReadonlyDeep<ResolvedControlConfig>;
  private readonly id: string;
  private readonly hooks: ObserverHooks;
  private readonly mutatingFailureStates;
  private readonly mutatingFailureWindowMs = 5 * 60_000;

  constructor(
    statusPayload: RunnerStatusPayload,
    config: ReadonlyDeep<{ id: string; controlConfig: ResolvedControlConfig }>,
    hooks: ObserverHooks,
  ) {
    this.statusPayload = statusPayload;
    this.controlConfig = config.controlConfig;
    this.id = config.id;
    this.hooks = hooks;
    this.mutatingFailureStates = statusPayload.steps.map(() => createMutatingFailureState());
  }

  expandChildren(flatIndex: number, count: number): void {
    this.mutatingFailureStates.splice(
      flatIndex,
      1,
      ...Array.from({ length: count }, () => createMutatingFailureState()),
    );
  }

  private syncTopLevelCurrentTool(): void {
    const active = this.statusPayload.steps
      .filter(
        (step) =>
          step.status === "running" &&
          typeof step.currentTool === "string" &&
          step.currentTool.length > 0,
      )
      .sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))
      .at(0);
    this.statusPayload.currentTool = active?.currentTool;
    this.statusPayload.currentToolStartedAt = active?.currentToolStartedAt;
    this.statusPayload.currentPath = active?.currentPath;
  }

  updateStepFromChildEvent(
    flatIndex: number,
    event: ReadonlyDeep<ChildEvent>,
    toolSnapshot?: ReadonlyDeep<MutationToolResult>,
  ): void {
    const step = this.statusPayload.steps.at(flatIndex);
    if (!step) {
      return;
    }
    const now = Date.now();
    this.statusPayload.currentStep = flatIndex;
    if (step.activityState === "needs_attention") {
      step.activityState = undefined;
      this.hooks.clearAttention(flatIndex);
      this.statusPayload.activityState = this.statusPayload.steps.some(
        (candidate) => candidate.activityState === "needs_attention",
      )
        ? "needs_attention"
        : undefined;
    }
    step.streamingText = updateStreamingText(step.streamingText, event);
    this.recordChildActivity(flatIndex, event, toolSnapshot, now);
    this.syncTopLevelCurrentTool();
    step.lastActivityAt = now;
    this.statusPayload.lastActivityAt = now;
    this.statusPayload.lastUpdate = now;
    this.hooks.scheduleWrite();
  }
  private recordChildActivity(
    flatIndex: number,
    event: ReadonlyDeep<ChildEvent>,
    toolSnapshot: ReadonlyDeep<MutationToolResult> | undefined,
    now: number,
  ): void {
    const step = this.statusPayload.steps[flatIndex];
    switch (event.type) {
      case "tool_execution_start":
        this.recordToolStart(flatIndex, event, now);
        return;
      case "tool_execution_end":
        if (step.currentTool !== undefined && step.currentTool.length > 0) {
          step.recentTools ??= [];
          step.recentTools.push({
            tool: step.currentTool,
            args: step.currentToolArgs ?? "",
            endMs: now,
          });
        }
        clearStepCurrentActivity(step);
        return;
      case "message_end":
        this.recordCompletedMessage(flatIndex, event, toolSnapshot, now);
        return;
      case undefined:
      default:
        return;
    }
  }

  private recordToolStart(flatIndex: number, event: ReadonlyDeep<ChildEvent>, now: number): void {
    if (event.toolName === undefined || event.toolName.length === 0) {
      return;
    }
    const step = this.statusPayload.steps[flatIndex];
    step.toolCount = (step.toolCount ?? 0) + 1;
    step.currentTool = event.toolName;
    step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
    step.currentToolStartedAt = now;
    step.currentPath = resolveCurrentPath(event.toolName, event.args);
    this.statusPayload.toolCount = (this.statusPayload.toolCount ?? 0) + 1;
  }

  private recordCompletedMessage(
    flatIndex: number,
    event: ReadonlyDeep<ChildEvent>,
    toolSnapshot: ReadonlyDeep<MutationToolResult> | undefined,
    now: number,
  ): void {
    const step = this.statusPayload.steps[flatIndex];
    const message = event.message;
    if (message?.role === "toolResult") {
      const text = extractTextFromContent(message.content);
      appendRecentStepOutput(step, text.split("\n").slice(-10));
      if (toolSnapshot?.mutates === true) {
        this.recordMutationResult(flatIndex, toolSnapshot, text, now);
      }
    } else if (message?.role === "assistant") {
      appendRecentStepOutput(
        step,
        stripAcceptanceReport(extractTextFromContent(message.content)).split("\n").slice(-10),
      );
      step.turnCount = (step.turnCount ?? 0) + 1;
      const usage = messageUsage(message);
      if (usage) {
        this.recordUsage(flatIndex, usage);
      }
      this.statusPayload.turnCount = Math.max(this.statusPayload.turnCount ?? 0, step.turnCount);
    }
  }

  private recordUsage(flatIndex: number, usage: Readonly<{ input: number; output: number }>): void {
    const step = this.statusPayload.steps[flatIndex];
    const { input, output } = usage;
    const previousInput = step.tokens?.input ?? 0;
    const previousOutput = step.tokens?.output ?? 0;
    step.tokens = {
      input: previousInput + input,
      output: previousOutput + output,
      total: previousInput + previousOutput + input + output,
    };
    const totalInput = this.statusPayload.totalTokens?.input ?? 0;
    const totalOutput = this.statusPayload.totalTokens?.output ?? 0;
    this.statusPayload.totalTokens = {
      input: totalInput + input,
      output: totalOutput + output,
      total: totalInput + totalOutput + input + output,
    };
  }

  private recordMutationResult(
    flatIndex: number,
    snapshot: ReadonlyDeep<MutationToolResult>,
    text: string,
    now: number,
  ): void {
    const state = this.mutatingFailureStates[flatIndex];
    if (!snapshot.errored) {
      resetMutatingFailureState(state);
      return;
    }
    recordMutatingFailure(
      state,
      {
        tool: snapshot.tool,
        path: snapshot.path,
        error:
          text
            .split("\n")
            .find((line) => line.trim().length > 0)
            ?.trim()
            .slice(0, 180) ?? "mutating tool failed",
        ts: now,
      },
      this.mutatingFailureWindowMs,
    );
    const step = this.statusPayload.steps[flatIndex];
    if (
      !this.controlConfig.enabled ||
      !shouldEscalateMutatingFailures(
        state,
        this.controlConfig.failedToolAttemptsBeforeAttention,
      ) ||
      step.activityState === "needs_attention"
    ) {
      return;
    }
    const previous = step.activityState;
    step.activityState = "needs_attention";
    this.statusPayload.activityState = "needs_attention";
    this.hooks.notify(
      buildControlEvent({
        type: "needs_attention",
        from: previous,
        to: "needs_attention",
        runId: this.id,
        agent: step.agent,
        index: flatIndex,
        ts: now,
        message: `${step.agent} needs attention after repeated mutating tool failures`,
        reason: "tool_failures",
        turns: step.turnCount,
        tokens: step.tokens?.total,
        toolCount: step.toolCount,
        currentTool: snapshot.tool,
        currentToolDurationMs:
          snapshot.startedAt === undefined || snapshot.startedAt === 0
            ? undefined
            : Math.max(0, now - snapshot.startedAt),
        currentPath: snapshot.path,
        recentFailureSummary: summarizeRecentMutatingFailures(state),
      }),
    );
  }
}
