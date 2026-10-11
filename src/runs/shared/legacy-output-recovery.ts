import * as fs from "node:fs";
import { NativeJournal, readOutputPage } from "../../shared/journal-reader.ts";
import { isRecord, isUnknownArray, recordAt } from "../../shared/unknown.ts";
import { resolveFinalizationOutput } from "./acceptance-finalization.ts";
import { parseAcceptanceReport, validateAcceptanceReportShape } from "./acceptance-reports.ts";
import type { ReadonlySingleResult } from "../../shared/types.ts";

type JournalRecord = NativeJournal["records"][number];

function assistantContent(
  message: Readonly<Record<string, unknown>> | undefined,
): readonly unknown[] | undefined {
  if (
    !message ||
    message.role !== "assistant" ||
    !isUnknownArray(message.content) ||
    (typeof message.errorMessage === "string" && message.errorMessage !== "") ||
    message.stopReason === "error"
  ) {
    return undefined;
  }
  return message.content;
}

function assistantText(message: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const content = assistantContent(message);
  for (const part of content?.toReversed() ?? []) {
    if (
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim() !== ""
    ) {
      return part.text;
    }
  }
  return undefined;
}

function existingFile(file: string | undefined): boolean {
  return file !== undefined && file !== "" && fs.existsSync(file);
}

/** Legacy foreground receipts can refer to a final output artifact or native assistant answer. */
export function recoverOutput(
  sessionFile: string | undefined,
  outputFile: string | undefined,
  endedAt: number,
): string | undefined {
  if (outputFile !== undefined && existingFile(outputFile)) {
    return readOutputPage(outputFile).text;
  }
  if (sessionFile === undefined || !existingFile(sessionFile)) {
    return undefined;
  }
  const journal = new NativeJournal(sessionFile);
  for (const record of journal.branch(undefined, endedAt).reverse()) {
    if (
      record.value.type !== "message" ||
      recordAt(record.value, "message")?.role !== "assistant"
    ) {
      continue;
    }
    const output = assistantText(recordAt(journal.body(record), "message"));
    if (output !== undefined) {
      return output;
    }
  }
  return undefined;
}

interface StructuredCall {
  readonly id: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

function structuredCall(part: unknown): StructuredCall | undefined {
  if (
    !isRecord(part) ||
    part.name !== "structured_output" ||
    typeof part.id !== "string" ||
    !isRecord(part.arguments)
  ) {
    return undefined;
  }
  return { id: part.id, arguments: part.arguments };
}

function successfulStructuredResult(
  records: readonly JournalRecord[],
  call: StructuredCall,
): boolean {
  if (records.some((record) => recordAt(record.value, "message")?.role !== "toolResult")) {
    return false;
  }
  const last = records.at(-1);
  const result = last ? recordAt(last.value, "message") : undefined;
  return (
    result !== undefined &&
    result.toolCallId === call.id &&
    result.toolName === "structured_output" &&
    result.isError === false
  );
}

function resolvedAnswer(raw: string): string | undefined {
  const answer = resolveFinalizationOutput(raw, "");
  return answer !== "" ? answer : undefined;
}

function structuredAnswer(call: StructuredCall): string | undefined {
  const value = call.arguments.value;
  if (!isRecord(value) || !("report" in value)) {
    return undefined;
  }
  if (
    typeof value.report === "string" &&
    parseAcceptanceReport(value.report).report !== undefined
  ) {
    return resolvedAnswer(value.report);
  }
  if (
    typeof value.answer === "string" &&
    value.answer.trim() !== "" &&
    validateAcceptanceReportShape(value.report) === undefined
  ) {
    return value.answer;
  }
  return undefined;
}

function terminalContent(
  message: Readonly<Record<string, unknown>> | undefined,
): readonly unknown[] | undefined {
  if (
    !message ||
    (message.errorMessage !== undefined && message.errorMessage !== "") ||
    (message.stopReason !== "stop" && message.stopReason !== "toolUse")
  ) {
    return undefined;
  }
  return assistantContent(message);
}

function terminalText(
  message: Readonly<Record<string, unknown>> | undefined,
  index: number,
  total: number,
): string | undefined {
  const output = assistantText(message);
  return index === total - 1 && message?.stopReason === "stop" && output !== undefined
    ? resolvedAnswer(output)
    : undefined;
}

function terminalAnswer(
  journal: Readonly<Pick<NativeJournal, "body">>,
  records: readonly JournalRecord[],
): string | undefined {
  const index = records.findLastIndex(
    (record) => recordAt(record.value, "message")?.role === "assistant",
  );
  if (index < 0) {
    return undefined;
  }
  const message = recordAt(journal.body(records[index]), "message");
  const content = terminalContent(message);
  if (!content) {
    return undefined;
  }
  const calls = content.filter((part) => isRecord(part) && part.type === "toolCall");
  if (calls.length === 0) {
    return terminalText(message, index, records.length);
  }
  const call = calls.length === 1 ? structuredCall(calls[0]) : undefined;
  return call && successfulStructuredResult(records.slice(index + 1), call)
    ? structuredAnswer(call)
    : undefined;
}

function reviewedAnswer(acceptance: ReadonlySingleResult["acceptance"]): string | undefined {
  const review = acceptance?.finalization;
  const output = review?.status === "completed" ? review.turns.at(-1)?.rawOutput : undefined;
  return output !== undefined && output.trim() !== "" ? resolvedAnswer(output) : undefined;
}

/** Only bounded, terminal native evidence can become a recovered background final answer. */
export function recoverLegacyTerminalOutput(
  sessionFile: string | undefined,
  startedAt: number,
  endedAt: number | undefined,
  acceptance: ReadonlySingleResult["acceptance"],
): string | undefined {
  const reviewed = reviewedAnswer(acceptance);
  if (reviewed !== undefined) {
    return reviewed;
  }
  // Mutable live/finalization streams are not final-answer receipts.
  if (
    endedAt === undefined ||
    !Number.isFinite(endedAt) ||
    sessionFile === undefined ||
    !existingFile(sessionFile)
  ) {
    return undefined;
  }
  const journal = new NativeJournal(sessionFile);
  const records = journal
    .branch(undefined, endedAt)
    .filter(
      ({ value }) => value.type === "message" && Date.parse(value.timestamp ?? "") >= startedAt,
    );
  return terminalAnswer(journal, records);
}
