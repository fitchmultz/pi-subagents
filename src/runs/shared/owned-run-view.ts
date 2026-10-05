import * as fs from "node:fs";
import * as path from "node:path";
import { readStatus } from "../../shared/utils.ts";
import { resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { isDurableRun, readAsyncResultFile } from "../background/async-result-file.ts";
import { parseAsyncStatus, parseForegroundResumeRun } from "../background/run-schemas.ts";
import { exactAsyncRunLocation } from "../background/async-resume.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { sumAttemptUsage } from "./model-fallback.ts";
import { workflowAgentNodes } from "./workflow-graph.ts";
import {
  getRunMetadataDir,
  listOwnedRunQuestions,
  questionProcessAlive,
  readQuestionContract,
  readRunJson,
  type SupervisorRunContract,
} from "./supervisor-questions.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  type AsyncResultChild,
  type ReadonlyAsyncStatus,
  type ReadonlyForegroundResumeRun,
  type ReadonlyInput,
  type ManagementRunState,
  type OwnedRun,
  type OwnedRunView,
  type WorkflowGraphNode,
} from "../../shared/types.ts";
import { isRecord } from "../../shared/unknown.ts";
import { workflowChildren } from "./run-persistence.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";

export interface OwnedRunViewOptions {
  readonly pendingInput?: boolean;
  readonly includeContinuations?: boolean;
  readonly readConfiguration?: false;
  readonly reconcile?: boolean;
}

export function savedWorkflowNodes(
  status: ReadonlyAsyncStatus | null | undefined,
): readonly WorkflowGraphNode[] | undefined {
  if (!status?.workflowGraph || status.workflowGraph.runId !== status.runId) {
    return;
  }
  const nodes = workflowAgentNodes(status.workflowGraph);
  if (
    nodes.length !== status.steps?.length ||
    new Set(nodes.map((node) => node.id)).size !== nodes.length
  ) {
    return;
  }
  if (
    nodes.some(
      (node, index) =>
        node.id === "" ||
        ((node.agent ?? "") !== "" && node.agent !== status.steps?.[index]?.agent),
    )
  ) {
    return;
  }
  return nodes;
}

const RUN_STATES: Readonly<Record<string, ManagementRunState | undefined>> = {
  running: "live",
  queued: "live",
  complete: "completed",
  completed: "completed",
  failed: "failed",
  "timed-out": "failed",
  blocked: "blocked",
  paused: "paused",
};
function normalizedState(value: string | undefined): ManagementRunState {
  return value === undefined ? "unknown" : (RUN_STATES[value] ?? "unknown");
}
function processAlive(pid: number | undefined): boolean {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && questionProcessAlive({ pid });
}

type ResultSnapshot = ReadonlyInput<ReturnType<typeof readAsyncResultFile>>;
type ForegroundChild = ReadonlyForegroundResumeRun["children"][number];
type StatusStep = NonNullable<ReadonlyAsyncStatus["steps"]>[number];
type DeclaredChild = OwnedRun["children"][number];
interface ChildEvidence {
  readonly bg?: ReadonlyInput<AsyncResultChild>;
  readonly fg?: ForegroundChild;
  readonly step?: StatusStep;
  readonly contract?: SupervisorRunContract;
  readonly declared?: DeclaredChild;
  readonly sessionFile?: string;
  readonly boundSession?: string;
  readonly live: boolean;
  readonly pending: boolean;
  readonly terminalState?: string;
}

function asyncChildState(
  bg: ReadonlyInput<AsyncResultChild>,
  terminalState: string | undefined,
): ManagementRunState {
  const unresolved =
    typeof bg.success !== "boolean" && (bg.exitCode === null || bg.exitCode === undefined);
  return normalizedState(
    resolveSubagentResultStatus({
      success: bg.success,
      exitCode: bg.exitCode ?? undefined,
      interrupted: bg.interrupted,
      acceptance: bg.acceptance,
      state: unresolved ? terminalState : undefined,
    }),
  );
}

