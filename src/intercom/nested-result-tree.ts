import type {
  NestedRunSummary,
  PublicNestedRunSummary,
  SubagentResultIntercomChild,
} from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";

type NestedRun = ReadonlyInput<NestedRunSummary | PublicNestedRunSummary>;
type NestedStep = NonNullable<NestedRun["steps"]>[number];

// Project only public metadata, not private tasks, outputs, or native messages.
function runMetadata(run: NestedRun): Record<string, string | number> {
  const metadata: Record<string, string | number> = {};
  for (const key of [
    "parentAgent",
    "asyncDir",
    "sessionId",
    "sessionFile",
    "intercomTarget",
    "ownerIntercomTarget",
    "leafIntercomTarget",
    "ownerState",
    "mode",
    "agent",
    "activityState",
    "currentTool",
    "currentPath",
    "error",
  ] as const) {
    const value = run[key];
    if (value !== undefined && value.length > 0) {
      metadata[key] = value;
    }
  }
  for (const key of [
    "parentStepIndex",
    "currentStep",
    "chainStepCount",
    "lastActivityAt",
    "currentToolStartedAt",
    "turnCount",
    "toolCount",
    "startedAt",
    "endedAt",
    "lastUpdate",
  ] as const) {
    const value = run[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function stepMetadata(step: NestedStep): Record<string, string | number> {
  const metadata: Record<string, string | number> = {};
  for (const key of [
    "sessionFile",
    "activityState",
    "currentTool",
    "currentPath",
    "error",
  ] as const) {
    const value = step[key];
    if (value !== undefined && value.length > 0) {
      metadata[key] = value;
    }
  }
  for (const key of [
    "lastActivityAt",
    "currentToolStartedAt",
    "turnCount",
    "toolCount",
    "startedAt",
    "endedAt",
  ] as const) {
    const value = step[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function compactStep(
  step: NestedStep,
  depth: number,
): NonNullable<PublicNestedRunSummary["steps"]>[number] {
  const children = depth < 2 ? compactChildren(step.children, 8, depth + 1) : undefined;
  return {
    agent: step.agent,
    status: step.status,
    ...stepMetadata(step),
    ...(children ? { children } : {}),
  };
}

function hasItems(values: readonly unknown[] | undefined): boolean {
  return values !== undefined && values.length > 0;
}

function compactRunLists(
  run: NestedRun,
  depth: number,
): Pick<PublicNestedRunSummary, "agents" | "parallelGroups" | "steps"> {
  return {
    ...(hasItems(run.agents) ? { agents: run.agents?.slice(0, 12) } : {}),
    ...(hasItems(run.parallelGroups) ? { parallelGroups: run.parallelGroups?.slice(0, 8) } : {}),
    ...(hasItems(run.steps)
      ? { steps: run.steps?.slice(0, 12).map((step) => compactStep(step, depth)) }
      : {}),
  };
}

function compactNestedRun(run: NestedRun, depth: number): PublicNestedRunSummary {
  const children = depth < 2 ? compactChildren(run.children, 8, depth + 1) : undefined;
  return {
    id: run.id,
    parentRunId: run.parentRunId,
    depth: run.depth,
    state: run.state,
    path: run.path
      .slice(0, 4)
      .map((part) =>
        Object.assign(
          { runId: part.runId },
          part.stepIndex !== undefined ? { stepIndex: part.stepIndex } : {},
          part.agent !== undefined && part.agent.length > 0 ? { agent: part.agent } : {},
        ),
      ),
    ...runMetadata(run),
    ...(run.totalTokens ? { totalTokens: run.totalTokens } : {}),
    ...compactRunLists(run, depth),
    ...(children ? { children } : {}),
  };
}

function compactChildren(
  children: readonly NestedRun[] | undefined,
  limit: number,
  depth: number,
): PublicNestedRunSummary[] | undefined {
  if (children === undefined || children.length === 0) {
    return undefined;
  }
  return children.slice(0, limit).map((child) => compactNestedRun(child, depth));
}

export function compactNestedResultChildren(
  children: readonly NestedRun[] | undefined,
): PublicNestedRunSummary[] | undefined {
  return compactChildren(children, 16, 0);
}

export function attachNestedChildrenToResultChildren(
  runId: string,
  children: ReadonlyInput<SubagentResultIntercomChild[]>,
  nestedChildren: readonly NestedRun[] | undefined,
): SubagentResultIntercomChild[] {
  const compact = compactNestedResultChildren(nestedChildren);
  return children.map((child, index) => {
    const alreadyAttached = new Set(child.children?.map((nested) => nested.id) ?? []);
    const attached =
      compact?.filter((nested) => {
        if (nested.parentRunId !== runId || alreadyAttached.has(nested.id)) {
          return false;
        }
        return (
          nested.parentStepIndex === (child.index ?? index) ||
          (children.length === 1 && nested.parentStepIndex === undefined)
        );
      }) ?? [];
    const merged = compactNestedResultChildren([...(child.children ?? []), ...attached]);
    return Object.assign({}, child, { children: merged });
  });
}

function hasSessionFile(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function formatNestedResultLines(
  children: ReadonlyInput<PublicNestedRunSummary[]> | undefined,
): string[] {
  if (children === undefined || children.length === 0) {
    return [];
  }
  const lines = ["Nested subagents:"];
  let remaining = 10;
  const append = (
    runs: ReadonlyInput<PublicNestedRunSummary[]> | undefined,
    indent: string,
  ): void => {
    for (const run of runs ?? []) {
      if (remaining <= 0) {
        lines.push(`${indent}↳ +more nested runs; inspect status for full tree`);
        return;
      }
      remaining--;
      const label = run.agent ?? run.agents?.join("+") ?? run.id;
      lines.push(`${indent}↳ ${label} — ${run.state} [${run.id}]`);
      if (hasSessionFile(run.sessionFile)) {
        lines.push(`${indent}  Session: ${run.sessionFile}`);
      }
      append(run.children, `${indent}  `);
      for (const step of run.steps ?? []) {
        append(step.children, `${indent}    `);
      }
    }
  };
  append(children, "");
  return lines;
}
