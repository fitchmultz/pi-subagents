import * as fs from "node:fs";
import * as path from "node:path";
import { readOutputPage } from "../../shared/journal-reader.ts";
import {
  formatActivityFacts,
  formatAsyncRunOutputPath,
  formatAsyncRunProgressLabel,
} from "./async-status-render.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { formatModelThinking } from "../../shared/formatters.ts";
import {
  formatActivityLabel,
  formatLiveIntercomActionLines,
  formatRunAction,
} from "../../shared/status-format.ts";
import type { AsyncStatus, NestedRunSummary } from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import {
  hasExistingSessionFile,
  normalizedState,
  type RunStatusDeps,
} from "./run-status-contracts.ts";
import { errorMessage, hasText } from "./async-value.ts";

type StatusStep = NonNullable<AsyncStatus["steps"]>[number];

export function formatResumeGuidance(
  runId: string | undefined,
  children: readonly { readonly agent?: unknown; readonly sessionFile?: unknown }[],
  fallbackSessionFile?: unknown,
  childSafe = false,
): string {
  const known = children
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => typeof child.agent === "string");
  if (!hasText(runId) || known.length === 0) {
    return "Resume: unavailable; no child session file was persisted.";
  }
  const single = known[0]?.child.sessionFile ?? fallbackSessionFile;
  if (children.length === 1 && known.length === 1 && hasExistingSessionFile(single)) {
    return `Continue: ${formatRunAction("resume", runId, { message: "..." }, childSafe)}`;
  }
  const child = known.find(({ child: candidate }) => hasExistingSessionFile(candidate.sessionFile));
  if (child) {
    return `Continue child: ${formatRunAction("resume", runId, { index: child.index, message: "..." }, childSafe)}`;
  }
  return "Resume: unavailable; no child session file was persisted.";
}

function outputExcerpt(outputPath: string | undefined, maxBytes = 4096, maxLines = 12): string[] {
  if (!hasText(outputPath) || !fs.existsSync(outputPath)) {
    return [];
  }
  try {
    const page = readOutputPage(outputPath, { length: maxBytes });
    const text = page.text.trim();
    if (text.length === 0) {
      return [];
    }
    const all = text.split(/\r?\n/);
    const suffix = page.offset > 0 || all.length > maxLines ? " (tail, truncated)" : "";
    return [`Output excerpt${suffix}:`, ...all.slice(-maxLines).map((line) => `  ${line}`)];
  } catch (error) {
    return [`Output excerpt unavailable: ${errorMessage(error)}`];
  }
}

function stepLabel(status: ReadonlyInput<AsyncStatus>, index: number): string {
  const steps = status.steps ?? [];
  const stepCount = steps.length > 0 ? steps.length : 1;
  if (status.mode === "parallel") {
    return `Agent ${index + 1}/${stepCount}`;
  }
  if (status.mode === "chain") {
    const chainCount = status.chainStepCount ?? stepCount;
    const groups = normalizeParallelGroups(status.parallelGroups, steps.length, chainCount);
    const group = groups.find(
      (candidate) => index >= candidate.start && index < candidate.start + candidate.count,
    );
    if (group) {
      return `Step ${group.stepIndex + 1}/${chainCount} Agent ${index - group.start + 1}/${group.count}`;
    }
    return `Step ${flatToLogicalStepIndex(index, chainCount, groups) + 1}/${chainCount}`;
  }
  return `Step ${index + 1}`;
}

function acceptanceText(step: ReadonlyInput<StatusStep>): string {
  if (!step.acceptance) {
    return "";
  }
  const final = step.acceptance.finalization;
  const suffix = final
    ? `, finalization: ${final.status} after ${final.turns.length}/${final.maxTurns} turns`
    : "";
  return `, acceptance: ${step.acceptance.status}${suffix}`;
}

function stepLine(
  status: ReadonlyInput<AsyncStatus>,
  step: ReadonlyInput<StatusStep>,
  index: number,
): string {
  const activity = step.status === "running" ? formatActivityFacts(step) : undefined;
  const model = formatModelThinking(step.model, step.thinking);
  const display = hasText(step.label) ? `${step.label} (${step.agent})` : step.agent;
  const phase = hasText(step.phase) ? `[${step.phase}] ` : "";
  return `${stepLabel(status, index)}: ${phase}${display} ${step.status}${model.length > 0 ? ` (${model})` : ""}${hasText(activity) ? `, ${activity}` : ""}${acceptanceText(step)}${hasText(step.error) ? `, error: ${step.error}` : ""}`;
}

export function canExtend(status: ReadonlyInput<AsyncStatus>): boolean {
  return (
    status.runtimeVersion === 2 &&
    status.state === "running" &&
    status.timedOut !== true &&
    status.timeoutAt !== undefined &&
    status.timeoutAt !== 0
  );
}

