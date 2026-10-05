import { Ajv } from "ajv";
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
} from "../../shared/types.ts";

// Typed guards are compiled from generated canonical declarations, not assertion casts.
// Unknown forward-compatible properties remain permitted; declared nested fields are checked.
const validator = new Ajv({ strict: false, allErrors: true, strictNumbers: true });
validator.addSchema(runSchema, "run");
const status = validator.compile<AsyncStatus>({ $ref: "run#/definitions/AsyncStatus" });
const result = validator.compile<AsyncResultFile>({ $ref: "run#/definitions/AsyncResultFile" });
const foreground = validator.compile<ForegroundResumeRun>({
  $ref: "run#/definitions/ForegroundResumeRun",
});
const owned = validator.compile<OwnedRun>({ $ref: "run#/definitions/OwnedRun" });
const started = validator.compile<AsyncStartedEvent>({
  $ref: "run#/definitions/AsyncStartedEvent",
});
const control = validator.compile<ControlEvent>({ $ref: "run#/definitions/ControlEvent" });
const contract = validator.compile<SupervisorRunContract>({
  $ref: "run#/definitions/SupervisorRunContract",
});
const question = validator.compile<SupervisorQuestion>({
  $ref: "run#/definitions/SupervisorQuestion",
});
const answer = validator.compile<QuestionAnswer>({ $ref: "run#/definitions/QuestionAnswer" });
const delivery = validator.compile<QuestionDelivery>({ $ref: "run#/definitions/QuestionDelivery" });
const revival = validator.compile<NonNullable<SupervisorQuestionView["revival"]>>({
  $ref: "run#/definitions/SupervisorQuestionView/properties/revival",
});

const historyRow = validator.compile<HistoryRunRow>({ $ref: "run#/definitions/HistoryRunRow" });
const historyRuns = validator.compile<HistoryRunPage>({ $ref: "run#/definitions/HistoryRunPage" });
const historyPage = validator.compile<HistoryPage>({ $ref: "run#/definitions/HistoryPage" });
const historySearch = validator.compile<HistorySearchPage>({
  $ref: "run#/definitions/HistorySearchPage",
});
const historyStatus = validator.compile<HistoryIndexStatus>({
  $ref: "run#/definitions/HistoryIndexStatus",
});
const historyEntry = validator.compile<HistoryEntry>({ $ref: "run#/definitions/HistoryEntry" });
const historyResult = validator.compile<HistoryResult>({ $ref: "run#/definitions/HistoryResult" });

export function parseHistoryRunRow(value: unknown): HistoryRunRow {
  if (!historyRow(value)) {
    throw new Error(`Invalid history run: ${validator.errorsText(historyRow.errors)}.`);
  }
  return value;
}
export function parseHistoryRunPage(value: unknown): HistoryRunPage {
  if (!historyRuns(value)) {
    throw new Error(`Invalid history runs: ${validator.errorsText(historyRuns.errors)}.`);
  }
  return value;
}
export function parseHistoryPage(value: unknown): HistoryPage {
  if (!historyPage(value)) {
    throw new Error(`Invalid history page: ${validator.errorsText(historyPage.errors)}.`);
  }
  return value;
}
export function parseHistorySearchPage(value: unknown): HistorySearchPage {
  if (!historySearch(value)) {
    throw new Error(`Invalid history search: ${validator.errorsText(historySearch.errors)}.`);
  }
  return value;
}
export function parseHistoryIndexStatus(value: unknown): HistoryIndexStatus {
  if (!historyStatus(value)) {
    throw new Error(`Invalid history status: ${validator.errorsText(historyStatus.errors)}.`);
  }
  return value;
}
export function parseHistoryEntry(value: unknown): HistoryEntry {
  if (!historyEntry(value)) {
    throw new Error(`Invalid history entry: ${validator.errorsText(historyEntry.errors)}.`);
  }
  return value;
}
export function parseHistoryResult(value: unknown): HistoryResult {
  if (!historyResult(value)) {
    throw new Error(`Invalid history result: ${validator.errorsText(historyResult.errors)}.`);
  }
  return value;
}

export function parseAsyncStatus(value: unknown): AsyncStatus {
  if (!status(value)) {
    throw new Error(`Invalid async status: ${validator.errorsText(status.errors)}.`);
  }
  return value;
}

export function parseAsyncResult(value: unknown): AsyncResultFile {
  if (!result(value)) {
    throw new Error(`Invalid async result: ${validator.errorsText(result.errors)}.`);
  }
  return value;
}

export function parseForegroundResumeRun(value: unknown): ForegroundResumeRun {
  if (!foreground(value)) {
    throw new Error(`Invalid foreground run: ${validator.errorsText(foreground.errors)}.`);
  }
  return value;
}

export function parseAsyncStartedEvent(value: unknown): AsyncStartedEvent {
  if (!started(value)) {
    throw new Error(`Invalid async start event: ${validator.errorsText(started.errors)}.`);
  }
  return value;
}

export function parseControlEvent(value: unknown): ControlEvent {
  if (!control(value)) {
    throw new Error(`Invalid control event: ${validator.errorsText(control.errors)}.`);
  }
  return value;
}

export function parseSupervisorRunContract(value: unknown): SupervisorRunContract {
  if (!contract(value)) {
    throw new Error(`Invalid supervisor contract: ${validator.errorsText(contract.errors)}.`);
  }
  return value;
}

export function parseSupervisorQuestion(value: unknown): SupervisorQuestion {
  if (!question(value)) {
    throw new Error(`Invalid supervisor question: ${validator.errorsText(question.errors)}.`);
  }
  return value;
}

export function parseQuestionAnswer(value: unknown): QuestionAnswer {
  if (!answer(value)) {
    throw new Error(`Invalid question answer: ${validator.errorsText(answer.errors)}.`);
  }
  return value;
}

export function parseQuestionDelivery(value: unknown): QuestionDelivery {
  if (!delivery(value)) {
    throw new Error(`Invalid question delivery: ${validator.errorsText(delivery.errors)}.`);
  }
  return value;
}

export function parseQuestionRevival(
  value: unknown,
): NonNullable<SupervisorQuestionView["revival"]> {
  if (!revival(value)) {
    throw new Error(`Invalid question revival: ${validator.errorsText(revival.errors)}.`);
  }
  return value;
}

export function parseOwnedRun(value: unknown): OwnedRun {
  if (!owned(value)) {
    throw new Error(`Invalid owned run: ${validator.errorsText(owned.errors)}.`);
  }
  return value;
}
