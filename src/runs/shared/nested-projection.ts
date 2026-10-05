import * as path from "node:path";
import {
  RESULTS_DIR,
  type AsyncJobState,
  type ReadonlyAsyncStatus,
  type NestedStepSummary,
  type NestedRunSummary,
  type SubagentRunMode,
} from "../../shared/types.ts";
import { assertSafeNestedId as assertSafeId, MAX_CHILDREN, MAX_STEPS } from "./nested-protocol.ts";
import { projectNestedEvents, terminal } from "./nested-registry.ts";
import type { NestedPathEntry } from "./nested-path.ts";
import { acceptanceHumanAction } from "./acceptance-evaluation.ts";

/** Caller-owned projection slots; attachment replaces only their children. */
export interface MutableStepProjection {
  children?: readonly NestedRunSummary[];
  readonly index?: number;
}

export function attachRootChildrenToSteps(
  rootRunId: string,
  steps: readonly MutableStepProjection[] | undefined,
  children: readonly NestedRunSummary[] | undefined,
): void {
  if (steps === undefined || steps.length === 0) {
    return;
  }
  for (const step of steps) {
    step.children = undefined;
  }
  for (const child of children ?? []) {
    if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined) {
      continue;
    }
    const step = steps.find(
      (candidate, index) => (candidate.index ?? index) === child.parentStepIndex,
    );
    if (!step) {
      continue;
    }
    step.children = [
      ...(step.children ?? []).filter((existing) => existing.id !== child.id),
      child,
    ].slice(0, MAX_CHILDREN);
  }
}

export function updateAsyncJobNestedProjection(job: AsyncJobState): void {
  if (!job.nestedRoute) {
    return;
  }
  const registry = projectNestedEvents(job.nestedRoute);
  job.nestedChildren = registry.children;
  attachRootChildrenToSteps(job.asyncId, job.steps, registry.children);
}

export function hasLiveNestedDescendants(
  children: readonly NestedRunSummary[] | undefined,
): boolean {
  if (children === undefined || children.length === 0) {
    return false;
  }
  for (const child of children) {
    if (!terminal(child.state)) {
      return true;
    }
    if (hasLiveNestedDescendants(child.children)) {
      return true;
    }
    if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? []))) {
      return true;
    }
  }
  return false;
}

type NestedStatusObservation = Pick<ReadonlyAsyncStatus, "runId" | "state"> &
  Partial<ReadonlyAsyncStatus>;
interface NestedStatusIdentity {
  readonly id: string;
  readonly parentRunId: string;
  readonly parentStepIndex?: number;
  readonly depth: number;
  readonly path?: readonly NestedPathEntry[];
  readonly mode?: SubagentRunMode;
  readonly ts: number;
}
function parentPath(identity: NestedStatusIdentity): readonly NestedPathEntry[] {
  return (
    identity.path ?? [
      {
        runId: identity.parentRunId,
        ...(identity.parentStepIndex !== undefined ? { stepIndex: identity.parentStepIndex } : {}),
      },
    ]
  );
}
function summaryIdentity(
  status: NestedStatusObservation,
  asyncDir: string,
  identity: NestedStatusIdentity,
) {
  return {
    id: status.runId === "" ? identity.id : status.runId,
    indexedControl: status.indexedControl,
    parentRunId: identity.parentRunId,
    ...(identity.parentStepIndex !== undefined
      ? { parentStepIndex: identity.parentStepIndex }
      : {}),
    depth: identity.depth,
    path: parentPath(identity),
    asyncDir,
    ...(status.pid !== undefined && status.pid !== 0 ? { pid: status.pid } : {}),
    ...(status.sessionId !== undefined && status.sessionId !== ""
      ? { sessionId: status.sessionId }
      : {}),
    mode: status.mode ?? identity.mode,
  };
}
function summaryActivity(
  status: Pick<
    ReadonlyAsyncStatus,
    "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath"
  >,
): Pick<
  NestedRunSummary,
  "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath"
> {
  return {
    ...(status.activityState !== undefined ? { activityState: status.activityState } : {}),
    ...(status.lastActivityAt !== undefined ? { lastActivityAt: status.lastActivityAt } : {}),
    ...(status.currentTool !== undefined && status.currentTool !== ""
      ? { currentTool: status.currentTool }
      : {}),
    ...(status.currentToolStartedAt !== undefined
      ? { currentToolStartedAt: status.currentToolStartedAt }
      : {}),
    ...(status.currentPath !== undefined && status.currentPath !== ""
      ? { currentPath: status.currentPath }
      : {}),
  };
}
function summaryCounters(
  status: NestedStatusObservation,
): Pick<
  NestedRunSummary,
  "currentStep" | "chainStepCount" | "turnCount" | "toolCount" | "totalTokens"
> {
  return {
    ...(status.currentStep !== undefined ? { currentStep: status.currentStep } : {}),
    ...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
    ...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
    ...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
    ...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
  };
}
function summaryTiming(
  status: NestedStatusObservation,
  identity: NestedStatusIdentity,
): Pick<
  NestedRunSummary,
  | "currentStep"
  | "chainStepCount"
  | "turnCount"
  | "toolCount"
  | "totalTokens"
  | "startedAt"
  | "endedAt"
  | "lastUpdate"
  | "sessionFile"
> {
  return {
    ...summaryCounters(status),
    startedAt: status.startedAt ?? identity.ts,
    ...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
    lastUpdate: status.lastUpdate ?? identity.ts,
    ...(status.sessionFile !== undefined && status.sessionFile !== ""
      ? { sessionFile: status.sessionFile }
      : {}),
  };
}
function summaryStep(step: NonNullable<ReadonlyAsyncStatus["steps"]>[number]): NestedStepSummary {
  return {
    agent: step.agent,
    status: step.status,
    ...(step.sessionFile !== undefined && step.sessionFile !== ""
      ? { sessionFile: step.sessionFile }
      : {}),
    ...summaryActivity(step),
    ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
    ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
    error: step.error ?? acceptanceHumanAction(step.acceptance),
  };
}
function summaryError(status: NestedStatusObservation): string | undefined {
  if (status.error !== undefined) {
    return status.error;
  }
  if (status.state !== "blocked") {
    return;
  }
  return status.steps
    ?.map((step) => acceptanceHumanAction(step.acceptance))
    .filter(Boolean)
    .join("\n");
}
export function nestedSummaryFromAsyncStatus(
  status: NestedStatusObservation,
  asyncDir: string,
  identity: NestedStatusIdentity,
): NestedRunSummary {
  const steps = status.steps;
  return {
    ...summaryIdentity(status, asyncDir, identity),
    state: status.state,
    error: summaryError(status),
    ...summaryActivity(status),
    ...summaryTiming(status, identity),
    ...(steps && steps.length > 0 ? { steps: steps.map(summaryStep).slice(0, MAX_STEPS) } : {}),
  };
}

export function nestedResultsPath(rootRunId: string, id: string): string {
  assertSafeId("rootRunId", rootRunId);
  assertSafeId("id", id);
  return path.join(RESULTS_DIR, "nested", rootRunId, `${id}.json`);
}
