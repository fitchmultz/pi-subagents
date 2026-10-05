import { Ajv } from "ajv";
import statusSchema from "./schemas/AsyncStatus.json" with { type: "json" };
import resultSchema from "./schemas/AsyncResultFile.json" with { type: "json" };
import foregroundSchema from "./schemas/ForegroundResumeRun.json" with { type: "json" };
import ownedSchema from "./schemas/OwnedRun.json" with { type: "json" };
import startedSchema from "./schemas/AsyncStartedEvent.json" with { type: "json" };
import controlSchema from "./schemas/ControlEvent.json" with { type: "json" };
import contractSchema from "./schemas/SupervisorRunContract.json" with { type: "json" };
import questionSchema from "./schemas/SupervisorQuestion.json" with { type: "json" };
import answerSchema from "./schemas/QuestionAnswer.json" with { type: "json" };
import deliverySchema from "./schemas/QuestionDelivery.json" with { type: "json" };
import questionViewSchema from "./schemas/SupervisorQuestionView.json" with { type: "json" };
import type { AsyncStatus, AsyncResultFile, ForegroundResumeRun, OwnedRun, AsyncStartedEvent, ControlEvent, SupervisorRunContract, SupervisorQuestion, QuestionAnswer, QuestionDelivery, SupervisorQuestionView } from "../../shared/types.ts";

// Typed guards are compiled from generated canonical declarations, not assertion casts.
// Unknown forward-compatible properties remain permitted; declared nested fields are checked.
const validator = new Ajv({ strict: false, allErrors: true, strictNumbers: true });
const status = validator.compile<AsyncStatus>(statusSchema);
const result = validator.compile<AsyncResultFile>(resultSchema);
const foreground = validator.compile<ForegroundResumeRun>(foregroundSchema);
const owned = validator.compile<OwnedRun>(ownedSchema);
const started = validator.compile<AsyncStartedEvent>(startedSchema);
const control = validator.compile<ControlEvent>(controlSchema);
const contract = validator.compile<SupervisorRunContract>(contractSchema);
const question = validator.compile<SupervisorQuestion>(questionSchema);
const answer = validator.compile<QuestionAnswer>(answerSchema);
const delivery = validator.compile<QuestionDelivery>(deliverySchema);
const revival = validator.compile<NonNullable<SupervisorQuestionView["revival"]>>(questionViewSchema.properties.revival);

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

export function parseQuestionRevival(value: unknown): NonNullable<SupervisorQuestionView["revival"]> {
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
