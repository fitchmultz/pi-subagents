import * as fs from "node:fs";
import * as path from "node:path";
import { readStatus } from "../../shared/utils.ts";
import { isDurableRun, readAsyncResultFile } from "../background/async-result-file.ts";
import { parseAsyncStatus, parseForegroundResumeRun } from "../background/run-schemas.ts";
import { exactAsyncRunLocation } from "../background/async-resume.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { savedWorkflowNodes, workflowChildren } from "./workflow-graph.ts";
import { normalizedState, projectOwnedChild, type ChildEvidence } from "./owned-child-evidence.ts";
import {
  getRunMetadataDir,
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
import type { OwnedRunReadState } from "./owned-run-read-state.ts";

export interface OwnedRunViewOptions {
  readonly pendingInput?: boolean;
  readonly includeContinuations?: boolean;
  readonly readConfiguration?: false;
  readonly reconcile?: boolean;
}

function processAlive(pid: number | undefined): boolean {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && questionProcessAlive({ pid });
}

type ResultSnapshot = ReadonlyInput<ReturnType<typeof readAsyncResultFile>>;
type ForegroundChild = ReadonlyForegroundResumeRun["children"][number];
type StatusStep = NonNullable<ReadonlyAsyncStatus["steps"]>[number];
type DeclaredChild = OwnedRun["children"][number];
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

/** One bounded authoritative read owns receipt precedence and child identity reconciliation. */
export class RunObservation {
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

  private parentLive(): boolean {
    return processAlive(this.status?.pid ?? this.run.pid);
  }
  private evidence(index: number): ChildEvidence {
    const boundSession = this.sessions.get(index);
    const declared = this.declaration(index, boundSession);
    const contract = this.contracts.get(index);
    const fg = this.foreground?.children.find((child) => child.index === index);
    const bg = this.result?.results?.[index];
    const step = this.status?.steps?.[index];
    const parentLive = this.parentLive();
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
      terminalState: this.result?.terminalState,
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
    return projectOwnedChild(this.run, index, evidence, this.identityUnavailable(evidence));
  }

  private live(children: OwnedRunView["children"]): boolean {
    return (
      children.some((child) => child.state === "live") ||
      (!this.result &&
        (!this.status || this.status.state === "running" || this.status.state === "queued") &&
        processAlive(this.status?.pid ?? this.run.pid))
    );
  }
  private error(): string | undefined {
    return (
      this.result?.error ??
      this.foreground?.error ??
      this.run.error ??
      (this.status && !["running", "queued"].includes(this.status.state)
        ? this.status.error
        : undefined)
    );
  }

  private executionState(
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
  private canInterrupt(live: boolean, pending: boolean): boolean {
    return (
      pending ||
      (live && this.savedStatus?.state === "running" && this.savedStatus.runId === this.run.runId)
    );
  }
  private updatedAt(): number {
    return (
      this.result?.timestamp ??
      this.status?.lastUpdate ??
      this.foreground?.updatedAt ??
      this.run.startedAt
    );
  }
  summary(
    children: OwnedRunView["children"],
    pendingInput: boolean,
  ): Pick<OwnedRunView, "state" | "canInterrupt" | "updatedAt" | "diagnosis"> {
    const live = this.live(children);
    const error = this.error();
    const state = this.executionState(children, live, error);
    return {
      state,
      canInterrupt: this.canInterrupt(live, pendingInput),
      updatedAt: this.updatedAt(),
      diagnosis: this.diagnosis(state, error),
    };
  }
  private diagnosis(state: ManagementRunState, error: string | undefined): string | undefined {
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
