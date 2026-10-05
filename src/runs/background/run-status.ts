import { formatAsyncRunList, listAsyncRuns } from "./async-status.ts";
import { buildManagementControl, formatRunAction } from "../../shared/status-format.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  type AsyncStatus,
  type NestedRunSummary,
  type SubagentExecutionResult,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { exactAsyncRunLocation, resolveAsyncRunLocation } from "./async-run-location.ts";
import type { AsyncRunLocation } from "./async-run-record.ts";
import type { AsyncRunSummary } from "./async-run-summary.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "./run-id-resolver.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import {
  attachRootChildrenToSteps,
  findNestedRouteForRootId,
  findNestedRun,
} from "../shared/nested-events.ts";
import { readAsyncResultFile } from "./async-result-file.ts";
import { readStatus } from "../../shared/utils.ts";
import {
  ASYNC_COMPLETION_REMINDER,
  hasExistingSessionFile,
  normalizedState,
  type RunStatusParams,
  type RunStatusDeps,
  type RunStatusState,
} from "./run-status-contracts.ts";
import {
  canExtend,
  formatNestedExactStatus,
  formatResumeGuidance,
  runtimeHeader,
  runtimeSteps,
  runtimeFooter,
} from "./run-status-render.ts";
import { errorMessage, hasText } from "./async-value.ts";

function errorResult(message: string): SubagentExecutionResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { mode: "single", results: [] },
  };
}
function completionTargetsSession(
  run: Readonly<Pick<AsyncStatus, "sessionId" | "cwd">>,
  state: RunStatusState | undefined,
): boolean {
  return (
    state === undefined || (hasText(run.sessionId) && run.sessionId === state.currentSessionId)
  );
}
function nestedCompletionTargetsSession(
  rootRunId: string,
  asyncDirRoot: string,
  state: RunStatusState | undefined,
): boolean {
  if (!state || state.ownedRuns?.has(rootRunId) === true) {
    return true;
  }
  const tracked = state.asyncJobs.get(rootRunId);
  if (tracked) {
    return completionTargetsSession(tracked, state);
  }
  try {
    const location = exactAsyncRunLocation(rootRunId, asyncDirRoot, RESULTS_DIR);
    const status = location.asyncDir === null ? null : readStatus(location.asyncDir);
    return status === null ? false : completionTargetsSession(status, state);
  } catch {
    return false;
  }
}

function listControl(
  run: ReadonlyInput<AsyncRunSummary>,
): ReturnType<typeof buildManagementControl> {
  const running = run.steps.find((step) => step.status === "running");
  const target = running
    ? resolveSubagentIntercomTarget(run.id, running.agent, running.index)
    : undefined;
  const resumable = run.steps.find((step) => hasExistingSessionFile(step.sessionFile));
  return buildManagementControl({
    state: normalizedState(run.state),
    runId: run.id,
    index: running?.index ?? resumable?.index,
    intercomTarget: target,
    canNudge: running !== undefined,
    canResume:
      running !== undefined ||
      resumable !== undefined ||
      (run.steps.length <= 1 && hasExistingSessionFile(run.sessionFile)),
    canInterrupt: run.state === "running",
  });
}
function inspectList(deps: ReadonlyInput<RunStatusDeps>): SubagentExecutionResult {
  if (deps.nested) {
    return errorResult("Child-safe subagent status requires a run id.");
  }
  const runs = listAsyncRuns(deps.asyncDirRoot ?? ASYNC_DIR, {
    resultsDir: deps.resultsDir ?? RESULTS_DIR,
    kill: deps.kill,
    now: deps.now,
  }).filter((run) => completionTargetsSession(run, deps.state));
  const text = formatAsyncRunList(runs, "Async runs");
  const reminder = runs.some((run) => run.state === "running" || run.state === "queued");
  return {
    content: [{ type: "text", text: reminder ? `${text}\n${ASYNC_COMPLETION_REMINDER}` : text }],
    details: { mode: "single", results: [], managementControls: runs.map(listControl) },
  };
}

