import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type {
  IntercomEventBus,
  QuestionAnswer,
  SubagentExecutionResult,
  SupervisorQuestionView,
} from "../../shared/types.ts";
import { errorMessage } from "../../shared/unknown.ts";
import {
  cancelSupervisorQuestion,
  claimQuestionRevival,
  formatSupervisorQuestions,
  listSupervisorQuestions,
  questionProcessAlive,
  questionRecoveryHint,
  readQuestionState,
  recordQuestionDelivery,
  releaseQuestionRevival,
  saveQuestionAnswer,
} from "../shared/supervisor-questions.ts";
import {
  liveLaunchOverrideNotice,
  nestedResolutionScopeForExecutor,
  reviveSavedSubagent,
} from "./foreground-control.ts";
import type { ExecutorDeps, SubagentParamsLike } from "./subagent-params.ts";

function questionResult(
  questions: readonly SupervisorQuestionView[],
  text = formatSupervisorQuestions(questions),
): SubagentExecutionResult {
  return {
    content: [{ type: "text", text }],
    details: { mode: "management", results: [], questions },
  };
}

function resultMatches(result: SubagentExecutionResult, pattern: Readonly<RegExp>): boolean {
  return result.content.some((item) => item.type === "text" && pattern.test(item.text));
}

function questionRunId(params: SubagentParamsLike): string | undefined {
  const dirId =
    params.dir !== undefined && params.dir.length > 0 ? path.basename(params.dir) : undefined;
  return params.id ?? params.runId ?? dirId;
}

function pendingQuestion(question: SupervisorQuestionView): boolean {
  return question.state === "awaiting_input" || question.state === "answer_pending";
}

export function projectSupervisorQuestions(
  result: SubagentExecutionResult,
  params: SubagentParamsLike,
  ownerSessionId: string,
  childSafe = false,
): SubagentExecutionResult {
  const questionOnly =
    result.isError === true && resultMatches(result, /Async run not found|Status file not found/);
  if (result.isError === true && !questionOnly) {
    return result;
  }
  const questions = listSupervisorQuestions(ownerSessionId, questionRunId(params)).filter(
    pendingQuestion,
  );
  if (questions.length === 0) {
    return result;
  }
  return {
    ...result,
    ...(questionOnly ? { isError: false } : {}),
    content: [
      {
        type: "text",
        text: [
          `Supervisor input (not execution completion):\n${formatSupervisorQuestions(questions, childSafe)}`,
          ...(questionOnly
            ? []
            : result.content.map((item) => (item.type === "text" ? item.text : ""))),
        ].join("\n\n"),
      },
    ],
    details: { ...result.details, questions },
  };
}

function supervisorControlRunId(
  result: SubagentExecutionResult,
  params: SubagentParamsLike,
): string | undefined {
  return result.details.managementControl?.runId ?? params.id ?? params.runId;
}

export function cancelSupervisorInput(
  result: SubagentExecutionResult,
  params: SubagentParamsLike,
  ownerSessionId: string,
  events?: IntercomEventBus,
): SubagentExecutionResult {
  const rejected =
    result.isError === true &&
    !resultMatches(
      result,
      /No interrupt-capable run|No running async run|has no (active|running) child at index \d+/,
    );
  if (rejected) {
    return result;
  }
  const id = supervisorControlRunId(result, params);
  if (id === undefined || id.length === 0) {
    return result;
  }
  const questions = listSupervisorQuestions(ownerSessionId, id).filter(
    (question) =>
      (params.index === undefined || params.index === question.index) && pendingQuestion(question),
  );
  if (questions.length === 0) {
    return result;
  }
  for (const question of questions) {
    cancelSupervisorQuestion(question);
    events?.emit("subagent:supervisor-question-resolved", { questionId: question.questionId });
  }
  const cancelled = questions.map((question) => readQuestionState(question));
  return result.isError === true
    ? questionResult(
        cancelled,
        `Cancelled ${questions.length} pending supervisor question(s). Any live waiter will abort its agent; cancellation is requested, not proof of process exit.`,
      )
    : { ...result, details: { ...result.details, questions: cancelled } };
}

interface QuestionControlInput {
  readonly params: SubagentParamsLike;
  readonly requestCwd: string;
  readonly ctx: ExtensionContext;
  readonly deps: Readonly<ExecutorDeps>;
}

