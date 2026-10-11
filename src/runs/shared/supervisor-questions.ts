import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { formatRunAction } from "../../shared/status-format.ts";
import { runCooperatively, runSynchronously } from "../../shared/cooperative.ts";
import { ASYNC_DIR, type ReadonlyAsyncStatus, type ControlEvent } from "../../shared/types.ts";

import {
  getRunMetadataDir,
  readRunJson,
  readQuestionOwner,
  safeId,
  QUESTIONS_DIR,
  migrateSupervisorQuestionSteps,
  migrateSupervisorQuestions,
  readQuestionContract,
} from "./run-metadata.ts";
import { parseAsyncStatus, parseSupervisorQuestion } from "../background/run-schemas.ts";
import { hasErrorCode } from "../../shared/unknown.ts";
import { questionDir, readQuestionState } from "./supervisor-question-state.ts";
export {
  LEGACY_QUESTIONS_DIR,
  QUESTIONS_DIR,
  getRunMetadataDir,
  readQuestionOwner,
  saveAsyncRunResult,
  compactOwnerResult,
  saveRunStatus,
  readRunJson,
  saveQuestionOwner,
  saveQuestionContract,
  readQuestionContract,
  migrateSupervisorQuestions,
  migrateSupervisorQuestionSteps,
} from "./run-metadata.ts";
export {
  readQuestionState,
  saveQuestionAnswer,
  recordQuestionDelivery,
  cancelSupervisorQuestion,
  questionProcessAlive,
  claimQuestionRevival,
  releaseQuestionRevival,
} from "./supervisor-question-state.ts";
import type {
  SupervisorQuestion,
  SupervisorQuestionView,
  SupervisorQuestionSummary,
} from "../../shared/types/questions.ts";
export type {
  SupervisorRunContract,
  SupervisorQuestion,
  QuestionAnswer,
  QuestionDelivery,
  SupervisorQuestionView,
  SupervisorQuestionSummary,
} from "../../shared/types/questions.ts";

export function summarizeSupervisorQuestion(
  question: SupervisorQuestionView,
): SupervisorQuestionSummary {
  const directory = questionDir(question);
  const hasInterview = Boolean(question.interview);
  return {
    questionId: question.questionId,
    runId: question.runId,
    ownerSessionId: question.ownerSessionId,
    ownerTarget: question.ownerTarget,
    agent: question.agent,
    index: question.index,
    childSessionId: question.childSessionId,
    childTarget: question.childTarget,
    sessionFile: question.sessionFile,
    cwd: question.cwd,
    pid: question.pid,
    processIdentity: question.processIdentity,
    createdAt: question.createdAt,
    reason: question.reason,
    state: question.state,
    message: question.message.slice(0, 2048),
    questionPath: path.join(directory, "question.json"),
    ...(question.message.length > 2048 ? { messageTruncated: true } : {}),
    ...(hasInterview ? { hasInterview: true } : {}),
    ...(question.answer
      ? {
          answer: {
            message: question.answer.message.slice(0, 2048),
            answeredAt: question.answer.answeredAt,
            origin: question.answer.origin,
          },
          answerPath: path.join(directory, "answer.json"),
          ...(question.answer.message.length > 2048 ? { answerTruncated: true } : {}),
        }
      : {}),
    ...(question.delivery
      ? {
          delivery: {
            kind: question.delivery.kind,
            runId: question.delivery.runId,
            deliveredAt: question.delivery.deliveredAt,
          },
        }
      : {}),
    ...(question.revival
      ? {
          revival: {
            runId: question.revival.runId,
            pid: question.revival.pid,
            startedAt: question.revival.startedAt,
          },
        }
      : {}),
  };
}

export function supervisorQuestionPage(
  questions: readonly SupervisorQuestionView[],
  options: { readonly offset?: number; readonly limit?: number } = {},
): {
  readonly questions: readonly SupervisorQuestionSummary[];
  readonly questionList: {
    readonly total: number;
    readonly offset: number;
    readonly limit: number;
    readonly nextOffset?: number;
  };
} {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Question offset must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Question limit must be from 1 to 100.");
  }
  const pending = (question: SupervisorQuestionView): number =>
    question.state === "awaiting_input" || question.state === "answer_pending" ? 0 : 1;
  const sorted = questions.toSorted((a, b) => {
    const priority = pending(a) - pending(b);
    if (priority !== 0) {
      return priority;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.questionId.localeCompare(b.questionId);
  });
  return {
    questions: sorted.slice(offset, offset + limit).map(summarizeSupervisorQuestion),
    questionList: {
      total: questions.length,
      offset,
      limit,
      ...(offset + limit < questions.length ? { nextOffset: offset + limit } : {}),
    },
  };
}