function inspectNested(
  nested: ReadonlyInput<Extract<ResolvedSubagentRunId, { kind: "nested" }>>,
  deps: ReadonlyInput<RunStatusDeps>,
): SubagentExecutionResult {
  const children = reconcileNestedAsyncDescendants(nested.match.route, {
    resultsDir: deps.resultsDir ?? RESULTS_DIR,
    kill: deps.kill,
    now: deps.now,
  });
  const run = findNestedRun(children, nested.id) ?? nested.match.run;
  const state = normalizedState(run.state);
  const text = formatNestedExactStatus(nested.match.rootRunId, run, deps.nested !== undefined);
  const reminder =
    state === "live" &&
    nestedCompletionTargetsSession(
      nested.match.rootRunId,
      deps.asyncDirRoot ?? ASYNC_DIR,
      deps.state,
    );
  return {
    content: [{ type: "text", text: reminder ? `${text}\n${ASYNC_COMPLETION_REMINDER}` : text }],
    details: {
      mode: "single",
      results: [],
      managementControl: buildManagementControl({
        state,
        runId: run.id,
        intercomTarget: run.intercomTarget ?? run.leafIntercomTarget,
        canNudge: false,
        canResume: state === "live" || hasText(run.sessionFile),
        canInterrupt: state === "live",
      }),
    },
  };
}

function resolveInspection(
  params: RunStatusParams,
  deps: ReadonlyInput<RunStatusDeps>,
): AsyncRunLocation | SubagentExecutionResult {
  const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
  const resultsDir = deps.resultsDir ?? RESULTS_DIR;
  const requestedId = params.id ?? params.runId;
  if (!hasText(params.dir) && hasText(requestedId)) {
    const resolved = resolveSubagentRunId(requestedId, {
      asyncDirRoot,
      resultsDir,
      state: deps.state,
      nested: deps.nested,
    });
    if (resolved?.kind === "nested") {
      return inspectNested(resolved, deps);
    }
    return resolved?.kind === "async"
      ? resolved.location
      : { asyncDir: null, resultPath: null, resolvedId: requestedId };
  }
  return resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
}

function nestedProjection(
  status: ReadonlyInput<AsyncStatus>,
  deps: ReadonlyInput<RunStatusDeps>,
): { readonly children: NestedRunSummary[]; readonly warning?: string } {
  let children: NestedRunSummary[] = [];
  try {
    const route = findNestedRouteForRootId(status.runId);
    if (route) {
      children = reconcileNestedAsyncDescendants(route, {
        resultsDir: deps.resultsDir ?? RESULTS_DIR,
        kill: deps.kill,
        now: deps.now,
      });
    }
    // Step attachment happens on a fresh display projection, never persisted status.
    return { children };
  } catch (error) {
    return { children, warning: `Nested status unavailable: ${errorMessage(error)}` };
  }
}

function runtimeControl(
  status: ReadonlyInput<AsyncStatus>,
): ReturnType<typeof buildManagementControl> {
  const state = normalizedState(status.state);
  const steps = (status.steps ?? []).map((step, index) => ({ step, index }));
  const running = steps.find(({ step }) => step.status === "running");
  const target = running
    ? resolveSubagentIntercomTarget(status.runId, running.step.agent, running.index)
    : undefined;
  const resumable = steps.find(({ step }) => hasExistingSessionFile(step.sessionFile));
  const persisted =
    resumable !== undefined || (steps.length <= 1 && hasExistingSessionFile(status.sessionFile));
  return buildManagementControl({
    state,
    runId: status.runId,
    index: running?.index ?? resumable?.index,
    intercomTarget: target,
    canNudge: running !== undefined,
    canResume: state === "live" ? running !== undefined : persisted,
    canInterrupt: status.state === "running",
    canExtend: canExtend(status),
  });
}

