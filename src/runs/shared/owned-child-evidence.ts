import * as fs from "node:fs";
import { resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { sumAttemptUsage } from "./model-fallback.ts";
import type {
  AsyncResultChild,
  ReadonlyAsyncStatus,
  ReadonlyForegroundResumeRun,
  ReadonlyInput,
  ManagementRunState,
  OwnedRun,
  OwnedRunView,
  SupervisorRunContract,
} from "../../shared/types.ts";

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
export function normalizedState(value: string | undefined): ManagementRunState {
  return value === undefined ? "unknown" : (RUN_STATES[value] ?? "unknown");
}
type ForegroundChild = ReadonlyForegroundResumeRun["children"][number];
type StatusStep = NonNullable<ReadonlyAsyncStatus["steps"]>[number];
type DeclaredChild = OwnedRun["children"][number];
export interface ChildEvidence {
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

export function projectOwnedChild(
  run: OwnedRun,
  index: number,
  evidence: ChildEvidence,
  identityUnavailable: boolean,
): OwnedRunView["children"][number] {
  const { contract, declared, sessionFile } = evidence;
  const state = childState(evidence);
  const task = childTask(evidence, run);
  return {
    agent: childAgent(evidence),
    index,
    workflowNodeId: declared?.workflowNodeId,
    sessionFile,
    task,
    label: childLabel(evidence),
    ...(identityUnavailable ? { identityUnavailable: true } : {}),
    modelSelection: childSelection(evidence),
    activity: childActivity(evidence, state),
    state,
    result: childResult(evidence, task),
    launch: contract?.launch,
    configuration: contract?.launch ? "saved" : "legacy-partial",
    ...(missingSession(sessionFile) ? { missingSession: true } : {}),
  };
}
