import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import type { SingleStepContext } from "./runner-contract.ts";
import {
  interpretAttemptOutput,
  formatProcessExitFailure,
  type StepAttempt,
  type AttemptReview,
} from "./runner-attempt-output.ts";
import { runPiStreaming } from "./runner-streaming.ts";
import { captureSingleOutputSnapshot } from "../shared/single-output.ts";
import type { ToolCallSummary, Usage } from "../../shared/types.ts";
import type { RunnerSubagentStep as SubagentStep } from "../../shared/types.ts";
import { cleanupTempDir } from "../shared/pi-args.ts";
import { isClaudeCodeModel } from "../shared/claude-code.ts";
import type { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import {
  buildChildInvocation,
  type ChildAttemptResult,
  type NativeAttemptSegment,
} from "../shared/child-attempt.ts";
import { createNativeFinalization } from "../shared/native-finalization.ts";
import { compactForegroundResult } from "../../shared/utils.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveExecutionOutcome } from "../shared/acceptance.ts";

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

interface AttemptEnvironment {
  readonly interruptSignal: AbortSignal;
  readonly verificationSignal: AbortSignal;
  readonly effectiveStructuredOutput?: ReturnType<typeof createStructuredOutputRuntime>;
  readonly sessionEnabled: boolean;
  readonly sessionDir?: string;
}

function nativeSegmentError(
  segment: ReadonlyDeep<NativeAttemptSegment>,
  agent: string,
): string | undefined {
  const state = segment.execution;
  if (state?.error !== undefined) {
    return state.error;
  }
  if (segment.event.submission.error !== undefined) {
    return segment.event.submission.error;
  }
  const exitCode = state?.exitCode ?? 0;
  if (exitCode === 0 || state?.interrupted === true) {
    return;
  }
  return formatProcessExitFailure({ agent, exitCode, durationMs: segment.durationMs });
}

export class RunnerAttempt {
  nativeExecution: ReadonlyDeep<ChildAttemptResult> | undefined;
  nativeSegments: readonly ReadonlyDeep<NativeAttemptSegment>[] = [];
  toolCount = 0;
  readonly toolCalls: ToolCallSummary[] = [];
  private readonly eventsPath: string;
  private readonly step: SubagentStep;
  private readonly ctx: ReadonlyDeep<SingleStepContext>;
  private readonly environment: ReadonlyDeep<AttemptEnvironment>;

  constructor(
    step: SubagentStep,
    ctx: ReadonlyDeep<SingleStepContext>,
    environment: ReadonlyDeep<AttemptEnvironment>,
  ) {
    this.step = step;
    this.ctx = ctx;
    this.environment = environment;
    this.eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
  }

  nativeAttempt(segment: ReadonlyDeep<NativeAttemptSegment>): StepAttempt {
    const nativeExecution = this.nativeExecution;
    if (nativeExecution === undefined) {
      throw new Error("Native segment requires a finalized execution.");
    }
    const error = nativeSegmentError(segment, this.step.agent);
    const state = segment.execution;
    const exitCode = state?.exitCode ?? 0;
    return {
      ...nativeExecution,
      exitCode: error !== undefined && error.length > 0 && exitCode === 0 ? 1 : exitCode,
      error,
      interrupted: state?.interrupted,
      timedOut: state?.timedOut,
      resourceLimitExceeded: state?.resourceLimitExceeded,
      terminalFailure:
        (segment.event.submission.error !== undefined &&
          segment.event.submission.error.length > 0) ||
        state?.terminalFailure,
      messages: segment.messages,
      usage: segment.usage,
      durationMs: segment.durationMs,
      finalOutput: segment.event.submission.output,
      reportSubmission: segment.event.turn > 0 ? segment.event.submission : undefined,
      resolvedOutput: segment.event.resolvedOutput,
      finalization: undefined,
    };
  }

  async run(
    prompt: string,
    model: string | undefined,
    review?: ReadonlyDeep<AttemptReview>,
  ): Promise<StepAttempt> {
    const { step, ctx } = this;
    const { verificationSignal, effectiveStructuredOutput } = this.environment;
    if (verificationSignal.aborted) {
      return this.abortedAttempt(model);
    }
    ctx.onAttemptStart?.({ model, thinking: resolveEffectiveThinking(model, step.thinking) });
    const structuredRuntime = review ? review.reportRuntime : effectiveStructuredOutput;
    const outputSnapshot = review
      ? review.outputSnapshot
      : captureSingleOutputSnapshot(step.outputPath);
    if (structuredRuntime) {
      try {
        fs.rmSync(structuredRuntime.outputPath, { force: true });
      } catch {
        // readStructuredOutput reports unreadable or stale output after the attempt.
      }
    }
    const nativeFinalization = this.nativeFinalization(model, review, structuredRuntime);
    let built: ReturnType<typeof buildChildInvocation>;
    try {
      built = this.buildInvocation(prompt, model, {
        review,
        structuredRuntime,
        nativeFinalization,
      });
    } catch (error) {
      if (nativeFinalization) {
        cleanupTempDir(path.dirname(nativeFinalization.reportRuntime.schemaPath));
      }
      const message =
        error instanceof Error ? error.message : "Failed to prepare child invocation.";
      return this.failedPreparation(model, message);
    }
    const runResult = await this.executeInvocation(built, {
      model,
      review,
      structuredRuntime,
      nativeFinalization,
    });
    const adopted = this.adoptNativeRun(runResult, nativeFinalization !== undefined);
    return interpretAttemptOutput(step, adopted.run, {
      model,
      review,
      structuredRuntime,
      outputSnapshot,
      initialSegment: adopted.initialSegment,
      structuredResult: built.claudeCodeInvocation !== undefined,
    });
  }

  private abortedAttempt(model: string | undefined): StepAttempt {
    const outcome = resolveExecutionOutcome({
      result: { exitCode: 1 },
      signal: this.ctx.signal,
      interruptSignal: this.environment.interruptSignal,
    });
    return {
      stderr: "",
      messages: [],
      usage: emptyUsage(),
      durationMs: 0,
      observedCompletedMutation: false,
      finalOutput: outcome.error ?? "Interrupted. Waiting for explicit next action.",
      ...outcome,
      exitCode: outcome.exitCode ?? 1,
      model,
      terminalFailure: true,
      resolvedOutput: { fullOutput: "" },
    };
  }

  private nativeFinalization(
    model: string | undefined,
    review: ReadonlyDeep<AttemptReview> | undefined,
    runtime: ReadonlyDeep<AttemptEnvironment["effectiveStructuredOutput"]>,
  ): ReturnType<typeof createNativeFinalization> | undefined {
    const acceptance = this.step.effectiveAcceptance;
    if (
      this.ctx.nativeFinalization !== true ||
      review !== undefined ||
      isClaudeCodeModel(model) ||
      acceptance?.explicit !== true
    ) {
      return;
    }
    return createNativeFinalization(acceptance, runtime, this.step.outputPath);
  }

  private adoptNativeRun(
    run: ReadonlyDeep<ChildAttemptResult>,
    enabled: boolean,
  ): Readonly<{
    run: ReadonlyDeep<ChildAttemptResult>;
    initialSegment?: ReadonlyDeep<NativeAttemptSegment>;
  }> {
    const initialSegment = enabled ? run.finalization?.at(0) : undefined;
    if (initialSegment === undefined) {
      return { run };
    }
    this.nativeExecution = run;
    this.nativeSegments = run.finalization?.slice(1) ?? [];
    return { run: this.nativeAttempt(initialSegment), initialSegment };
  }

  private failedPreparation(model: string | undefined, message: string): StepAttempt {
    return {
      stderr: message,
      exitCode: 1,
      messages: [],
      usage: emptyUsage(),
      durationMs: 0,
      observedCompletedMutation: false,
      model,
      error: message,
      finalOutput: message,
      terminalFailure: true,
      resolvedOutput: { fullOutput: message },
    };
  }

  private buildInvocation(
    prompt: string,
    model: string | undefined,
    input: ReadonlyDeep<{
      review?: AttemptReview;
      structuredRuntime?: ReturnType<typeof createStructuredOutputRuntime>;
      nativeFinalization?: ReturnType<typeof createNativeFinalization>;
    }>,
  ): ReturnType<typeof buildChildInvocation> {
    const { step, ctx } = this;
    const { review, structuredRuntime, nativeFinalization } = input;
    const { sessionEnabled, sessionDir } = this.environment;
    const sessionFile = review?.sessionFile ?? step.sessionFile;
    return buildChildInvocation({
      task: prompt,
      model,
      thinking: step.thinking,
      sessionEnabled: review ? true : sessionEnabled,
      sessionDir: review ? undefined : sessionDir,
      sessionFile,
      inheritProjectContext: step.inheritProjectContext,
      inheritSkills: step.inheritSkills,
      tools: step.tools,
      allowSubagents: step.allowSubagents,
      extensions: step.extensions,
      systemPrompt: step.systemPrompt,
      systemPromptMode: step.systemPromptMode,
      mcpDirectTools: step.mcpDirectTools,
      cwd: step.cwd ?? ctx.cwd,
      intercomSessionName: ctx.childIntercomTarget,
      orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
      runId: ctx.id,
      childAgentName: step.agent,
      childIndex: ctx.flatIndex,
      rootSessionId: ctx.rootSessionId,
      parentEventSink: ctx.nestedRoute?.eventSink,
      parentControlInbox: ctx.nestedRoute?.controlInbox,
      parentRootRunId: ctx.nestedRoute?.rootRunId,
      parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
      structuredOutput: structuredRuntime,
      projectTrust: ctx.projectTrust,
      nativeFinalization,
    });
  }

  private async executeInvocation(
    built: ReadonlyDeep<ReturnType<typeof buildChildInvocation>>,
    input: ReadonlyDeep<{
      model?: string;
      review?: AttemptReview;
      structuredRuntime?: ReturnType<typeof createStructuredOutputRuntime>;
      nativeFinalization?: ReturnType<typeof createNativeFinalization>;
    }>,
  ): Promise<ChildAttemptResult> {
    const { step, ctx, eventsPath } = this;
    const { interruptSignal } = this.environment;
    const { args, env, tempDir, claudeCodeInvocation } = built;
    const { model, review, structuredRuntime, nativeFinalization } = input;
    const sessionFile = review?.sessionFile ?? step.sessionFile;
    try {
      return await runPiStreaming(
        {
          args,
          cwd: step.cwd ?? ctx.cwd,
          env,
          agent: step.agent,
          model,
          maxSubagentDepth: step.maxSubagentDepth,
          maxExecutionTimeMs: step.maxExecutionTimeMs,
          maxTokens: step.maxTokens,
          interruptSignal,
          signal: ctx.signal,
          claudeCodeInvocation,
          sessionFile,
          structuredOutput: structuredRuntime,
          reportRuntime: review?.reportRuntime,
          nativeFinalization,
          onEvent: (event, result, mutation) => {
            if (event.type === "tool_execution_start") {
              this.toolCount++;
            }
            if (event.type === "message_end" && event.message?.role === "assistant") {
              this.toolCalls.push(
                ...(compactForegroundResult({
                  agent: step.agent,
                  task: step.task,
                  exitCode: 0,
                  usage: result.usage,
                  messages: [event.message],
                }).toolCalls ?? []),
              );
            }
            ctx.onChildEvent?.(event, mutation);
          },
        },
        review ? `${ctx.outputFile}.finalization-${review.turn}.log` : ctx.outputFile,
        { eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
      );
    } finally {
      cleanupTempDir(tempDir);
      if (nativeFinalization) {
        cleanupTempDir(path.dirname(nativeFinalization.reportRuntime.schemaPath));
      }
    }
  }
}
