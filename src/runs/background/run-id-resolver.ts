import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { hasText } from "./async-value.ts";
import { formatRunIdAmbiguity } from "../shared/run-id-ambiguity.ts";
import { exactAsyncRunLocation, findAsyncRunPrefixMatches } from "./async-run-location.ts";
import type { AsyncRunLocation } from "./async-run-record.ts";
import {
  assertSafeNestedId,
  findNestedRunMatchesById,
  findNestedRouteForRootId,
  type NestedRoute,
  type NestedRunMatch,
  type NestedRunResolutionScope,
} from "../shared/nested-events.ts";

export type ResolvedSubagentRunId =
  | { readonly kind: "async"; readonly id: string; readonly location: AsyncRunLocation }
  | { readonly kind: "nested"; readonly id: string; readonly match: NestedRunMatch };
export type RunResolutionState = ReadonlyInput<Pick<SubagentState, "ownedRuns" | "asyncJobs">>;
export interface ResolveSubagentRunIdDeps {
  readonly state?: RunResolutionState;
  readonly asyncDirRoot?: string;
  readonly resultsDir?: string;
  readonly nested?: ReadonlyInput<NestedRunResolutionScope>;
}
function nestedScopeFromState(
  state: RunResolutionState | undefined,
): NestedRunResolutionScope | undefined {
  if (!state) {
    return undefined;
  }
  const routes: NestedRoute[] = [];
  const seen = new Set<string>();
  const add = (route: ReadonlyInput<NestedRoute> | undefined): void => {
    if (!route) {
      return;
    }
    const key = `${route.rootRunId}:${route.eventSink}:${route.controlInbox}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    routes.push({ ...route });
  };
  for (const run of state.ownedRuns?.values() ?? []) {
    add(findNestedRouteForRootId(run.runId));
  }
  for (const job of state.asyncJobs.values()) {
    add(job.nestedRoute);
  }
  return { routes };
}

function resolveExact(
  id: string,
  location: AsyncRunLocation,
  scope: ReadonlyInput<NestedRunResolutionScope> | undefined,
  preferDirect: boolean,
): ResolvedSubagentRunId | undefined {
  const exists = hasText(location.asyncDir) || hasText(location.resultPath);
  if (exists && preferDirect) {
    return { kind: "async", id, location };
  }
  const matches = findNestedRunMatchesById(id, scope === undefined ? {} : { scope });
  if (matches.length > 1) {
    throw new Error(
      `Nested run id '${id}' is ambiguous across authorized registries. Provide the full id after stale registries are cleaned up.`,
    );
  }
  const match = matches.at(0);
  if (match) {
    return { kind: "nested", id, match };
  }
  return exists ? { kind: "async", id, location } : undefined;
}

function resolvePrefix(
  id: string,
  options: ReadonlyInput<ResolveSubagentRunIdDeps>,
  preferDirect: (id: string) => boolean,
): ResolvedSubagentRunId | undefined {
  const asyncMatches = findAsyncRunPrefixMatches(
    id,
    options.asyncDirRoot ?? ASYNC_DIR,
    options.resultsDir ?? RESULTS_DIR,
  );
  const nestedMatches = findNestedRunMatchesById(id, { prefix: true, scope: options.nested });
  const matches: ResolvedSubagentRunId[] = [];
  for (const match of asyncMatches) {
    if (!preferDirect(match.id) && nestedMatches.some((nested) => nested.run.id === match.id)) {
      continue;
    }
    matches.push({ kind: "async", id: match.id, location: match.location });
  }
  for (const match of nestedMatches) {
    if (
      preferDirect(match.run.id) &&
      asyncMatches.some((candidate) => candidate.id === match.run.id)
    ) {
      continue;
    }
    matches.push({ kind: "nested", id: match.run.id, match });
  }
  const unique = new Map(
    matches.map((match) => [
      match.kind === "nested" ? `nested:${match.match.rootRunId}:${match.id}` : `async:${match.id}`,
      match,
    ]),
  );
  const values = [...unique.values()];
  if (values.length > 1) {
    throw new Error(
      formatRunIdAmbiguity(
        "subagent",
        id,
        values.map((match) => `${match.kind}:${match.id}`),
      ),
    );
  }
  return values.at(0);
}

export function resolveSubagentRunId(
  id: string,
  deps: ReadonlyInput<ResolveSubagentRunIdDeps> = {},
): ResolvedSubagentRunId | undefined {
  assertSafeNestedId("id", id);
  const root = deps.asyncDirRoot ?? ASYNC_DIR;
  const results = deps.resultsDir ?? RESULTS_DIR;
  const scope = deps.nested ?? nestedScopeFromState(deps.state);
  // Storage discovery must not hide an authorized descendant route in a session scope.
  const preferDirect = (runId: string): boolean =>
    scope === undefined ||
    deps.state?.ownedRuns?.has(runId) === true ||
    deps.state?.asyncJobs.has(runId) === true;
  const exact = resolveExact(id, exactAsyncRunLocation(id, root, results), scope, preferDirect(id));
  return exact ?? resolvePrefix(id, { ...deps, nested: scope }, preferDirect);
}