function asyncChildResult(
  child: ReadonlyInput<AsyncResultChild>,
  task: string | undefined,
): OwnedRunView["children"][number]["result"] {
  const { output, ...result } = child;
  return {
    ...result,
    agent: child.agent ?? "unknown",
    task: child.task ?? task ?? "Original child assignment unavailable",
    exitCode: child.exitCode ?? (child.success === true ? 0 : 1),
    finalOutput: child.finalOutput ?? output,
    usage: child.usage ?? sumAttemptUsage(child.modelAttempts ?? []),
  };
}

function childState(evidence: ChildEvidence): ManagementRunState {
  const { bg, fg, contract, step } = evidence;
  if (bg) {
    return asyncChildState(bg, evidence.terminalState);
  }
  if (fg && fg.status !== "detached") {
    return normalizedState(fg.status);
  }
  if (contract?.result) {
    return normalizedState(resolveSubagentResultStatus(contract.result));
  }
  if (evidence.live || evidence.pending) {
    return "live";
  }
  return step && !["running", "pending"].includes(step.status)
    ? normalizedState(step.status)
    : "unknown";
}

function childResult(
  evidence: ChildEvidence,
  task: string | undefined,
): OwnedRunView["children"][number]["result"] {
  if (evidence.fg?.status !== "detached" && evidence.fg?.result) {
    return evidence.fg.result;
  }
  const child = evidence.bg;
  if (!child) {
    return evidence.contract?.result ?? evidence.fg?.result;
  }
  return asyncChildResult(child, task);
}

function readSavedStatus(
  run: OwnedRun,
  root: string,
): { readonly savedStatus: ReadonlyAsyncStatus | null | undefined; readonly asyncDir?: string } {
  const location = exactAsyncRunLocation(run.runId, ASYNC_DIR, RESULTS_DIR);
  const asyncDir = location.asyncDir ?? run.asyncDir;
  const liveStatus = asyncDir !== undefined && asyncDir !== "" ? readStatus(asyncDir) : null;
  return {
    savedStatus: liveStatus ?? readRunJson(path.join(root, "status.json"), parseAsyncStatus),
    asyncDir,
  };
}

function observedStatus(run: OwnedRun, root: string, options: OwnedRunViewOptions) {
  const { savedStatus, asyncDir } = readSavedStatus(run, root);
  const launch = readRunJson(path.join(root, "launch.json"));
  const durable = isDurableRun(savedStatus) || (isRecord(launch) && isDurableRun(launch));
  const reconciliation =
    durable && options.reconcile !== false ? reconcileAsyncRun(asyncDir ?? root) : undefined;
  return { savedStatus, durable, reconciliation, status: reconciliation?.status ?? savedStatus };
}

function observedIndices(
  foreground: ReadonlyForegroundResumeRun | undefined,
  result: ResultSnapshot | undefined,
  status: ReadonlyAsyncStatus | null | undefined,
  declarationIndices: readonly number[],
): readonly number[] {
  const terminal =
    result?.results?.map((_, index) => index) ?? foreground?.children.map((child) => child.index);
  const indices = terminal ?? [
    ...declarationIndices,
    ...(status?.steps?.map((_, index) => index) ?? []),
  ];
  return [...new Set(indices)].sort((a, b) => a - b);
}

function uncertainIndices(
  run: OwnedRun,
  status: ReadonlyAsyncStatus | null | undefined,
  nodes: readonly WorkflowGraphNode[] | undefined,
): boolean {
  if (run.mode !== "chain") {
    return false;
  }
  if (!run.children.some((child) => (child.workflowNodeId ?? "") !== "")) {
    return true;
  }
  return run.source === "async" && status !== undefined && status !== null && nodes === undefined;
}

function childLiveness(input: {
  readonly contract?: SupervisorRunContract;
  readonly step?: StatusStep;
  readonly fg?: ForegroundChild;
  readonly bg?: ReadonlyInput<AsyncResultChild>;
  readonly parentLive: boolean;
}): { readonly live: boolean; readonly pending: boolean } {
  const { contract, step, parentLive } = input;
  const live =
    processAlive(contract?.pid) ||
    ((!step || step.status === "running" || step.status === "pending") && parentLive);
  return { live, pending: childPending(input) };
}