function inspectRuntime(
  asyncDir: string,
  deps: ReadonlyInput<RunStatusDeps>,
): SubagentExecutionResult | undefined {
  const reconciliation = reconcileAsyncRun(asyncDir, {
    resultsDir: deps.resultsDir ?? RESULTS_DIR,
    kill: deps.kill,
    now: deps.now,
  });
  const status = reconciliation.status;
  if (!status) {
    return undefined;
  }
  const nested = nestedProjection(status, deps);
  const projected = { ...status, steps: status.steps?.map((step) => ({ ...step })) };
  attachRootChildrenToSteps(status.runId, projected.steps, nested.children);
  const steps = runtimeSteps(projected, asyncDir, deps);
  const lines = [
    ...runtimeHeader(projected, asyncDir, deps, reconciliation),
    ...steps.lines,
    ...runtimeFooter(projected, asyncDir, deps, nested),
  ];
  if (
    (status.state === "running" || status.state === "queued") &&
    completionTargetsSession(status, deps.state)
  ) {
    lines.push(ASYNC_COMPLETION_REMINDER);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      mode: "single",
      results: [],
      intercomTargets: steps.intercomTargets,
      managementControl: runtimeControl(status),
    },
  };
}

function savedResultLines(
  data: ReadonlyInput<ReturnType<typeof readAsyncResultFile>>,
  resultPath: string,
  runId: string | undefined,
  options: {
    readonly includeRunHeader?: boolean;
    readonly childSafe: boolean;
    readonly full?: boolean;
  },
): string[] {
  const lines = [
    ...(options.includeRunHeader !== false
      ? [`Run: ${runId ?? "unknown"}`, `State: ${data.terminalState}`]
      : []),
    `${options.includeRunHeader === false ? "Runtime result" : "Result"}: ${resultPath}`,
    `Status: ${formatRunAction("status", runId ?? "unknown", {}, options.childSafe)}`,
  ];
  const children =
    data.results ??
    (hasText(data.agent) ? [{ agent: data.agent, sessionFile: data.sessionFile }] : []);
  lines.push(formatResumeGuidance(runId, children, data.sessionFile, options.childSafe));
  if (hasText(data.summary)) {
    const summary =
      options.full === true || data.summary.length <= 600
        ? data.summary
        : `${data.summary.slice(0, 599)}…`;
    lines.push("", summary);
  }
  return lines;
}

function inspectResult(
  resultPath: string,
  resolvedId: string | undefined,
  params: RunStatusParams,
  deps: ReadonlyInput<RunStatusDeps>,
): SubagentExecutionResult {
  const data = readAsyncResultFile(resultPath);
  const runId = data.runId ?? data.id ?? resolvedId;
  const lines = savedResultLines(data, resultPath, runId, {
    includeRunHeader: deps.includeRunHeader,
    childSafe: deps.nested !== undefined,
    full: params.full,
  });
  const children =
    data.results ??
    (hasText(data.agent) ? [{ agent: data.agent, sessionFile: data.sessionFile }] : []);
  const state = normalizedState(data.terminalState);
  const resumable = children
    .map((child, index) => ({ child, index }))
    .find(({ child }) => hasExistingSessionFile(child.sessionFile));
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      mode: "single",
      results: [],
      managementControl: buildManagementControl({
        state,
        runId: runId ?? "unknown",
        index: resumable?.index,
        canResume: state !== "live" && resumable !== undefined,
      }),
    },
  };
}

function inspectLocation(
  location: AsyncRunLocation,
  params: RunStatusParams,
  deps: ReadonlyInput<RunStatusDeps>,
): SubagentExecutionResult {
  if (location.asyncDir === null && location.resultPath === null) {
    return errorResult("Async run not found. Provide id or dir.");
  }
  if (location.asyncDir !== null) {
    const runtime = inspectRuntime(location.asyncDir, deps);
    if (runtime) {
      return runtime;
    }
  }
  if (location.resultPath !== null) {
    try {
      return inspectResult(location.resultPath, location.resolvedId, params, deps);
    } catch (error) {
      return errorResult(`Failed to read async result file: ${errorMessage(error)}`);
    }
  }
  return errorResult("Status file not found.");
}

export function inspectSubagentStatus(
  params: RunStatusParams,
  deps: ReadonlyInput<RunStatusDeps> = {},
): SubagentExecutionResult {
  try {
    if (!hasText(params.id) && !hasText(params.runId) && !hasText(params.dir)) {
      return inspectList(deps);
    }
    const location = resolveInspection(params, deps);
    if ("content" in location) {
      return location;
    }
    return inspectLocation(location, params, deps);
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}
