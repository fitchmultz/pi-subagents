import { loadRunsForAgent } from "../shared/run-history.ts";
import { getStepAgents } from "../../shared/settings.ts";
import type { SubagentParamsLike } from "./subagent-params.ts";

type TimeoutRole = "reviewer" | "planner" | "researcher";
function timeoutRole(name: string | undefined): TimeoutRole | undefined {
  if (name === undefined) {
    return;
  }
  if (/(^|[._-])reviewer($|[._-])/i.test(name)) {
    return "reviewer";
  }
  if (/(^|[._-])planner($|[._-])/i.test(name)) {
    return "planner";
  }
  if (/(^|[._-])researcher($|[._-])/i.test(name)) {
    return "researcher";
  }
  return;
}
function historyFloor(name: string): number | undefined {
  const durations = loadRunsForAgent(name)
    .filter(
      (entry) => entry.status === "ok" && Number.isFinite(entry.duration) && entry.duration > 0,
    )
    .slice(0, 20)
    .map((entry) => entry.duration)
    .sort((left, right) => left - right);
  if (durations.length < 3) {
    return;
  }
  const percentile = durations.at(Math.ceil(durations.length * 0.75) - 1);
  return percentile === undefined ? undefined : Math.min(1_800_000, Math.ceil(percentile * 1.25));
}
function roleFloor(name: string): number | undefined {
  const role = timeoutRole(name);
  if (role === undefined) {
    return;
  }
  const historical = historyFloor(name);
  return role === "reviewer" ? Math.max(900_000, historical ?? 0) : historical;
}
/** Validate both aliases before choosing a value; invalid runtime inputs are not trusted. */
export function resolveForegroundTimeoutMs(params: SubagentParamsLike): {
  timeoutMs?: number;
  error?: string;
} {
  const timeout: unknown = params.timeoutMs;
  const maximum: unknown = params.maxRuntimeMs;
  const invalid = invalidTimeout("timeoutMs", timeout) ?? invalidTimeout("maxRuntimeMs", maximum);
  if (invalid !== undefined) {
    return { error: invalid };
  }
  if (timeout !== undefined && maximum !== undefined && timeout !== maximum) {
    return {
      error: "timeoutMs and maxRuntimeMs are aliases; provide only one or use identical values.",
    };
  }
  const value = timeout ?? maximum;
  return typeof value === "number" ? { timeoutMs: value } : {};
}
function invalidTimeout(name: string, value: unknown): string | undefined {
  if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
    return `${name} must be a positive integer.`;
  }
  return;
}
function requestAgents(params: SubagentParamsLike): readonly string[] {
  if ((params.chain?.length ?? 0) > 0) {
    return (params.chain ?? []).flatMap(getStepAgents);
  }
  if ((params.tasks?.length ?? 0) > 0) {
    return (params.tasks ?? []).map((task) => task.agent);
  }
  return params.agent === undefined ? [] : [params.agent];
}
export function normalizeRoleForegroundTimeout(
  params: SubagentParamsLike,
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs === undefined) {
    return;
  }
  let normalized = timeoutMs;
  for (const name of new Set(requestAgents(params))) {
    const floor = roleFloor(name);
    if (floor !== undefined && normalized < floor) {
      normalized = floor;
    }
  }
  return normalized;
}