function childPending(input: {
  readonly contract?: SupervisorRunContract;
  readonly step?: StatusStep;
  readonly fg?: ForegroundChild;
  readonly bg?: ReadonlyInput<AsyncResultChild>;
  readonly parentLive: boolean;
}): boolean {
  const { contract, step, fg, bg, parentLive } = input;
  return (
    !fg &&
    !bg &&
    (contract?.pid ?? 0) === 0 &&
    !contract?.result &&
    (!step || step.status === "pending") &&
    parentLive
  );
}

function childLabel(evidence: ChildEvidence): string | undefined {
  return [evidence.contract?.label, evidence.step?.label, evidence.declared?.label].find(
    (label) => label !== undefined,
  );
}
function childAgent(evidence: ChildEvidence): string {
  return (
    [
      evidence.fg?.agent,
      evidence.bg?.agent,
      evidence.step?.agent,
      evidence.contract?.launch?.agent.name,
      evidence.declared?.agent,
    ].find((agent) => agent !== undefined) ?? "unknown"
  );
}
function childTask(evidence: ChildEvidence, run: OwnedRun): string | undefined {
  return [
    evidence.contract?.task,
    evidence.declared?.task,
    evidence.fg?.result?.task,
    run.children.length === 1 ? run.task : undefined,
  ].find((task) => task !== undefined);
}
function childSelection(
  evidence: ChildEvidence,
): OwnedRunView["children"][number]["modelSelection"] {
  const selection =
    evidence.contract?.modelSelection ?? evidence.step ?? evidence.fg?.result?.progress;
  return selection
    ? {
        model: selection.model,
        thinking: selection.thinking,
        modelStartedAt: selection.modelStartedAt,
      }
    : undefined;
}
function childActivity(
  evidence: ChildEvidence,
  state: ManagementRunState,
): OwnedRunView["children"][number]["activity"] {
  if (state !== "live") {
    return;
  }
  return evidence.pending ? { ...evidence.step, status: "pending" } : evidence.step;
}
function missingSession(session: string | undefined): boolean {
  return session !== undefined && session !== "" && !fs.existsSync(session);
}

/** One bounded authoritative read owns receipt precedence and child identity reconciliation. */
class RunObservation {
  readonly root: string;
  readonly resultPath: string;
  readonly foreground: ReadonlyForegroundResumeRun | undefined;
  readonly result: ResultSnapshot | undefined;
  readonly savedStatus: ReadonlyAsyncStatus | null | undefined;
  readonly status: ReadonlyAsyncStatus | null | undefined;
  readonly durable: boolean;
  readonly reconciliation: ReturnType<typeof reconcileAsyncRun> | undefined;
  private readonly contracts = new Map<number, SupervisorRunContract>();
  private readonly nodes: readonly WorkflowGraphNode[] | undefined;
  private readonly declarations: OwnedRun["children"];
  private readonly sessions = new Map<number, string | undefined>();
  private readonly sessionUses = new Map<string, number>();
  private readonly uncertainIndices: boolean;
  readonly indices: readonly number[];

  readonly run: OwnedRun;
  constructor(run: OwnedRun, state: OwnedRunReadState, options: OwnedRunViewOptions) {
    this.run = run;
    this.root = getRunMetadataDir(run.runId);
    this.resultPath = path.join(this.root, "result.json");
    this.foreground =
      readRunJson(path.join(this.root, "foreground.json"), parseForegroundResumeRun) ??
      state.foregroundRuns?.get(run.runId);
    this.result = fs.existsSync(this.resultPath) ? readAsyncResultFile(this.resultPath) : undefined;
    const status = observedStatus(run, this.root, options);
    this.savedStatus = status.savedStatus;
    this.durable = status.durable;
    this.reconciliation = status.reconciliation;
    this.status = status.status;
    this.readContracts(options);
    this.nodes = savedWorkflowNodes(this.status);
    this.declarations = workflowChildren(
      run.children,
      this.nodes ? this.status?.workflowGraph : undefined,
    );
    this.indices = observedIndices(this.foreground, this.result, this.status, [
      ...this.declarations.map((child) => child.index),
      ...this.contracts.keys(),
    ]);
    this.readSessionBindings();
    this.uncertainIndices = uncertainIndices(run, this.status, this.nodes);
  }

