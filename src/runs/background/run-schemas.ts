import { Ajv, type ValidateFunction } from "ajv";
import { validateStatusForSummary } from "./async-status-validation.ts";
import { isRecord } from "./async-value.ts";
import type { SubagentRunConfig } from "./runner-config.ts";
import type {
  NativeFinalizationConfig,
  NativeFinalizationEvent,
} from "../shared/native-finalization-types.ts";
import runSchema from "./schemas/RunContracts.json" with { type: "json" };
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

// Typed guards are compiled from generated canonical declarations, not assertion casts.
// Unknown forward-compatible properties remain permitted; declared nested fields are checked.
// Each guard compiles on first use: eager compilation cost every Pi and runner process ~175 ms.
const validator = new Ajv({ strict: false, allErrors: true, strictNumbers: true });
validator.addSchema(runSchema, "run");

function lazyGuard<T>(ref: string): () => ValidateFunction<T> {
  let validate: ValidateFunction<T> | undefined;
  return () => {
    validate ??= validator.compile<T>({ $ref: ref });
    return validate;
  };
}
const status = lazyGuard<AsyncStatus>("run#/definitions/AsyncStatus");
const result = lazyGuard<AsyncResultFile>("run#/definitions/AsyncResultFile");
const foreground = lazyGuard<ForegroundResumeRun>("run#/definitions/ForegroundResumeRun");
const owned = lazyGuard<OwnedRun>("run#/definitions/OwnedRun");
const started = lazyGuard<AsyncStartedEvent>("run#/definitions/AsyncStartedEvent");
const control = lazyGuard<ControlEvent>("run#/definitions/ControlEvent");
const contract = lazyGuard<SupervisorRunContract>("run#/definitions/SupervisorRunContract");
const question = lazyGuard<SupervisorQuestion>("run#/definitions/SupervisorQuestion");
const answer = lazyGuard<QuestionAnswer>("run#/definitions/QuestionAnswer");
const delivery = lazyGuard<QuestionDelivery>("run#/definitions/QuestionDelivery");
const revival = lazyGuard<NonNullable<SupervisorQuestionView["revival"]>>(
  "run#/definitions/SupervisorQuestionView/properties/revival",
);

const historyRow = lazyGuard<HistoryRunRow>("run#/definitions/HistoryRunRow");
const historyRuns = lazyGuard<HistoryRunPage>("run#/definitions/HistoryRunPage");
const historyPage = lazyGuard<HistoryPage>("run#/definitions/HistoryPage");
const historySearch = lazyGuard<HistorySearchPage>("run#/definitions/HistorySearchPage");
const historyStatus = lazyGuard<HistoryIndexStatus>("run#/definitions/HistoryIndexStatus");
const historyEntry = lazyGuard<HistoryEntry>("run#/definitions/HistoryEntry");
const historyResult = lazyGuard<HistoryResult>("run#/definitions/HistoryResult");

const details = lazyGuard<Details>("run#/definitions/Details");
const executionResult = lazyGuard<SubagentExecutionResult>(
  "run#/definitions/SubagentExecutionResult",
);

const runnerConfig = lazyGuard<SubagentRunConfig>("run#/definitions/SubagentRunConfig");
const finalizationConfig = lazyGuard<NativeFinalizationConfig>(
  "run#/definitions/NativeFinalizationConfig",
);
const finalizationEvent = lazyGuard<NativeFinalizationEvent>(
  "run#/definitions/NativeFinalizationEvent",
);

export function parseNativeFinalizationConfig(value: unknown): NativeFinalizationConfig {
  const check = finalizationConfig();
  if (!check(value)) {
    throw new SyntaxError("Invalid native finalization configuration");
  }
  return value;
}

export function parseNativeFinalizationEvent(value: unknown): NativeFinalizationEvent {
  const check = finalizationEvent();
  if (!check(value)) {
    throw new SyntaxError("Invalid native finalization boundary");
  }
  return value;
}

export function parseSubagentRunConfig(value: unknown): SubagentRunConfig {
  const check = runnerConfig();
  if (!check(value)) {
    throw new Error(`Invalid runner config: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseDetails(value: unknown): Details {
  const check = details();
  if (!check(value)) {
    throw new Error(`Invalid run details: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
export function parseSubagentExecutionResult(value: unknown): SubagentExecutionResult {
  const check = executionResult();
  if (!check(value)) {
    throw new Error(`Invalid run result: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryRunRow(value: unknown): HistoryRunRow {
  const check = historyRow();
  if (!check(value)) {
    throw new Error(`Invalid history run: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryRunPage(value: unknown): HistoryRunPage {
  const check = historyRuns();
  if (!check(value)) {
    throw new Error(`Invalid history runs: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryPage(value: unknown): HistoryPage {
  const check = historyPage();
  if (!check(value)) {
    throw new Error(`Invalid history page: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistorySearchPage(value: unknown): HistorySearchPage {
  const check = historySearch();
  if (!check(value)) {
    throw new Error(`Invalid history search: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryIndexStatus(value: unknown): HistoryIndexStatus {
  const check = historyStatus();
  if (!check(value)) {
    throw new Error(`Invalid history status: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryEntry(value: unknown): HistoryEntry {
  const check = historyEntry();
  if (!check(value)) {
    throw new Error(`Invalid history entry: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
export function parseHistoryResult(value: unknown): HistoryResult {
  const check = historyResult();
  if (!check(value)) {
    throw new Error(`Invalid history result: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseAsyncStatus(value: unknown): AsyncStatus {
  validateStatusForSummary(value, "status.json");
  const check = status();
  if (!check(value)) {
    throw new Error(`Invalid async status: ${validator.errorsText(check.errors)}.`);
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
  const check = result();
  if (!check(value)) {
    throw new Error(`Invalid async result: ${resultErrors(check.errors ?? [])}.`);
  }
  return value;
}

export function parseForegroundResumeRun(value: unknown): ForegroundResumeRun {
  const check = foreground();
  if (!check(value)) {
    throw new Error(`Invalid foreground run: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseAsyncStartedEvent(value: unknown): AsyncStartedEvent {
  const check = started();
  if (!check(value)) {
    throw new Error(`Invalid async start event: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseControlEvent(value: unknown): ControlEvent {
  const check = control();
  if (!check(value)) {
    throw new Error(`Invalid control event: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseSupervisorRunContract(value: unknown): SupervisorRunContract {
  const check = contract();
  if (!check(value)) {
    throw new Error(`Invalid supervisor contract: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseSupervisorQuestion(value: unknown): SupervisorQuestion {
  const check = question();
  if (!check(value)) {
    throw new Error(`Invalid supervisor question: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseQuestionAnswer(value: unknown): QuestionAnswer {
  const check = answer();
  if (!check(value)) {
    throw new Error(`Invalid question answer: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseQuestionDelivery(value: unknown): QuestionDelivery {
  const check = delivery();
  if (!check(value)) {
    throw new Error(`Invalid question delivery: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseQuestionRevival(
  value: unknown,
): NonNullable<SupervisorQuestionView["revival"]> {
  const check = revival();
  if (!check(value)) {
    throw new Error(`Invalid question revival: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}

export function parseOwnedRun(value: unknown): OwnedRun {
  const check = owned();
  if (!check(value)) {
    throw new Error(`Invalid owned run: ${validator.errorsText(check.errors)}.`);
  }
  return value;
}