function selectQuestion(input: QuestionControlInput): readonly SupervisorQuestionView[] {
  const { params } = input;
  if (params.dir !== undefined) {
    throw new Error("questions/answer use a run id, not dir.");
  }
  if (params.index !== undefined && (!Number.isSafeInteger(params.index) || params.index < 0)) {
    throw new Error("index must be a non-negative integer.");
  }
  return listSupervisorQuestions(
    input.ctx.sessionManager.getSessionId(),
    params.id ?? params.runId,
  ).filter((question) => params.index === undefined || question.index === params.index);
}

/** Save the durable answer before either notifying the live waiter or claiming revival. */
export function controlSupervisorQuestion(input: QuestionControlInput): SubagentExecutionResult {
  try {
    const questions = selectQuestion(input);
    const { params } = input;
    if (params.action === "questions") {
      return questionResult(
        questions,
        formatSupervisorQuestions(
          questions,
          nestedResolutionScopeForExecutor(input.deps) !== undefined,
        ),
      );
    }
    const id = params.id ?? params.runId;
    if (
      id === undefined ||
      id.length === 0 ||
      params.questionId === undefined ||
      params.questionId.length === 0
    ) {
      throw new Error("action='answer' requires id and questionId.");
    }
    const question = questions.find((entry) => entry.questionId === params.questionId);
    if (!question) {
      throw new Error(
        "Question not found in this session's runs. Resume the owning supervisor session to answer it.",
      );
    }
    const answer = saveQuestionAnswer(
      question,
      params.message ?? "",
      undefined,
      params.messageOrigin,
    );
    input.deps.pi.events.emit("subagent:supervisor-question-resolved", {
      questionId: question.questionId,
    });
    return deliverQuestionAnswer(input, question, answer);
  } catch (error) {
    return {
      content: [{ type: "text", text: errorMessage(error) }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
}

function deliverQuestionAnswer(
  input: QuestionControlInput,
  question: SupervisorQuestionView,
  answer: QuestionAnswer,
): SubagentExecutionResult {
  if (!question.delivery && questionProcessAlive(question)) {
    return questionResult(
      [readQuestionState(question)],
      [
        `Answer saved for question ${question.questionId}. The live child will read it from the durable waiter; delivery is pending, not execution completion.`,
        liveLaunchOverrideNotice(input.params),
      ]
        .filter((notice) => notice !== undefined && notice.length > 0)
        .join("\n"),
    );
  }
  const delivery = readQuestionState(question).delivery;
  if (delivery) {
    return questionResult(
      [readQuestionState(question)],
      `Question ${question.questionId} was already answered; no new work started. Delivery: ${delivery.kind}, run: ${delivery.runId}.`,
    );
  }
  return reviveQuestionAnswer(input, question, answer);
}

/** Claim before launch; publish delivery only after a successful handoff. */
function reviveQuestionAnswer(
  input: QuestionControlInput,
  question: SupervisorQuestionView,
  answer: QuestionAnswer,
): SubagentExecutionResult {
  const claim = claimQuestionRevival(question);
  if (!claim.claimed) {
    return questionResult(
      [readQuestionState(question)],
      `Answer retained for question ${question.questionId}; continuation ${claim.runId} was already requested. No duplicate process started. Inspect that run first. ${questionRecoveryHint(question, nestedResolutionScopeForExecutor(input.deps) !== undefined)}`,
    );
  }
  // A throw can follow process handoff. Retain the claim on an ambiguous failure
  // so a retry cannot launch a duplicate; only an explicit failed receipt releases it.
  const result = reviveSavedSubagent(
    {
      ...input,
      params: {
        ...input.params,
        message: `${answer.origin === "human" ? "Direct user answer (human origin)" : "Supervisor answer"} to question ${question.questionId}:\n\n${answer.message}\n\nOriginal question:\n${question.message}`,
      },
    },
    { ...question, source: "question" },
    claim.runId,
  );
  if (result.isError === true) {
    releaseQuestionRevival(question);
  } else {
    recordQuestionDelivery(question, {
      kind: "revive",
      runId: claim.runId,
      deliveredAt: Date.now(),
    });
  }
  return { ...result, details: { ...result.details, questions: [readQuestionState(question)] } };
}