  private readContracts(options: OwnedRunViewOptions): void {
    const directory = path.join(this.root, "contracts");
    for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      if (!/^\d+\.json$/.test(name)) {
        continue;
      }
      const index = Number(name.slice(0, -5));
      const contract = readQuestionContract(this.run.runId, index, undefined, {
        endedAt: this.contractEnd(index),
        readConfiguration: options.readConfiguration,
      });
      if (contract) {
        this.contracts.set(index, contract);
      }
    }
  }

  private contractEnd(index: number): number | undefined {
    return (
      this.status?.steps?.[index]?.endedAt ?? this.result?.timestamp ?? this.foreground?.updatedAt
    );
  }

  private boundSession(index: number): string | undefined {
    return [
      this.foreground?.children.find((child) => child.index === index)?.sessionFile,
      this.result?.results?.[index]?.sessionFile,
      this.status?.steps?.[index]?.sessionFile,
      this.contracts.get(index)?.sessionFile,
    ].find((file) => file !== undefined);
  }

  private readSessionBindings(): void {
    for (const index of this.indices) {
      const file = this.boundSession(index);
      this.sessions.set(index, file);
      if (file !== undefined && file !== "") {
        this.sessionUses.set(file, (this.sessionUses.get(file) ?? 0) + 1);
      }
    }
  }

  private declaration(index: number, session: string | undefined): DeclaredChild | undefined {
    if (!this.uncertainIndices || this.nodes) {
      return this.declarations.find((child) => child.index === index);
    }
    if (session === undefined || session === "" || this.sessionUses.get(session) !== 1) {
      return;
    }
    return this.run.children.find((child) => child.sessionFile === session);
  }

  private terminalState(): string | undefined {
    return this.result?.terminalState;
  }
  private evidence(index: number): ChildEvidence {
    const boundSession = this.sessions.get(index);
    const declared = this.declaration(index, boundSession);
    const contract = this.contracts.get(index);
    const fg = this.foreground?.children.find((child) => child.index === index);
    const bg = this.result?.results?.[index];
    const step = this.status?.steps?.[index];
    const parentLive = processAlive(this.status?.pid ?? this.run.pid);
    const { live, pending } = childLiveness({ contract, step, fg, bg, parentLive });
    return {
      boundSession,
      declared,
      contract,
      fg,
      bg,
      step,
      sessionFile: boundSession ?? declared?.sessionFile,
      live,
      pending,
      terminalState: this.terminalState(),
    };
  }

  private identityUnavailable(evidence: ChildEvidence): boolean {
    if (this.run.mode !== "chain" || (evidence.declared?.workflowNodeId ?? "") !== "") {
      return false;
    }
    return (
      evidence.boundSession === undefined ||
      evidence.boundSession === "" ||
      this.sessionUses.get(evidence.boundSession) !== 1
    );
  }

  child(index: number): OwnedRunView["children"][number] {
    const evidence = this.evidence(index);
    const { contract, declared, sessionFile } = evidence;
    const state = childState(evidence);
    const task = childTask(evidence, this.run);
    return {
      agent: childAgent(evidence),
      index,
      workflowNodeId: declared?.workflowNodeId,
      sessionFile,
      task,
      label: childLabel(evidence),
      ...(this.identityUnavailable(evidence) ? { identityUnavailable: true } : {}),
      modelSelection: childSelection(evidence),
      activity: childActivity(evidence, state),
      state,
      result: childResult(evidence, task),
      launch: contract?.launch,
      configuration: contract?.launch ? "saved" : "legacy-partial",
      ...(missingSession(sessionFile) ? { missingSession: true } : {}),
    };
  }

  live(children: OwnedRunView["children"]): boolean {
    return (
      children.some((child) => child.state === "live") ||
      (!this.result &&
        (!this.status || this.status.state === "running" || this.status.state === "queued") &&
        processAlive(this.status?.pid ?? this.run.pid))
    );
  }
  error(): string | undefined {
    return (
      this.result?.error ??
      this.foreground?.error ??
      this.run.error ??
      (this.status && !["running", "queued"].includes(this.status.state)
        ? this.status.error
        : undefined)
    );
  }

  executionState(
    children: OwnedRunView["children"],
    live: boolean,
    error: string | undefined,
  ): ManagementRunState {
    if ((error ?? "") !== "") {
      return "failed";
    }
    if (this.result) {
      return normalizedState(this.result.terminalState);
    }
    if (this.durable && !live) {
      return "unknown";
    }
    if (live) {
      return "live";
    }
    return this.childExecutionState(children);
  }
  private childExecutionState(children: OwnedRunView["children"]): ManagementRunState {
    for (const state of ["failed", "blocked", "paused"] satisfies readonly ManagementRunState[]) {
      if (children.some((child) => child.state === state)) {
        return state;
      }
    }
    if (children.length > 0 && children.every((child) => child.state === "completed")) {
      return (this.foreground?.pausedReason ?? "") !== "" ? "paused" : "completed";
    }
    return this.status && !["running", "queued"].includes(this.status.state)
      ? normalizedState(this.status.state)
      : "unknown";
  }
  private unknownDiagnosis(): string {
    return (
      this.run.recoveryError ??
      this.reconciliation?.message ??
      "Completion is unconfirmed. Saved sessions are context, not proof of successful execution."
    );
  }
  canInterrupt(live: boolean, pending: boolean): boolean {
    return (
      pending ||
      (live && this.savedStatus?.state === "running" && this.savedStatus.runId === this.run.runId)
    );
  }
  updatedAt(): number {
    return (
      this.result?.timestamp ??
      this.status?.lastUpdate ??
      this.foreground?.updatedAt ??
      this.run.startedAt
    );
  }
  diagnosis(state: ManagementRunState, error: string | undefined): string | undefined {
    if ((error ?? "") !== "") {
      return error;
    }
    if (state === "paused" && (this.foreground?.pausedReason ?? "") !== "") {
      return this.foreground?.pausedReason;
    }
    if (state === "unknown") {
      return this.unknownDiagnosis();
    }
    return;
  }
}

