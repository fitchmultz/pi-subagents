import * as fs from "node:fs";
import * as path from "node:path";
import type { ActivityState, AsyncStatus, NestedRunSummary } from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import {
  attachRootChildrenToSteps,
  projectNestedRegistryForRoot,
  sanitizeSummary,
} from "../shared/nested-events.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { validateStatusForSummary } from "./async-status-validation.ts";
import { errorCode, errorMessage, hasText } from "./async-value.ts";
import type { AsyncRunStepSummary, AsyncRunSummary } from "./async-run-summary.ts";
import { formatAsyncRunOutputPath } from "./async-status-render.ts";
type StatusStep = ReadonlyInput<NonNullable<AsyncStatus["steps"]>[number]>;

function outputFileMtime(outputFile: string | undefined): number | undefined {
  if (!hasText(outputFile)) {
    return undefined;
  }
  try {
    return fs.statSync(outputFile).mtimeMs;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw new Error(`Failed to inspect async output file '${outputFile}': ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function deriveAsyncActivityState(
  asyncDir: string,
  status: ReadonlyInput<AsyncStatus>,
): { readonly activityState?: ActivityState; readonly lastActivityAt?: number } {
  if (status.state !== "running") {
    return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
  }
  const output = formatAsyncRunOutputPath({ asyncDir, outputFile: status.outputFile });
  const step =
    typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
  return {
    activityState: status.activityState,
    lastActivityAt:
      status.lastActivityAt ??
      outputFileMtime(output) ??
      step?.lastActivityAt ??
      step?.startedAt ??
      status.startedAt,
  };
}

function stepIdentity(step: StatusStep): Partial<AsyncRunStepSummary> {
  return {
    ...(hasText(step.sessionFile) ? { sessionFile: step.sessionFile } : {}),
    ...(hasText(step.label) ? { label: step.label } : {}),
    ...(hasText(step.phase) ? { phase: step.phase } : {}),
    ...(hasText(step.outputName) ? { outputName: step.outputName } : {}),
    ...(step.structured === true ? { structured: step.structured } : {}),
  };
}

function stepActivity(step: StatusStep): Partial<AsyncRunStepSummary> {
  return {
    ...(step.activityState !== undefined ? { activityState: step.activityState } : {}),
    ...(step.lastActivityAt !== undefined && step.lastActivityAt !== 0
      ? { lastActivityAt: step.lastActivityAt }
      : {}),
    ...(hasText(step.currentTool) ? { currentTool: step.currentTool } : {}),
    ...(hasText(step.currentToolArgs) ? { currentToolArgs: step.currentToolArgs } : {}),
    ...(step.currentToolStartedAt !== undefined && step.currentToolStartedAt !== 0
      ? { currentToolStartedAt: step.currentToolStartedAt }
      : {}),
    ...(hasText(step.currentPath) ? { currentPath: step.currentPath } : {}),
  };
}

function stepExecution(step: StatusStep): Partial<AsyncRunStepSummary> {
  return {
    recentTools: step.recentTools?.map((tool) => ({ ...tool })),
    recentOutput: step.recentOutput === undefined ? undefined : [...step.recentOutput],
    turnCount: step.turnCount,
    toolCount: step.toolCount,
    durationMs: step.durationMs,
    tokens: step.tokens === undefined ? undefined : { ...step.tokens },
    skills: step.skills === undefined ? undefined : [...step.skills],
    ...(hasText(step.model) ? { model: step.model } : {}),
    ...(hasText(step.thinking) ? { thinking: step.thinking } : {}),
    attemptedModels: step.attemptedModels === undefined ? undefined : [...step.attemptedModels],
    ...(hasText(step.error) ? { error: step.error } : {}),
  };
}

function summarizeStep(step: StatusStep, index: number): AsyncRunStepSummary {
  const children = (step.children ?? [])
    .map(sanitizeSummary)
    .filter((child): child is NestedRunSummary => child !== undefined);
  return {
    index,
    agent: step.agent,
    status: step.status,
    ...stepIdentity(step),
    ...stepActivity(step),
    ...stepExecution(step),
    ...(children.length > 0 ? { children } : {}),
  };
}

function summaryChildren(
  runId: string,
  projected: ReadonlyInput<NestedRunSummary[]> | undefined,
  warnings: readonly string[],
): { readonly children: readonly NestedRunSummary[]; readonly warnings: readonly string[] } {
  if (projected !== undefined) {
    return {
      children: projected
        .map(sanitizeSummary)
        .filter((child): child is NestedRunSummary => child !== undefined),
      warnings,
    };
  }
  if (warnings.length > 0) {
    return { children: [], warnings };
  }
  try {
    return { children: projectNestedRegistryForRoot(runId)?.children ?? [], warnings };
  } catch (error) {
    return {
      children: [],
      warnings: [...warnings, `Nested status unavailable: ${errorMessage(error)}`],
    };
  }
}

function summaryFiles(status: ReadonlyInput<AsyncStatus>): Partial<AsyncRunSummary> {
  return {
    ...(hasText(status.sessionDir) ? { sessionDir: status.sessionDir } : {}),
    ...(hasText(status.outputFile) ? { outputFile: status.outputFile } : {}),
    ...(status.totalTokens ? { totalTokens: { ...status.totalTokens } } : {}),
    ...(hasText(status.sessionFile) ? { sessionFile: status.sessionFile } : {}),
  };
}

export function asyncStatusToSummary(
  asyncDir: string,
  status: ReadonlyInput<AsyncStatus>,
  nestedWarnings: readonly string[] = [],
  projectedChildren?: ReadonlyInput<NestedRunSummary[]>,
): AsyncRunSummary {
  validateStatusForSummary(status, path.join(asyncDir, "status.json"));
  const id = status.runId.length > 0 ? status.runId : path.basename(asyncDir);
  const { children, warnings } = summaryChildren(id, projectedChildren, nestedWarnings);
  const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
  const steps = (status.steps ?? []).map(summarizeStep);
  const parallelGroups = normalizeParallelGroups(
    status.parallelGroups,
    steps.length,
    status.chainStepCount ?? steps.length,
  );
  attachRootChildrenToSteps(id, steps, children);
  return {
    id,
    asyncDir,
    pid: status.pid,
    sessionId: status.sessionId,
    state: status.state,
    activityState,
    lastActivityAt,
    currentTool: status.currentTool,
    currentToolStartedAt: status.currentToolStartedAt,
    currentPath: status.currentPath,
    turnCount: status.turnCount,
    toolCount: status.toolCount,
    mode: status.mode,
    cwd: status.cwd,
    startedAt: status.startedAt,
    lastUpdate: status.lastUpdate,
    endedAt: status.endedAt,
    currentStep: status.currentStep,
    chainStepCount: status.chainStepCount,
    ...(parallelGroups.length > 0 ? { parallelGroups } : {}),
    steps,
    ...(children.length > 0 ? { nestedChildren: children } : {}),
    ...(warnings.length > 0 ? { nestedWarnings: warnings } : {}),
    ...summaryFiles(status),
  };
}
