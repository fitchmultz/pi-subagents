import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import {
  createStructuredOutputRuntime,
  readStructuredOutput,
  validateStructuredOutputValue,
  type StructuredOutputRuntime,
} from "./structured-output.ts";
import type { AcceptanceReport, JsonSchemaObject, ReadonlyInput } from "../../shared/types.ts";
import {
  ACCEPTANCE_REPORT_SCHEMA,
  isAcceptanceReport,
  parseAcceptanceReport,
} from "./acceptance-reports.ts";

export type FinalizationReportRuntime = ReadonlyInput<StructuredOutputRuntime> & {
  readonly publicOutputSchema?: JsonSchemaObject;
};
export interface FinalizationReportSubmission {
  readonly output: string;
  readonly structuredOutput?: unknown;
  readonly report?: AcceptanceReport;
  readonly reportSubmissionError?: string;
  readonly unconfirmedOutput?: string;
}

export function createFinalizationReportRuntime(
  publicOutputSchema?: JsonSchemaObject,
): FinalizationReportRuntime {
  const runtime = createStructuredOutputRuntime({
    type: "object",
    properties: {
      // Resource-local references, including recursive '#', stay scoped to the public answer.
      answer: publicOutputSchema
        ? { $id: "urn:pi-subagents:public-output", ...publicOutputSchema }
        : {
            type: "string",
            pattern: "\\S",
            description:
              "Complete standalone final answer, including every requested handoff detail.",
          },
      report: ACCEPTANCE_REPORT_SCHEMA,
    },
    required: ["answer", "report"],
    additionalProperties: false,
  });
  return { ...runtime, publicOutputSchema };
}

function readReportValue(
  value: unknown,
  publicOutputSchema?: JsonSchemaObject,
): (FinalizationReportSubmission & { report: AcceptanceReport }) | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  // Legacy runtimes retain their original string schema.
  if (publicOutputSchema === undefined && "report" in value && typeof value.report === "string") {
    const parsed = parseAcceptanceReport(value.report);
    if (parsed.report) {
      return { output: value.report, report: parsed.report };
    }
  }
  if (!("answer" in value) || !("report" in value) || !isAcceptanceReport(value.report)) {
    return undefined;
  }
  return readAnswer(value.answer, value.report, publicOutputSchema);
}

function readAnswer(
  answer: unknown,
  report: AcceptanceReport,
  schema?: JsonSchemaObject,
): (FinalizationReportSubmission & { report: AcceptanceReport }) | undefined {
  if (schema) {
    if (validateStructuredOutputValue(schema, answer).status === "invalid") {
      return undefined;
    }
    return { output: JSON.stringify(answer), structuredOutput: answer, report };
  }
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return undefined;
  }
  return { output: answer, report };
}

export function reportAuditOutput(submission: {
  readonly output: string;
  readonly report?: AcceptanceReport;
}): string {
  return submission.report && !parseAcceptanceReport(submission.output).report
    ? `${submission.output}\n\n\`\`\`acceptance-report\n${JSON.stringify(submission.report)}\n\`\`\``
    : submission.output;
}

function toolResultSucceeded(result: { readonly isError: unknown }): boolean {
  return result.isError === false;
}

function successfulStructuredIds(messages: readonly Message[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      message.role === "toolResult" &&
      message.toolName === "structured_output" &&
      toolResultSucceeded(message)
        ? [message.toolCallId]
        : [],
    ),
  );
}

function auditSubmission(value: unknown, runtime: FinalizationReportRuntime): string | undefined {
  const previous = readReportValue(value, runtime.publicOutputSchema);
  return previous && validateStructuredOutputValue(runtime.schema, value).status === "valid"
    ? reportAuditOutput(previous)
    : undefined;
}

function previousAuditOutput(
  messages: readonly Message[],
  runtime: FinalizationReportRuntime,
  submitted: FinalizationReportSubmission | undefined,
): string | undefined {
  const successfulIds = successfulStructuredIds(messages);
  let retained = submitted ? reportAuditOutput(submitted) : undefined;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const call of message.content) {
      if (
        call.type !== "toolCall" ||
        call.name !== "structured_output" ||
        !successfulIds.has(call.id)
      ) {
        continue;
      }
      const value: unknown = call.arguments.value;
      retained = auditSubmission(value, runtime) ?? retained;
    }
  }
  return retained;
}

function latestSubmissionError(
  messages: readonly Message[],
  call: ToolCall,
  index: number,
): string | undefined {
  const result = messages
    .slice(index + 1)
    .findLast((message) => message.role === "toolResult" && message.toolCallId === call.id);
  if (
    result?.role !== "toolResult" ||
    result.toolName !== "structured_output" ||
    !toolResultSucceeded(result)
  ) {
    return "the latest structured_output call has no matching successful result.";
  }
  return undefined;
}

function latestAssistant(
  messages: readonly Message[],
): { message: AssistantMessage; index: number } | undefined {
  const index = messages.findLastIndex((message) => message.role === "assistant");
  const last = Object.hasOwn(messages, index) ? messages[index] : undefined;
  if (
    last?.role !== "assistant" ||
    (last.errorMessage ?? "").length > 0 ||
    !["stop", "toolUse"].includes(last.stopReason) ||
    !Array.isArray(last.content)
  ) {
    return undefined;
  }
  return { message: last, index };
}

function currentToolSubmissionError(
  last: AssistantMessage,
  messages: readonly Message[],
  index: number,
  captured: { readonly value?: unknown; readonly error?: string },
): string | undefined {
  const calls = last.content.filter((part) => part.type === "toolCall");
  const call = calls.length > 0 ? calls[0] : undefined;
  if (calls.length !== 1 || call?.name !== "structured_output") {
    return "the latest assistant turn must submit structured_output as its only tool call.";
  }
  const error = latestSubmissionError(messages, call, index);
  if (error !== undefined) {
    return error;
  }
  if (captured.error !== undefined) {
    return captured.error;
  }
  if (!isDeepStrictEqual(captured.value, call.arguments.value)) {
    return "the capture does not match the latest submission.";
  }
  return undefined;
}

/** The current attempt's terminal assistant and its actual successful tool result authorize publication. */
export function readFinalizationReport(
  messages: readonly Message[],
  runtime: FinalizationReportRuntime,
  options: { readonly messageOffset?: number; readonly structuredResult?: boolean } = {},
): FinalizationReportSubmission {
  const currentMessages = messages.slice(options.messageOffset ?? 0);
  const captured = readStructuredOutput(runtime);
  const submitted = readReportValue(captured.value, runtime.publicOutputSchema);
  const unconfirmedOutput = previousAuditOutput(currentMessages, runtime, submitted);
  const rejected = (reason: string): FinalizationReportSubmission => ({
    output: "",
    reportSubmissionError: `No current finalization report: ${reason}`,
    unconfirmedOutput,
  });
  const latest = latestAssistant(currentMessages);
  if (!latest) {
    return rejected("the latest assistant turn did not finish successfully.");
  }
  // Claude Code's terminal result is schema-constrained rather than a Pi tool call.
  if (options.structuredResult === true) {
    if (captured.error !== undefined) {
      return rejected(captured.error);
    }
    return submitted
      ? { ...submitted, unconfirmedOutput }
      : rejected("the submission must contain a complete answer and a valid acceptance report.");
  }
  const error = currentToolSubmissionError(latest.message, currentMessages, latest.index, captured);
  if (error !== undefined) {
    return rejected(error);
  }
  if (!submitted) {
    return rejected("the submission must contain a complete answer and a valid acceptance report.");
  }
  return { ...submitted, unconfirmedOutput };
}
