import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { readRunJson, safeId, QUESTIONS_DIR, LEGACY_QUESTIONS_DIR } from "./run-metadata.ts";
import {
  parseQuestionAnswer,
  parseQuestionDelivery,
  parseQuestionRevival,
} from "../background/run-schemas.ts";
import { hasErrorCode, isRecord } from "../../shared/unknown.ts";
import type { ReadonlyInput } from "../../shared/types.ts";
import type {
  SupervisorQuestion,
  SupervisorQuestionView,
  QuestionAnswer,
  QuestionDelivery,
} from "../../shared/types/questions.ts";

export function questionDir(
  question: Pick<SupervisorQuestion, "runId" | "questionId">,
  root = QUESTIONS_DIR,
): string {
  return path.join(root, safeId(question.runId), "questions", safeId(question.questionId));
}

// Atomic publication without replacement: concurrent answers/launches have exactly one winner.
function writeOnce(file: string, value: unknown): boolean {
  if (!isRecord(value)) {
    throw new Error("Question state must be a record.");
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeAtomicJson(temporary, value);
  try {
    fs.linkSync(temporary, file);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function questionStatePaths(
  question: ReadonlyInput<SupervisorQuestion>,
  file: string,
  root: string,
): [string, ...string[]] {
  const current = path.join(questionDir(question, root), file);
  const legacy = questionDir(question, LEGACY_QUESTIONS_DIR);
  // Old waiters still claim the legacy file; both runtimes must compete on that same inode.
  return root === QUESTIONS_DIR && fs.existsSync(path.join(legacy, "question.json"))
    ? [path.join(legacy, file), current]
    : [current];
}

function writeQuestionStateOnce(
  question: ReadonlyInput<SupervisorQuestion>,
  file: string,
  value: unknown,
  root: string,
): boolean {
  const [primary, ...mirrors] = questionStatePaths(question, file, root);
  const written = writeOnce(primary, value);
  const winner = written ? value : readRunJson(primary);
  if (!isRecord(winner)) {
    throw new Error("Saved question state is unavailable or invalid.");
  }
  for (const target of mirrors) {
    writeOnce(target, winner);
  }
  return written;
}

export function readQuestionState(
  question: ReadonlyInput<SupervisorQuestion>,
  root = QUESTIONS_DIR,
): SupervisorQuestionView {
  const read = (file: string): unknown =>
    questionStatePaths(question, file, root)
      .map((entry) => readRunJson(entry))
      .find((entry) => entry !== undefined);
  const rawAnswer = read("answer.json");
  const rawDelivery = read("delivery.json");
  const rawRevival = read("revival.json");
  const answer = rawAnswer === undefined ? undefined : parseQuestionAnswer(rawAnswer);
  const delivery = rawDelivery === undefined ? undefined : parseQuestionDelivery(rawDelivery);
  const revival = rawRevival === undefined ? undefined : parseQuestionRevival(rawRevival);
  const cancelled = read("cancelled.json") !== undefined;
  return {
    ...question,
    state: questionState(delivery, cancelled, answer),
    ...(answer ? { answer } : {}),
    ...(delivery ? { delivery } : {}),
    ...(revival ? { revival } : {}),
  };
}

function questionState(
  delivery: ReadonlyInput<QuestionDelivery> | undefined,
  cancelled: boolean,
  answer: QuestionAnswer | undefined,
): SupervisorQuestionView["state"] {
  if (delivery) {
    return "answered";
  }
  if (cancelled) {
    return "cancelled";
  }
  return answer ? "answer_pending" : "awaiting_input";
}

function answerRecord(
  previous: QuestionAnswer | undefined,
  message: string,
  origin: "human" | undefined,
): QuestionAnswer {
  const answerOrigin = previous?.origin ?? origin;
  return {
    message: message.trim(),
    answeredAt: previous?.answeredAt ?? Date.now(),
    ...(answerOrigin === undefined ? {} : { origin: answerOrigin }),
  };
}
function assertAnswerMatches(
  questionId: string,
  expected: string,
  existing: QuestionAnswer | undefined,
): void {
  if (existing && existing.message !== expected) {
    throw new Error(
      `Question ${questionId} already has a different saved answer. The original answer was retained.`,
    );
  }
}

export function saveQuestionAnswer(
  question: ReadonlyInput<SupervisorQuestion>,
  message: string,
  root = QUESTIONS_DIR,
  origin?: "human",
): QuestionAnswer {
  if (typeof message !== "string" || message.trim() === "") {
    throw new Error("action='answer' requires a non-empty message.");
  }
  const state = readQuestionState(question, root);
  if (state.state === "cancelled") {
    throw new Error(
      `Question ${question.questionId} was cancelled. Use continue for a new follow-up.`,
    );
  }
  const answer = answerRecord(state.answer, message, origin);
  assertAnswerMatches(question.questionId, answer.message, state.answer);
  if (writeQuestionStateOnce(question, "answer.json", answer, root)) {
    return answer;
  }
  const existing = readQuestionState(question, root).answer;
  if (!existing) {
    throw new Error("The winning saved answer is unavailable.");
  }
  assertAnswerMatches(question.questionId, answer.message, existing);
  return existing;
}

export function recordQuestionDelivery(
  question: ReadonlyInput<SupervisorQuestion>,
  delivery: ReadonlyInput<QuestionDelivery>,
  root = QUESTIONS_DIR,
): void {
  writeQuestionStateOnce(question, "delivery.json", delivery, root);
}

export function cancelSupervisorQuestion(
  question: ReadonlyInput<SupervisorQuestion>,
  root = QUESTIONS_DIR,
): void {
  writeQuestionStateOnce(question, "cancelled.json", { cancelledAt: Date.now() }, root);
}

export function questionProcessAlive(question: Pick<SupervisorQuestion, "pid">): boolean {
  if (!Number.isSafeInteger(question.pid) || question.pid <= 0) {
    throw new Error("Invalid child process ID.");
  }
  try {
    process.kill(question.pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

export function claimQuestionRevival(
  question: ReadonlyInput<SupervisorQuestion>,
  root = QUESTIONS_DIR,
): { claimed: boolean; runId: string } {
  const runId = `answer-${question.questionId}`;
  if (readQuestionState(question, root).revival) {
    return { claimed: false, runId };
  }
  return {
    claimed: writeQuestionStateOnce(
      question,
      "revival.json",
      { runId, pid: process.pid, startedAt: Date.now() },
      root,
    ),
    runId,
  };
}

export function releaseQuestionRevival(
  question: ReadonlyInput<SupervisorQuestion>,
  root = QUESTIONS_DIR,
): void {
  for (const file of questionStatePaths(question, "revival.json", root)) {
    fs.rmSync(file, { force: true });
  }
}
