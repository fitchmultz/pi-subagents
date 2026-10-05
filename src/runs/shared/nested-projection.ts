import * as path from "node:path";
import {
  RESULTS_DIR,
  type AsyncJobState,
  type AsyncStatus,
  type NestedRunSummary,
  type SubagentRunMode,
} from "../../shared/types.ts";
import { assertSafeNestedId as assertSafeId, MAX_CHILDREN, MAX_STEPS } from "./nested-protocol.ts";
import { projectNestedEvents, terminal } from "./nested-registry.ts";
import { acceptanceHumanAction } from "./acceptance-evaluation.ts";

/** Caller-owned projection slots; attachment replaces only their children. */
export interface MutableStepProjection {
  children?: NestedRunSummary[];
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
  if (children === undefined || children.length === 0) {
    return;
  }
  for (const child of children) {
    if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined) {
      continue;
    }
    const step = steps.find(
      (candidate, index) => (candidate.index ?? index) === child.parentStepIndex,
    );
    if (!step) {
      continue;
    }
    step.children ??= [];
    step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(
      0,
      MAX_CHILDREN,
    );
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

export function hasLiveNestedDescendants(children: NestedRunSummary[] | undefined): boolean {
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

export function nestedSummaryFromAsyncStatus(
  status: AsyncStatus,
  asyncDir: string,
  fallback: {
    id: string;
    parentRunId: string;
    parentStepIndex?: number;
    depth: number;
    path?: Array<{ runId: string; stepIndex?: number; agent?: string }>;
    mode?: SubagentRunMode;
    ts: number;
  },
): NestedRunSummary {
  return {
    id: status.runId === "" ? fallback.id : status.runId,
    indexedControl: status.indexedControl,
    parentRunId: fallback.parentRunId,
    ...(fallback.parentStepIndex !== undefined
      ? { parentStepIndex: fallback.parentStepIndex }
      : {}),
    depth: fallback.depth,
    path: fallback.path ?? [
      {
        runId: fallback.parentRunId,
        ...(fallback.parentStepIndex !== undefined ? { stepIndex: fallback.parentStepIndex } : {}),
      },
    ],
    asyncDir,
    ...(status.pid !== undefined && status.pid !== 0 ? { pid: status.pid } : {}),
    ...(status.sessionId !== undefined && status.sessionId !== ""
      ? { sessionId: status.sessionId }
      : {}),
    mode: status.mode ?? fallback.mode,
    state: status.state,
    error:
      status.error ??
      (status.state === "blocked"
        ? status.steps
            ?.map((step) => acceptanceHumanAction(step.acceptance))
            .filter(Boolean)
            .join("\n")
        : undefined),
    ...(status.currentStep !== undefined ? { currentStep: status.currentStep } : {}),
    ...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
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
    ...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
    ...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
    ...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
    ...(status.startedAt !== undefined
      ? { startedAt: status.startedAt }
      : { startedAt: fallback.ts }),
    ...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
    lastUpdate: status.lastUpdate ?? fallback.ts,
    ...(status.sessionFile !== undefined && status.sessionFile !== ""
      ? { sessionFile: status.sessionFile }
      : {}),
    ...((status.steps?.length ?? 0) > 0
      ? {
          steps: status.steps
            .map((step) => ({
              agent: step.agent,
              status: step.status,
              ...(step.sessionFile !== undefined && step.sessionFile !== ""
                ? { sessionFile: step.sessionFile }
                : {}),
              ...(step.activityState !== undefined ? { activityState: step.activityState } : {}),
              ...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
              ...(step.currentTool !== undefined && step.currentTool !== ""
                ? { currentTool: step.currentTool }
                : {}),
              ...(step.currentToolStartedAt !== undefined
                ? { currentToolStartedAt: step.currentToolStartedAt }
                : {}),
              ...(step.currentPath !== undefined && step.currentPath !== ""
                ? { currentPath: step.currentPath }
                : {}),
              ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
              ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
              ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
              ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
              error: step.error ?? acceptanceHumanAction(step.acceptance),
            }))
            .slice(0, MAX_STEPS),
        }
      : {}),
  };
}

export function nestedResultsPath(rootRunId: string, id: string): string {
  assertSafeId("rootRunId", rootRunId);
  assertSafeId("id", id);
  return path.join(RESULTS_DIR, "nested", rootRunId, `${id}.json`);
}
