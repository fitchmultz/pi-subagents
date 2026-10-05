import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
} from "@earendil-works/pi-coding-agent";
import type {
  AcceptanceLedger,
  ResolvedAcceptanceConfig,
  ObservedMessage,
  ReadonlyInput,
} from "../../shared/types.ts";
import { setPromptSection } from "../../shared/prompt-sections.ts";
import { detectSubagentError, getFinalOutput } from "../../shared/utils.ts";
import {
  acceptanceFailureMessage,
  acceptanceSelfReviewConfig,
  createFinalizationReportRuntime,
  evaluateAcceptance,
  formatAcceptanceFinalizationPrompt,
  readFinalizationReport,
  resolveFinalizationOutput,
  stripAcceptanceReport,
} from "./acceptance.ts";
import { captureSingleOutputSnapshot, resolveSingleOutput } from "./single-output.ts";
import { readStructuredOutput, type StructuredOutputRuntime } from "./structured-output.ts";
import { compactObservedMessage } from "./child-observations.ts";
import { registerChildStructuredTool } from "./child-structured-tool.ts";
import { parseNativeFinalizationConfig } from "./native-finalization-schema.ts";
import {
  FINALIZATION_EVENT,
  type NativeFinalizationConfig,
  type NativeFinalizationEvent,
} from "./native-finalization-types.ts";
import { nonempty } from "./child-json.ts";
export {
  FINALIZATION_EVENT,
  type NativeFinalizationConfig,
  type NativeFinalizationEvent,
} from "./native-finalization-types.ts";