function runtimeTiming(
  status: ReadonlyInput<AsyncStatus>,
  childSafe: boolean,
): (string | undefined)[] {
  return [
    `Started: ${new Date(status.startedAt).toISOString()}`,
    `Updated: ${status.lastUpdate !== undefined && status.lastUpdate !== 0 ? new Date(status.lastUpdate).toISOString() : "n/a"}`,
    status.timeoutAt !== undefined && status.timeoutAt !== 0
      ? `Timeout: ${new Date(status.timeoutAt).toISOString()}`
      : undefined,
    canExtend(status)
      ? `Extend: ${formatRunAction("extend", status.runId, { extendMs: 300000 }, childSafe)}`
      : undefined,
  ];
}

function runtimeResultLine(
  resultPath: string | undefined,
  includeRunHeader: boolean | undefined,
): string | undefined {
  if (!hasText(resultPath) || !fs.existsSync(resultPath)) {
    return undefined;
  }
  return `${includeRunHeader === false ? "Runtime result" : "Result"}: ${resultPath}`;
}

export function runtimeHeader(
  status: ReadonlyInput<AsyncStatus>,
  asyncDir: string,
  deps: ReadonlyInput<RunStatusDeps>,
  diagnosis: { readonly message?: string; readonly resultPath?: string },
): string[] {
  const childSafe = deps.nested !== undefined;
  const progress = formatAsyncRunProgressLabel({
    mode: status.mode,
    state: status.state,
    currentStep: status.currentStep,
    chainStepCount: status.chainStepCount,
    parallelGroups: status.parallelGroups,
    steps: status.steps ?? [],
  });
  const activity = status.state === "running" ? formatActivityFacts(status) : undefined;
  const output = formatAsyncRunOutputPath({ asyncDir, outputFile: status.outputFile });
  const lines = [
    ...(deps.includeRunHeader !== false
      ? [`Run: ${status.runId}`, `State: ${status.state}`, `Mode: ${status.mode}`]
      : []),
    hasText(activity) ? `Activity: ${activity}` : undefined,
    `Progress: ${progress}`,
    ...runtimeTiming(status, childSafe),
    `Dir: ${asyncDir}`,
    `Status: ${formatRunAction("status", status.runId, {}, childSafe)}`,
    hasText(output) ? `Output: ${output}` : undefined,
    hasText(diagnosis.message) ? `Diagnosis: ${diagnosis.message}` : undefined,
    runtimeResultLine(diagnosis.resultPath, deps.includeRunHeader),
  ].filter((line) => line !== undefined);
  if (status.state !== "running") {
    lines.push(...outputExcerpt(output));
  }
  return lines;
}

export function runtimeSteps(
  status: ReadonlyInput<AsyncStatus>,
  asyncDir: string,
  deps: ReadonlyInput<RunStatusDeps>,
): { readonly lines: string[]; readonly intercomTargets: string[] } {
  const lines: string[] = [];
  const intercomTargets: string[] = [];
  const childSafe = deps.nested !== undefined;
  const output = formatAsyncRunOutputPath({ asyncDir, outputFile: status.outputFile });
  for (const [index, step] of (status.steps ?? []).entries()) {
    lines.push(stepLine(status, step, index));
    if (step.tokens) {
      lines.push(`  ${step.tokens.total} tokens`);
    }
    lines.push(
      ...formatNestedRunStatusLines(step.children, {
        indent: "  ",
        commandHints: true,
        maxLines: 20,
        childSafe,
      }),
    );
    const stepOutput = path.join(asyncDir, `output-${index}.log`);
    if (stepOutput !== output && fs.existsSync(stepOutput)) {
      lines.push(`  Output: ${stepOutput}`);
    }
    if (step.status === "running") {
      const target = resolveSubagentIntercomTarget(status.runId, step.agent, index);
      intercomTargets.push(target);
      lines.push(
        ...formatLiveIntercomActionLines({
          runId: status.runId,
          index,
          target,
          health: deps.intercomHealth?.get(target),
          indent: "  ",
          childSafe,
        }),
      );
    }
  }
  return { lines, intercomTargets };
}