type QuestionInput = Omit<SupervisorQuestion, "questionId" | "createdAt" | "ownerSessionId">;
function questionOwner(
  runId: string,
  root: string,
): { readonly sessionId: string; readonly status?: ReadonlyAsyncStatus } {
  const runDir = getRunMetadataDir(runId, root);
  const status =
    readRunJson(path.join(runDir, "status.json"), parseAsyncStatus) ??
    (root === QUESTIONS_DIR
      ? readRunJson(path.join(ASYNC_DIR, safeId(runId), "status.json"), parseAsyncStatus)
      : undefined);
  const owner = readQuestionOwner(runId, root) ?? status;
  if (owner?.sessionId === undefined || owner.sessionId === "") {
    throw new Error(
      `Run ${runId} has no saved question owner; cannot create a recoverable supervisor question.`,
    );
  }
  return { sessionId: owner.sessionId, status };
}
function validateQuestionInput(input: QuestionInput): void {
  if (
    typeof input.sessionFile !== "string" ||
    input.sessionFile === "" ||
    path.extname(input.sessionFile) !== ".jsonl"
  ) {
    throw new Error("Supervisor questions require a saved child session.");
  }
  if (!Number.isSafeInteger(input.index) || input.index < 0) {
    throw new Error("Child index must be a non-negative integer.");
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new Error("Supervisor question must not be empty.");
  }
}

export function createSupervisorQuestion(
  input: QuestionInput,
  root = QUESTIONS_DIR,
): SupervisorQuestion {
  const owner = questionOwner(input.runId, root);
  validateQuestionInput(input);
  const contract = readQuestionContract(input.runId, input.index, root, {
    sessionFile: input.sessionFile,
  }) ?? {
    effectiveAcceptance: owner.status?.steps?.[input.index]?.acceptance?.effectiveAcceptance,
  };
  const question = {
    ...input,
    ...contract,
    sessionFile: input.sessionFile,
    pid: input.pid,
    ownerSessionId: owner.sessionId,
    questionId: randomUUID(),
    createdAt: Date.now(),
  };
  writeAtomicJson(path.join(questionDir(question, root), "question.json"), question);
  return question;
}

export function listRunQuestions(runDir: string): SupervisorQuestionView[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(runDir, "questions"), { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const question = readRunJson(
        path.join(runDir, "questions", entry.name, "question.json"),
        parseSupervisorQuestion,
      );
      return question ? [readQuestionState(question, path.dirname(runDir))] : [];
    });
}

/** Known run IDs need neither a global directory walk nor prefix resolution. */
export function listOwnedRunQuestions(
  ownerSessionId: string,
  runId: string,
): SupervisorQuestionView[] {
  migrateSupervisorQuestions(ownerSessionId, runId);
  return listRunQuestions(getRunMetadataDir(runId)).filter(
    (question) => question.ownerSessionId === ownerSessionId,
  );
}

export function pendingSupervisorQuestion(input: {
  readonly runId: string;
  readonly agent: string;
  readonly index: number;
  readonly sessionFile?: string;
  readonly pid?: number;
}): ControlEvent["supervisorQuestion"] {
  if (input.sessionFile === undefined || input.sessionFile === "") {
    return undefined;
  }
  try {
    const pid = input.pid ?? readQuestionContract(input.runId, input.index)?.pid;
    const question = listRunQuestions(getRunMetadataDir(input.runId)).find(
      (candidate) =>
        candidate.runId === input.runId &&
        candidate.agent === input.agent &&
        candidate.index === input.index &&
        candidate.sessionFile === input.sessionFile &&
        candidate.pid === pid &&
        (candidate.state === "awaiting_input" || candidate.state === "answer_pending"),
    );
    if (question && (question.state === "awaiting_input" || question.state === "answer_pending")) {
      return {
        questionId: question.questionId,
        state: question.state,
        ...(question.answer ? { answer: question.answer.message } : {}),
      };
    }
  } catch (error) {
    console.error(`Could not read supervisor wait for ${input.runId}:${input.index}:`, error);
  }
  return undefined;
}

