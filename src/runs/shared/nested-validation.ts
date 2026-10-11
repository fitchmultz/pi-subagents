import type { NestedRunSummary, NestedRunState, NestedStepSummary } from "../../shared/types.ts";
import { sanitizeNestedPath } from "./nested-path.ts";
import { isRecord } from "../../shared/unknown.ts";
import {
  isSafeNestedId,
  type NestedRoute,
  type NestedEventRecord,
  MAX_DEPTH,
  MAX_STEPS,
  MAX_CHILDREN,
  MAX_EVENT_BYTES,
} from "./nested-protocol.ts";

export function clampNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringValue(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function textFields<K extends string>(
  raw: Readonly<Record<string, unknown>>,
  keys: readonly K[],
  max: number,
): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = stringValue(raw[key], max);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function numberFields<K extends string>(
  raw: Readonly<Record<string, unknown>>,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = clampNumber(raw[key]);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function activity(
  raw: Readonly<Record<string, unknown>>,
): Pick<
  NestedRunSummary,
  | "currentTool"
  | "currentPath"
  | "error"
  | "lastActivityAt"
  | "currentToolStartedAt"
  | "turnCount"
  | "toolCount"
  | "startedAt"
  | "endedAt"
  | "activityState"
> {
  return {
    ...textFields(raw, ["currentTool"], 128),
    ...textFields(raw, ["currentPath"], 2048),
    ...textFields(raw, ["error"], 1024),
    ...numberFields(raw, [
      "lastActivityAt",
      "currentToolStartedAt",
      "turnCount",
      "toolCount",
      "startedAt",
      "endedAt",
    ]),
    ...(raw.activityState === "needs_attention" ? { activityState: "needs_attention" } : {}),
  };
}

function sanitizeTokenUsage(value: unknown): NestedRunSummary["totalTokens"] | undefined {
  if (!isRecord(value)) {
    return;
  }
  const input = clampNumber(value.input);
  const output = clampNumber(value.output);
  const total = clampNumber(value.total);
  return input !== undefined && output !== undefined && total !== undefined
    ? { input, output, total }
    : undefined;
}

const RUN_STATES: readonly NestedRunState[] = [
  "queued",
  "running",
  "complete",
  "failed",
  "blocked",
  "paused",
];
function sanitizeState(value: unknown): NestedRunState {
  return RUN_STATES.find((state) => state === value) ?? "running";
}

const STEP_STATES: readonly NestedStepSummary["status"][] = [
  "pending",
  "running",
  "complete",
  "completed",
  "failed",
  "blocked",
  "paused",
];
function nestedChildren(
  raw: Readonly<Record<string, unknown>>,
  depth: number,
): Pick<NestedRunSummary, "children"> {
  if (depth >= MAX_DEPTH || !Array.isArray(raw.children)) {
    return {};
  }
  return {
    children: raw.children
      .map((child) => sanitizeSummary(child, depth + 1))
      .filter((child): child is NestedRunSummary => child !== undefined)
      .slice(0, MAX_CHILDREN),
  };
}

function sanitizeStep(input: unknown, depth: number): NestedStepSummary | undefined {
  if (!isRecord(input)) {
    return;
  }
  const agent = stringValue(input.agent, 128);
  if (agent === undefined) {
    return;
  }
  return {
    agent,
    status: STEP_STATES.find((state) => state === input.status) ?? "pending",
    ...textFields(input, ["sessionFile"], 2048),
    ...activity(input),
    ...nestedChildren(input, depth),
  };
}

function summaryIdentity(
  raw: Readonly<Record<string, unknown>>,
): Pick<
  NestedRunSummary,
  | "parentAgent"
  | "capabilityToken"
  | "agent"
  | "asyncDir"
  | "sessionFile"
  | "controlInbox"
  | "sessionId"
  | "intercomTarget"
  | "ownerIntercomTarget"
  | "leafIntercomTarget"
  | "pid"
  | "ownerState"
  | "mode"
> {
  const pid = clampNumber(raw.pid);
  const ownerState = raw.ownerState;
  const mode = raw.mode;
  return {
    ...textFields(raw, ["parentAgent", "capabilityToken", "agent"], 128),
    ...textFields(raw, ["asyncDir", "sessionFile", "controlInbox"], 2048),
    ...textFields(
      raw,
      ["sessionId", "intercomTarget", "ownerIntercomTarget", "leafIntercomTarget"],
      256,
    ),
    ...(pid !== undefined && pid > 0 && Number.isInteger(pid) ? { pid } : {}),
    ...(ownerState === "live" || ownerState === "gone" || ownerState === "unknown"
      ? { ownerState }
      : {}),
    ...(mode === "single" || mode === "parallel" || mode === "chain" ? { mode } : {}),
  };
}

function summaryWork(raw: Readonly<Record<string, unknown>>, depth: number) {
  const totalTokens = sanitizeTokenUsage(raw.totalTokens);
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .map((step) => sanitizeStep(step, depth + 1))
        .filter((step): step is NestedStepSummary => step !== undefined)
        .slice(0, MAX_STEPS)
    : undefined;
  return {
    ...(Array.isArray(raw.agents)
      ? {
          agents: raw.agents
            .map((agent) => stringValue(agent, 128))
            .filter((agent): agent is string => agent !== undefined)
            .slice(0, MAX_STEPS),
        }
      : {}),
    ...numberFields(raw, ["currentStep", "chainStepCount", "lastUpdate"]),
    ...(totalTokens ? { totalTokens } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...nestedChildren(raw, depth),
  };
}

export function sanitizeSummary(input: unknown, depth = 0): NestedRunSummary | undefined {
  if (!isRecord(input) || !isSafeNestedId(input.id) || !isSafeNestedId(input.parentRunId)) {
    return;
  }
  return {
    id: input.id,
    parentRunId: input.parentRunId,
    ...numberFields(input, ["parentStepIndex"]),
    depth: Math.min(Math.max(0, clampNumber(input.depth) ?? 0), MAX_DEPTH),
    path: sanitizeNestedPath(input.path),
    state: sanitizeState(input.state),
    ...(input.indexedControl === true ? { indexedControl: true } : {}),
    ...summaryIdentity(input),
    ...activity(input),
    ...summaryWork(input, depth),
  };
}

export function parseRouteRecord(
  content: string,
  route: NestedRoute,
): Readonly<Record<string, unknown>> | undefined {
  if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) {
    return;
  }
  try {
    const raw: unknown = JSON.parse(content);
    if (
      isRecord(raw) &&
      raw.rootRunId === route.rootRunId &&
      raw.capabilityToken === route.capabilityToken
    ) {
      return raw;
    }
  } catch {
    // An incomplete or malformed immutable event is not admissible evidence.
  }
  return;
}

export function parseRecord(content: string, route: NestedRoute): NestedEventRecord | undefined {
  const raw = parseRouteRecord(content, route);
  if (!raw || !isSafeNestedId(raw.parentRunId)) {
    return;
  }
  if (
    raw.type !== "subagent.nested.started" &&
    raw.type !== "subagent.nested.updated" &&
    raw.type !== "subagent.nested.completed"
  ) {
    return;
  }
  const ts = clampNumber(raw.ts);
  const child = sanitizeSummary(raw.child);
  if (ts === undefined || !child || child.id === route.rootRunId) {
    return;
  }
  return {
    type: raw.type,
    ts,
    rootRunId: route.rootRunId,
    parentRunId: raw.parentRunId,
    ...numberFields(raw, ["parentStepIndex"]),
    capabilityToken: route.capabilityToken,
    child: {
      ...child,
      controlInbox: route.controlInbox,
      capabilityToken: route.capabilityToken,
      ownerState: child.ownerState ?? "unknown",
    },
  };
}

export function parseNestedEventRecords(content: string, route: NestedRoute): NestedEventRecord[] {
  if (!content.includes("\n")) {
    const record = parseRecord(content.trim(), route);
    return record ? [record] : [];
  }
  return content
    .split("\n")
    .slice(0, content.endsWith("\n") ? undefined : -1)
    .map((line) => (line.trim().length > 0 ? parseRecord(line, route) : undefined))
    .filter((event): event is NestedEventRecord => event !== undefined);
}
