import { ownedRunView } from "../runs/shared/run-records.ts";
import { acceptanceHumanAction } from "../runs/shared/acceptance-evaluation.ts";
import { getRunMetadataDir, listRunQuestions } from "../runs/shared/supervisor-questions.ts";
import type { HistoryRunRow, OwnedRun, ReadonlyForegroundResumeRun } from "./types.ts";
import type { OwnedRunReadState } from "../runs/shared/owned-run-read-state.ts";
import { safeText } from "./text.ts";

type Child = HistoryRunRow["children"][number];
function compactResult(result: Child["result"]): Child["result"] {
  if (!result) {
    return;
  }
  return {
    agent: result.agent,
    task: safeText(result.task),
    exitCode: result.exitCode,
    usage: {
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      cost: result.usage.cost,
      turns: result.usage.turns,
    },
    finalOutput: safeText(result.finalOutput, 1024),
    error: result.error === undefined ? undefined : safeText(result.error),
    sessionFile: result.sessionFile,
    terminalEntryId: result.terminalEntryId,
    terminalLeafId: result.terminalLeafId,
    detached: result.detached,
    interrupted: result.interrupted,
    timedOut: result.timedOut,
    nativeSessionId: result.nativeSessionId,
    accounting: result.accounting,
    agentProcessExit: result.agentProcessExit,
    model: result.model,
    fullOutputPath: result.fullOutputPath,
  };
}
function compactActivity(activity: Child["activity"]): Child["activity"] {
  if (!activity) {
    return;
  }
  return {
    status: activity.status,
    currentTool: activity.currentTool,
    currentToolArgs:
      activity.currentToolArgs === undefined ? undefined : safeText(activity.currentToolArgs, 256),
    currentPath: activity.currentPath,
    streamingText:
      activity.streamingText === undefined
        ? undefined
        : safeText(activity.streamingText.slice(-2048), 2048),
    lastActivityAt: activity.lastActivityAt,
    recentOutput: activity.recentOutput?.slice(-4).map((line) => safeText(line, 256)),
  };
}
function compactChild(child: Child): Child {
  return {
    agent: child.agent,
    index: child.index,
    workflowNodeId: child.workflowNodeId,
    sessionFile: child.sessionFile,
    task: child.task === undefined ? undefined : safeText(child.task),
    label: child.label === undefined ? undefined : safeText(child.label, 256),
    state: child.state,
    configuration: child.configuration,
    missingSession: child.missingSession,
    identityUnavailable: child.identityUnavailable,
    modelSelection: child.modelSelection,
    savedConfiguration: child.launch && {
      model: child.launch.model,
      thinking: child.launch.thinking,
      modelRecordedAt: child.launch.modelRecordedAt,
    },
    humanAction:
      child.result?.acceptance && safeText(acceptanceHumanAction(child.result.acceptance), 2048),
    acceptanceStatus: child.result?.acceptance?.status,
    activity: compactActivity(child.activity),
    result: compactResult(child.result),
  };
}
function compactQuestion(
  question: NonNullable<HistoryRunRow["questions"]>[number],
): NonNullable<HistoryRunRow["questions"]>[number] {
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
    message: safeText(question.message, 2048),
    state: question.state,
    answer: question.answer && {
      ...question.answer,
      message: safeText(question.answer.message, 2048),
    },
    delivery: question.delivery,
    revival: question.revival,
  };
}
export function unknownRun(
  run: OwnedRun,
  diagnosis = "Run summary is awaiting background canonical projection.",
): HistoryRunRow {
  return {
    ...run,
    state: "unknown",
    updatedAt: run.startedAt,
    attention: ["unknown"],
    canInterrupt: false,
    continuations: [],
    children: run.children.map((child) => ({
      ...child,
      state: "unknown",
      configuration: "legacy-partial",
    })),
    diagnosis,
  };
}
export function compactView(view: HistoryRunRow): HistoryRunRow {
  return {
    ...view,
    task: safeText(view.task, 2048),
    error: view.error === undefined ? undefined : safeText(view.error),
    diagnosis: view.diagnosis === undefined ? undefined : safeText(view.diagnosis),
    recoveryError: view.recoveryError === undefined ? undefined : safeText(view.recoveryError),
    review: view.review && {
      ...view.review,
      message: view.review.message === undefined ? undefined : safeText(view.review.message),
    },
    continuations: [],
    questions: view.questions?.map(compactQuestion),
    children: view.children.map(compactChild),
    summary: safeText(
      view.children
        .map((child) => child.result?.finalOutput ?? child.result?.error ?? "")
        .filter((text) => text.length > 0)
        .join(" | "),
      1024,
    ),
  };
}
/** Canonical owner/filesystem projection. Native transcript presence never establishes completion. */
export function projectRun(
  run: OwnedRun,
  ownerSessionId: string,
  runs: Readonly<ReadonlyMap<string, OwnedRun>>,
  foreground: Readonly<ReadonlyMap<string, ReadonlyForegroundResumeRun>>,
): HistoryRunRow {
  const state: OwnedRunReadState = { ownedRuns: runs, foregroundRuns: foreground };
  const questions = listRunQuestions(getRunMetadataDir(run.runId)).filter(
    (question) =>
      question.ownerSessionId === ownerSessionId &&
      ["awaiting_input", "answer_pending"].includes(question.state),
  );
  return {
    ...ownedRunView(run, state, {
      pendingInput: questions.length > 0,
      includeContinuations: false,
      readConfiguration: false,
      reconcile: false,
    }),
    questions,
  };
}