export function listSupervisorQuestions(
  ownerSessionId: string,
  runId?: string,
  root = QUESTIONS_DIR,
): SupervisorQuestionView[] {
  return runSynchronously(supervisorQuestionSteps(ownerSessionId, runId, root));
}

export function listSupervisorQuestionsAsync(
  ownerSessionId: string,
): Promise<SupervisorQuestionView[]> {
  return runCooperatively(supervisorQuestionSteps(ownerSessionId));
}

function* supervisorQuestionSteps(
  ownerSessionId: string,
  runId?: string,
  root = QUESTIONS_DIR,
): Generator<void, SupervisorQuestionView[]> {
  if (runId !== undefined) {
    safeId(runId);
  }
  if (root === QUESTIONS_DIR) {
    yield* migrateSupervisorQuestionSteps(ownerSessionId);
  }
  if (!fs.existsSync(root)) {
    return [];
  }
  const runs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (runId === undefined || runId === "" || entry.name.startsWith(runId)),
    );
  const questions: SupervisorQuestionView[] = [];
  for (const entry of runs) {
    yield;
    try {
      questions.push(
        ...listRunQuestions(path.join(root, entry.name)).filter(
          (question) => question.ownerSessionId === ownerSessionId,
        ),
      );
    } catch (error) {
      if (runId !== undefined) {
        throw error;
      }
      console.error(`Could not list questions for ${entry.name}:`, error);
    }
  }
  assertQuestionRunUnambiguous(runId, questions);
  return questions.sort((a, b) => a.createdAt - b.createdAt);
}

function assertQuestionRunUnambiguous(
  runId: string | undefined,
  questions: readonly SupervisorQuestionView[],
): void {
  if (
    runId !== undefined &&
    runId !== "" &&
    new Set(questions.map((question) => question.runId)).size > 1
  ) {
    throw new Error(`Ambiguous run ID prefix '${runId}'.`);
  }
}
function questionAnswerHint(question: SupervisorQuestionSummary, childSafe: boolean): string {
  if (question.delivery) {
    return `Answer delivered via ${question.delivery.kind}; run: ${question.delivery.runId}`;
  }
  if (question.state === "cancelled") {
    return "Question cancelled; use continue for a new follow-up.";
  }
  if (question.answerTruncated === true) {
    return `Retry answer with the exact saved message from ${question.answerPath ?? ""}; a preview is not a valid replacement.`;
  }
  return `Answer: ${formatRunAction("answer", question.runId, { questionId: question.questionId, message: question.answer?.message ?? "..." }, childSafe)}`;
}

export function questionRecoveryHint(
  question: Pick<SupervisorQuestion, "runId" | "index">,
  childSafe = false,
): string {
  return `Recover an unlaunched continuation: ${formatRunAction("resume", question.runId, { index: question.index, message: "Continue with the saved supervisor answer." }, childSafe)}`;
}

export function formatSupervisorQuestions(
  questions: readonly SupervisorQuestionSummary[],
  childSafe = false,
): string {
  if (questions.length === 0) {
    return "No supervisor questions owned by this session.";
  }
  return questions
    .map((question) =>
      [
        `Question: ${question.questionId} | ${question.state}`,
        `Run: ${question.runId} | Child: ${question.index} (${question.agent}) | Owner: ${question.ownerSessionId}`,
        `Session: ${question.sessionFile} | Child target: ${question.childTarget}`,
        question.message,
        ...(question.messageTruncated === true
          ? [`[Question preview truncated. Full question: ${question.questionPath}]`]
          : []),
        ...(question.hasInterview === true
          ? [`Structured interview: ${question.questionPath}`]
          : []),
        ...(question.answer
          ? [
              `Saved answer: ${question.answer.message}`,
              ...(question.answerTruncated === true
                ? [`[Answer preview truncated. Exact saved answer: ${question.answerPath ?? ""}]`]
                : []),
            ]
          : []),
        ...(question.revival && !question.delivery
          ? [
              `Continuation requested: ${question.revival.runId}; delivery unconfirmed. Answer retained.`,
              questionRecoveryHint(question, childSafe),
            ]
          : []),
        questionAnswerHint(question, childSafe),
      ].join("\n"),
    )
    .join("\n\n");
}