const CONFIG_ENV = "PI_SUBAGENT_FINALIZATION_CONFIG";
export function createNativeFinalization(
  acceptance: ResolvedAcceptanceConfig,
  publicOutput?: StructuredOutputRuntime,
  outputPath?: string,
): NativeFinalizationConfig {
  return {
    nonce: randomUUID(),
    acceptance,
    reportRuntime: createFinalizationReportRuntime(publicOutput?.schema),
    publicOutput,
    outputPath,
    outputSnapshot: captureSingleOutputSnapshot(outputPath),
  };
}
export function nativeFinalizationLaunch(config: ReadonlyInput<NativeFinalizationConfig>): {
  extension: string;
  env: Record<string, string>;
} {
  const configPath = path.join(path.dirname(config.reportRuntime.schemaPath), "finalization.json");
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return {
    extension: fileURLToPath(
      new URL(
        `native-finalization${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
        import.meta.url,
      ),
    ),
    env: { [CONFIG_ENV]: configPath },
  };
}

/** Owns self-review turns; command verification remains exclusively owner-run. */
class NativeReview {
  private readonly config: ReadonlyInput<NativeFinalizationConfig>;
  private readonly messages: ObservedMessage[] = [];
  private messageOffset = 0;
  private turn = 0;
  private initialOutput = "";
  private latestOutput = "";
  private initialLedger?: AcceptanceLedger;
  private resolvedOutput: ReturnType<typeof resolveSingleOutput> = { fullOutput: "" };
  constructor(config: ReadonlyInput<NativeFinalizationConfig>) {
    this.config = config;
  }

  observe(message: ObservedMessage): void {
    if (["assistant", "user", "toolResult"].includes(message.role)) {
      const output = getFinalOutput([message]);
      if (output.length > 0) {
        this.latestOutput = output;
      }
      this.messages.push(compactObservedMessage(message));
    }
  }
  private submission(): NativeFinalizationEvent["submission"] {
    const submission: NativeFinalizationEvent["submission"] =
      this.turn === 0
        ? { output: this.latestOutput }
        : readFinalizationReport(this.messages, this.config.reportRuntime, {
            messageOffset: this.messageOffset,
          });
    if (this.turn === 0) {
      this.initialOutput = submission.output;
      const hiddenError = detectSubagentError(this.messages);
      if (hiddenError.hasError) {
        submission.error = hiddenError.details ?? `${hiddenError.errorType ?? "Subagent"} failed`;
      }
      if (this.config.publicOutput) {
        submission.error ??= readStructuredOutput(this.config.publicOutput).error;
      }
    }
    return submission;
  }
  private saveOutput(
    submission: ReadonlyInput<NativeFinalizationEvent["submission"]>,
  ): string | undefined {
    if (nonempty(submission.error) || nonempty(submission.reportSubmissionError)) {
      return;
    }
    const output =
      this.turn === 0
        ? stripAcceptanceReport(submission.output)
        : resolveFinalizationOutput(submission.output, this.resolvedOutput.fullOutput);
    this.resolvedOutput = resolveSingleOutput(
      this.config.outputPath,
      output,
      this.turn === 0 ? this.config.outputSnapshot : this.resolvedOutput.writtenSnapshot,
    );
    return nonempty(this.resolvedOutput.saveError)
      ? `Failed to save output file '${this.config.outputPath ?? ""}': ${this.resolvedOutput.saveError}`
      : undefined;
  }
  private nextPrompt(
    submission: ReadonlyInput<NativeFinalizationEvent["submission"]>,
    ledger: AcceptanceLedger,
  ): string | undefined {
    if (
      nonempty(submission.error) ||
      ledger.status === "blocked" ||
      this.turn >= this.config.acceptance.finalization.maxTurns
    ) {
      return;
    }
    if (!this.initialLedger) {
      throw new Error("Native self-review initial acceptance ledger is missing");
    }
    if (
      this.turn !== 0 &&
      !nonempty(submission.reportSubmissionError) &&
      ledger.status !== "rejected"
    ) {
      return;
    }
    return formatAcceptanceFinalizationPrompt({
      acceptance: this.config.acceptance,
      initialOutput: this.initialOutput,
      initialLedger: this.initialLedger,
      turn: this.turn + 1,
      maxTurns: this.config.acceptance.finalization.maxTurns,
      previousFailure: submission.reportSubmissionError ?? acceptanceFailureMessage(ledger),
      nativeReport: true,
      outputSchema: this.config.publicOutput?.schema,
    });
  }
  async settle(
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    if (event.outcome !== "completed") {
      return;
    }
    const submission = this.submission();
    const ledger = await evaluateAcceptance({
      acceptance: acceptanceSelfReviewConfig(this.config.acceptance),
      governing: this.config.acceptance,
      cwd: ctx.cwd,
      output: nonempty(submission.reportSubmissionError) ? "" : submission.output,
      report: nonempty(submission.reportSubmissionError) ? undefined : submission.report,
    });
    this.initialLedger ??= ledger;
    const saveError = this.saveOutput(submission);
    submission.error ??= saveError;
    const nextPrompt = this.nextPrompt(submission, ledger);
    const marker: NativeFinalizationEvent = {
      type: FINALIZATION_EVENT,
      nonce: this.config.nonce,
      turn: this.turn,
      lastEntryId: ctx.sessionManager.getLeafId() ?? undefined,
      messageCount: this.messages.length,
      at: Date.now(),
      submission,
      acceptance: ledger,
      resolvedOutput: this.resolvedOutput,
      nextPrompt,
    };
    fs.appendFileSync(
      path.join(path.dirname(this.config.reportRuntime.schemaPath), "boundaries.jsonl"),
      `${JSON.stringify(marker)}\n`,
      { mode: 0o600 },
    );
    if (!nonempty(nextPrompt)) {
      return;
    }
    if (this.turn === 0) {
      registerChildStructuredTool(pi, this.config.reportRuntime);
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "structured_output"])]);
    }
    this.turn++;
    this.messageOffset = this.messages.length;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "subagent-self-review",
          content: nextPrompt,
          display: false,
        },
      ],
      continue: true,
    };
  }
}

export default function registerNativeFinalization(pi: ExtensionAPI): void {
  const configPath = process.env[CONFIG_ENV];
  if (!nonempty(configPath)) {
    return;
  }
  const value: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const config = parseNativeFinalizationConfig(value);
  const review = new NativeReview(config);
  if (config.publicOutput) {
    registerChildStructuredTool(pi, config.publicOutput);
    pi.on("before_agent_start", (event) => {
      setPromptSection(
        event.systemPromptOptions,
        "subagent_output",
        "Your final action must call structured_output with JSON matching the current schema. Prose alone does not complete this output contract.",
      );
    });
  }
  pi.on("message_end", (event) => review.observe(event.message));
  pi.on("agent_before_settle", (event, ctx) => review.settle(event, ctx, pi));
}
