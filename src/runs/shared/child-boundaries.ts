import * as path from "node:path";
import { scanJournal } from "../../shared/journal-reader.ts";
import type {
  ObservedMessage,
  ReadonlyInput,
  ResourceLimitExceeded,
  UsageAccumulator,
} from "../../shared/types.ts";
import type { NativeAttemptSegment, ChildAttemptResult } from "./child-attempt-types.ts";
import {
  FINALIZATION_EVENT,
  type NativeFinalizationConfig,
  type NativeFinalizationEvent,
} from "./native-finalization-types.ts";
import { parseNativeFinalizationEvent } from "./native-finalization-schema.ts";
import { readFinalizationReport } from "./acceptance.ts";
import { addUsage } from "./native-usage.ts";
import { hasErrorCode } from "../../shared/unknown.ts";
import { nonempty } from "./child-presence.ts";

interface BoundaryOptions {
  readonly config?: ReadonlyInput<NativeFinalizationConfig>;
  readonly maxTokens?: number;
  readonly maxExecutionTimeMs?: number;
  readonly onLimit: (kind: ResourceLimitExceeded["kind"], limit: number, observed?: number) => void;
  readonly onReset: () => void;
  readonly onMarker: (marker: ReadonlyInput<NativeFinalizationEvent>) => void;
}

function segmentUsage(messages: readonly ObservedMessage[]): {
  usage: UsageAccumulator;
  assistantTokens: number;
} {
  const usage: UsageAccumulator = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  let assistantTokens = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      usage.turns++;
      assistantTokens += (message.usage?.input ?? 0) + (message.usage?.output ?? 0);
    }
    if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
      addUsage(usage, message.usage);
    }
  }
  return { usage, assistantTokens };
}

/** Native markers reset per-review limits only after all their messages have been observed. */
export class ChildBoundaries {
  private readonly options: BoundaryOptions;
  private cursor = 0;
  private readonly pending = new Error("pending native boundary");
  private readonly segments: NativeAttemptSegment[] = [];
  private readonly priorUsage: UsageAccumulator = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  messageOffset = 0;
  assistantTokens = 0;
  startedAt: number;
  constructor(options: BoundaryOptions, startedAt: number) {
    this.options = options;
    this.startedAt = startedAt;
  }

  snapshot(): NativeAttemptSegment[] {
    return this.segments;
  }

  sync(
    messages: readonly ObservedMessage[],
    nativeMessageCount: number,
  ): NativeAttemptSegment[] | undefined {
    const config = this.options.config;
    if (!config) {
      return;
    }
    const file = path.join(path.dirname(config.reportRuntime.schemaPath), "boundaries.jsonl");
    try {
      scanJournal(
        file,
        () => true,
        ({ value, end }) => {
          const marker = parseNativeFinalizationEvent(value);
          if (marker.nonce !== config.nonce) {
            throw new Error("Unexpected finalization nonce");
          }
          if (marker.messageCount > nativeMessageCount) {
            throw this.pending;
          }
          this.accept(marker, messages);
          this.cursor = end;
        },
        { policy: "live", start: this.cursor },
      );
    } catch (error) {
      if (error !== this.pending && !hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    return this.segments;
  }

  private accept(
    marker: ReadonlyInput<NativeFinalizationEvent>,
    messages: readonly ObservedMessage[],
  ): void {
    const selected = messages
      .filter((message) => ["assistant", "user", "toolResult"].includes(message.role))
      .slice(this.messageOffset, marker.messageCount);
    const { usage, assistantTokens } = segmentUsage(selected);
    this.segments.push({
      event: { ...marker, submission: { ...marker.submission } },
      messages: selected,
      usage,
      durationMs: marker.at - this.startedAt,
    });
    this.enforceLimits(marker.at, assistantTokens);
    if (nonempty(marker.nextPrompt)) {
      this.messageOffset = marker.messageCount;
      this.assistantTokens += assistantTokens;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
        this.priorUsage[key] += usage[key];
      }
      this.startedAt = marker.at;
      this.options.onReset();
    }
    this.options.onMarker(marker);
  }
  private enforceLimits(at: number, tokens: number): void {
    if (this.options.maxTokens !== undefined && tokens >= this.options.maxTokens) {
      this.options.onLimit("maxTokens", this.options.maxTokens, tokens);
    }
    if (
      this.options.maxExecutionTimeMs !== undefined &&
      at - this.startedAt >= this.options.maxExecutionTimeMs
    ) {
      this.options.onLimit("maxExecutionTimeMs", this.options.maxExecutionTimeMs);
    }
  }

  finish(result: ReadonlyInput<ChildAttemptResult>): {
    finalization?: NativeAttemptSegment[];
    missing: boolean;
  } {
    const config = this.options.config;
    if (!config) {
      return { missing: false };
    }
    const previous = this.segments.at(-1);
    if (nonempty(previous?.event.nextPrompt)) {
      this.appendInterruptedReview(result);
    }
    const final = this.segments.at(-1);
    if (!final) {
      return {
        missing: result.exitCode === 0 && !nonempty(result.error) && result.interrupted !== true,
      };
    }
    if (final.event.turn > 0) {
      final.event.submission = {
        ...readFinalizationReport([...result.messages], config.reportRuntime, {
          messageOffset: this.messageOffset,
        }),
        error: final.event.submission.error,
      };
    }
    final.execution = {
      exitCode: result.exitCode,
      error: result.error,
      interrupted: result.interrupted,
      timedOut: result.timedOut,
      resourceLimitExceeded: result.resourceLimitExceeded,
      terminalFailure: result.terminalFailure,
    };
    return { finalization: this.segments, missing: false };
  }
  private appendInterruptedReview(result: ReadonlyInput<ChildAttemptResult>): void {
    const previous = this.segments.at(-1);
    const config = this.options.config;
    if (!previous || !config) {
      return;
    }
    const usage: UsageAccumulator = {
      ...result.usage,
      contributions: result.usage.contributions?.slice(this.priorUsage.contributions?.length ?? 0),
    };
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
      usage[key] -= this.priorUsage[key];
    }
    this.segments.push({
      event: {
        type: FINALIZATION_EVENT,
        nonce: config.nonce,
        turn: previous.event.turn + 1,
        messageCount: result.messages.length,
        at: Date.now(),
        submission: { output: "" },
        resolvedOutput: previous.event.resolvedOutput,
      },
      messages: result.messages.slice(this.messageOffset),
      usage,
      durationMs: Date.now() - this.startedAt,
    });
  }
}
