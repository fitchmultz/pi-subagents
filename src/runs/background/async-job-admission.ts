import type { AsyncJobState, AsyncStartedEvent } from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { hasText } from "./async-value.ts";

function startedAgents(info: ReadonlyInput<AsyncStartedEvent>): readonly string[] | undefined {
  if ((info.agents?.length ?? 0) > 0) {
    return info.agents;
  }
  if ((info.chain?.length ?? 0) > 0) {
    return info.chain;
  }
  return hasText(info.agent) ? [info.agent] : undefined;
}
function parallelProjection(
  info: ReadonlyInput<AsyncStartedEvent>,
): Pick<AsyncJobState, "agents" | "parallelGroups" | "stepsTotal" | "activeParallelGroup"> {
  const groups = normalizeParallelGroups(
    info.parallelGroups,
    Number.MAX_SAFE_INTEGER,
    info.chainStepCount ?? Number.MAX_SAFE_INTEGER,
  );
  const count = groups.find((group) => group.start === 0)?.count;
  const raw = startedAgents(info);
  const active = count !== undefined && count > 0;
  const agents = active ? raw?.slice(0, count) : raw;
  return {
    agents,
    parallelGroups: groups,
    stepsTotal: count ?? agents?.length,
    activeParallelGroup: active,
  };
}
/** Admission records own no resources until the tracker inserts them and starts polling. */
export function startedJob(
  id: string,
  info: ReadonlyInput<AsyncStartedEvent>,
  asyncDir: string,
  now: number,
): AsyncJobState {
  return {
    asyncId: id,
    asyncDir,
    status: "queued",
    pid: info.pid,
    sessionId: info.sessionId,
    mode: info.mode ?? (info.chain ? "chain" : "single"),
    chainStepCount: info.chainStepCount,
    nestedRoute: info.nestedRoute,
    startedAt: now,
    updatedAt: now,
    ...parallelProjection(info),
  };
}