export function runtimeFooter(
  status: ReadonlyInput<AsyncStatus>,
  asyncDir: string,
  deps: ReadonlyInput<RunStatusDeps>,
  nested: { readonly children: ReadonlyInput<NestedRunSummary[]>; readonly warning?: string },
): string[] {
  const childSafe = deps.nested !== undefined;
  const attached = new Set(
    (status.steps ?? []).flatMap((step) => step.children?.map((child) => child.id) ?? []),
  );
  const children = nested.children.filter((child) => !attached.has(child.id));
  const lines = formatNestedRunStatusLines(children, {
    indent: "",
    commandHints: true,
    maxLines: 20,
    childSafe,
  });
  if (hasText(nested.warning)) {
    lines.push(`Warning: ${nested.warning}`);
  }
  if (hasText(status.sessionFile)) {
    lines.push(`Session: ${status.sessionFile}`);
  }
  if (status.state !== "running") {
    lines.push(
      formatResumeGuidance(status.runId, status.steps ?? [], status.sessionFile, childSafe),
    );
  }
  const log = path.join(asyncDir, `subagent-log-${status.runId}.md`);
  const events = path.join(asyncDir, "events.jsonl");
  if (fs.existsSync(log)) {
    lines.push(`Log: ${log}`);
  }
  if (fs.existsSync(events)) {
    lines.push(`Events: ${events}`);
  }
  return lines;
}

function nestedDisplayName(run: ReadonlyInput<NestedRunSummary>): string {
  if (hasText(run.agent)) {
    return run.agent;
  }
  return (run.agents?.length ?? 0) > 0 ? (run.agents?.join(", ") ?? run.id) : run.id;
}

function nestedSteps(run: ReadonlyInput<NestedRunSummary>, childSafe: boolean): string[] {
  const lines: string[] = [];
  if ((run.steps?.length ?? 0) > 0) {
    lines.push("Steps:");
  }
  for (const [index, step] of (run.steps ?? []).entries()) {
    const activity =
      step.status === "running"
        ? formatActivityLabel(step.lastActivityAt, step.activityState)
        : undefined;
    lines.push(
      `  ${index + 1}. ${step.agent} ${step.status}${hasText(activity) ? `, ${activity}` : ""}${hasText(step.error) ? `, error: ${step.error}` : ""}`,
    );
    lines.push(
      ...formatNestedRunStatusLines(step.children, {
        indent: "    ",
        commandHints: true,
        childSafe,
      }),
    );
  }
  lines.push(
    ...formatNestedRunStatusLines(run.children, { indent: "  ", commandHints: true, childSafe }),
  );
  return lines;
}

function nestedCommands(
  rootRunId: string,
  run: ReadonlyInput<NestedRunSummary>,
  childSafe: boolean,
): string[] {
  const state = normalizedState(run.state);
  const lines = ["Commands:", `  Status: ${formatRunAction("status", run.id, {}, childSafe)}`];
  if (state === "live") {
    lines.push(
      `  ${childSafe ? "Interrupt" : "Stop"}: ${formatRunAction("interrupt", run.id, {}, childSafe)}`,
    );
  }
  if (state === "live" || hasText(run.sessionFile)) {
    lines.push(
      `  ${childSafe ? "Resume" : "Continue"}: ${formatRunAction("resume", run.id, { message: "..." }, childSafe)}`,
    );
  }
  lines.push(`  Root status: ${formatRunAction("status", rootRunId, {}, childSafe)}`);
  return lines;
}

function nestedActivity(run: ReadonlyInput<NestedRunSummary>): string | undefined {
  const activity = formatActivityLabel(run.lastActivityAt, run.activityState);
  return hasText(activity) ? `Activity: ${activity}` : undefined;
}
function nestedProgress(run: ReadonlyInput<NestedRunSummary>): string | undefined {
  if (run.currentStep === undefined) {
    return undefined;
  }
  return `Progress: step ${run.currentStep + 1}/${run.chainStepCount ?? run.steps?.length ?? 1}`;
}

export function formatNestedExactStatus(
  rootRunId: string,
  run: ReadonlyInput<NestedRunSummary>,
  childSafe: boolean,
): string {
  const lines = [
    `Nested run: ${run.id}`,
    `Root: ${rootRunId}`,
    `Parent: ${run.parentRunId}${run.parentStepIndex !== undefined ? ` step ${run.parentStepIndex + 1}` : ""}`,
    `State: ${run.state}`,
    nestedActivity(run),
    run.mode !== undefined ? `Mode: ${run.mode}` : undefined,
    `Agent: ${nestedDisplayName(run)}`,
    nestedProgress(run),
    hasText(run.asyncDir) ? `Dir: ${run.asyncDir}` : undefined,
    hasText(run.sessionFile) ? `Session: ${run.sessionFile}` : undefined,
    hasText(run.error) ? `Error: ${run.error}` : undefined,
  ].filter((line) => line !== undefined);
  if (run.path.length > 0) {
    const parts = run.path.map(
      (part) =>
        `${part.runId}${part.stepIndex !== undefined ? `:${part.stepIndex + 1}` : ""}${hasText(part.agent) ? `:${part.agent}` : ""}`,
    );
    lines.push(`Path: ${parts.join(" > ")} > ${run.id}`);
  }
  return [
    ...lines,
    ...nestedSteps(run, childSafe),
    ...nestedCommands(rootRunId, run, childSafe),
  ].join("\n");
}
