import type { ErrorObject } from "ajv";
import { validateStatusForSummary } from "./async-status-validation.ts";
import { isRecord } from "./async-value.ts";
import type { SubagentRunConfig } from "./runner-config.ts";
import type {
  NativeFinalizationConfig,
  NativeFinalizationEvent,
} from "../shared/native-finalization-types.ts";
import * as guards from "../../../generated/RunValidators.js";
import type {
  AsyncStatus,
  AsyncResultFile,
  ForegroundResumeRun,
  OwnedRun,
  AsyncStartedEvent,
  ControlEvent,
  SupervisorRunContract,
  SupervisorQuestion,
  QuestionAnswer,
  QuestionDelivery,
  SupervisorQuestionView,
  HistoryRunRow,
  HistoryRunPage,
  HistoryPage,
  HistorySearchPage,
  HistoryIndexStatus,
  HistoryEntry,
  HistoryResult,
  Details,
  SubagentExecutionResult,
} from "../../shared/types.ts";

// AJV's standalone guards preserve canonical validation without compiling in every process.
function errorsText(errors: readonly ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "No errors";
  }
  return errors.map((error) => `data${error.instancePath} ${String(error.message)}`).join(", ");
}

export function parseNativeFinalizationConfig(value: unknown): NativeFinalizationConfig {
  const check = guards.NativeFinalizationConfig;
  if (!check(value)) {
    throw new SyntaxError("Invalid native finalization configuration");
  }
  return value;
}

export function parseNativeFinalizationEvent(value: unknown): NativeFinalizationEvent {
  const check = guards.NativeFinalizationEvent;
  if (!check(value)) {
    throw new SyntaxError("Invalid native finalization boundary");
  }
  return value;
}

export function parseSubagentRunConfig(value: unknown): SubagentRunConfig {
  const check = guards.SubagentRunConfig;
  if (!check(value)) {
    throw new Error(`Invalid runner config: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseDetails(value: unknown): Details {
  const check = guards.Details;
  if (!check(value)) {
    throw new Error(`Invalid run details: ${errorsText(check.errors)}.`);
  }
  return value;
}
export function parseSubagentExecutionResult(value: unknown): SubagentExecutionResult {
  const check = guards.SubagentExecutionResult;
  if (!check(value)) {
    throw new Error(`Invalid run result: ${errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryRunRow(value: unknown): HistoryRunRow {
  const check = guards.HistoryRunRow;
  if (!check(value)) {
    throw new Error(`Invalid history run: ${errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryRunPage(value: unknown): HistoryRunPage {
  const check = guards.HistoryRunPage;
  if (!check(value)) {
    throw new Error(`Invalid history runs: ${errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryPage(value: unknown): HistoryPage {
  const check = guards.HistoryPage;
  if (!check(value)) {
    throw new Error(`Invalid history page: ${errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistorySearchPage(value: unknown): HistorySearchPage {
  const check = guards.HistorySearchPage;
  if (!check(value)) {
    throw new Error(`Invalid history search: ${errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryIndexStatus(value: unknown): HistoryIndexStatus {
  const check = guards.HistoryIndexStatus;
  if (!check(value)) {
    throw new Error(`Invalid history status: ${errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryEntry(value: unknown): HistoryEntry {
  const check = guards.HistoryEntry;
  if (!check(value)) {
    throw new Error(`Invalid history entry: ${errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryResult(value: unknown): HistoryResult {
  const check = guards.HistoryResult;
  if (!check(value)) {
    throw new Error(`Invalid history result: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseAsyncStatus(value: unknown): AsyncStatus {
  validateStatusForSummary(value, "status.json");
  const check = guards.AsyncStatus;
  if (!check(value)) {
    throw new Error(`Invalid async status: ${errorsText(check.errors)}.`);
  }
  return value;
}

function resultErrors(errors: readonly unknown[]): string {
  return errors
    .map((error) => {
      if (
        !isRecord(error) ||
        typeof error.instancePath !== "string" ||
        typeof error.message !== "string"
      ) {
        return "invalid shape";
      }
      const field = error.instancePath
        .split("/")
        .slice(1)
        .map((part, index) =>
          /^\d+$/.test(part) ? `[${part}]` : `${index === 0 ? "" : "."}${part}`,
        )
        .join("");
      return `${field} ${error.message.replace("must be string", "must be a string")}`;
    })
    .join("; ");
}

export function parseAsyncResult(value: unknown): AsyncResultFile {
  const check = guards.AsyncResultFile;
  if (!check(value)) {
    throw new Error(`Invalid async result: ${resultErrors(check.errors ?? [])}.`);
  }
  return value;
}

export function parseForegroundResumeRun(value: unknown): ForegroundResumeRun {
  const check = guards.ForegroundResumeRun;
  if (!check(value)) {
    throw new Error(`Invalid foreground run: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseAsyncStartedEvent(value: unknown): AsyncStartedEvent {
  const check = guards.AsyncStartedEvent;
  if (!check(value)) {
    throw new Error(`Invalid async start event: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseControlEvent(value: unknown): ControlEvent {
  const check = guards.ControlEvent;
  if (!check(value)) {
    throw new Error(`Invalid control event: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseSupervisorRunContract(value: unknown): SupervisorRunContract {
  const check = guards.SupervisorRunContract;
  if (!check(value)) {
    throw new Error(`Invalid supervisor contract: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseSupervisorQuestion(value: unknown): SupervisorQuestion {
  const check = guards.SupervisorQuestion;
  if (!check(value)) {
    throw new Error(`Invalid supervisor question: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseQuestionAnswer(value: unknown): QuestionAnswer {
  const check = guards.QuestionAnswer;
  if (!check(value)) {
    throw new Error(`Invalid question answer: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseQuestionDelivery(value: unknown): QuestionDelivery {
  const check = guards.QuestionDelivery;
  if (!check(value)) {
    throw new Error(`Invalid question delivery: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseQuestionRevival(
  value: unknown,
): NonNullable<SupervisorQuestionView["revival"]> {
  const check = guards.SupervisorQuestionView;
  if (!check(value)) {
    throw new Error(`Invalid question revival: ${errorsText(check.errors)}.`);
  }
  return value;
}

export function parseOwnedRun(value: unknown): OwnedRun {
  const check = guards.OwnedRun;
  if (!check(value)) {
    throw new Error(`Invalid owned run: ${errorsText(check.errors)}.`);
  }
  return value;
}