function runAttention(run: OwnedRun, state: ManagementRunState, pendingInput: boolean): string[] {
  return [
    ...(pendingInput ? ["awaiting_input"] : []),
    ...(run.review?.decision === "needs_changes" ? ["needs_changes"] : []),
    ...(run.review?.decision !== "accepted" &&
    ["failed", "blocked", "paused", "unknown"].includes(state)
      ? [state]
      : []),
    ...(state === "completed" && !run.review ? ["unreviewed"] : []),
  ];
}

function continuations(run: OwnedRun, state: OwnedRunReadState): OwnedRunView["continuations"] {
  return [...(state.ownedRuns?.values() ?? [])]
    .filter((candidate) => candidate.rootRunId === run.rootRunId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .flatMap((candidate) =>
      candidate.predecessorRunId !== undefined && candidate.predecessorRunId !== ""
        ? [
            {
              runId: candidate.runId,
              predecessorRunId: candidate.predecessorRunId,
              predecessorIndex: candidate.predecessorIndex,
            },
          ]
        : [],
    );
}

export function ownedRunView(
  requestedRun: OwnedRun,
  state: OwnedRunReadState,
  options: OwnedRunViewOptions = {},
): OwnedRunView {
  const run = state.ownedRuns?.get(requestedRun.runId) ?? requestedRun;
  const observed = new RunObservation(run, state, options);
  const children = observed.indices.map((index) => observed.child(index));
  const live = observed.live(children);
  const error = observed.error();
  const executionState = observed.executionState(children, live, error);
  const pendingInput =
    options.pendingInput ??
    listOwnedRunQuestions(run.ownerSessionId, run.runId).some(
      (question) => question.state === "awaiting_input" || question.state === "answer_pending",
    );
  const resultPath = observed.result ? observed.resultPath : undefined;
  return {
    ...run,
    state: executionState,
    children,
    attention: runAttention(run, executionState, pendingInput),
    canInterrupt: observed.canInterrupt(live, pendingInput),
    updatedAt: observed.updatedAt(),
    continuations: options.includeContinuations === false ? [] : continuations(run, state),
    ...(resultPath !== undefined ? { resultPath } : {}),
    ...(!observed.result && observed.foreground
      ? { resultPath: path.join(observed.root, "foreground.json") }
      : {}),
    diagnosis: observed.diagnosis(executionState, error),
  };
}
