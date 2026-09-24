import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../shared/types.ts";
import { formatRunIdAmbiguity } from "../shared/run-id-ambiguity.ts";
import { exactAsyncRunLocation, findAsyncRunPrefixMatches, type AsyncRunLocation } from "./async-resume.ts";
import { assertSafeNestedId, findNestedRunMatchesById, findNestedRouteForRootId, type NestedRoute, type NestedRunMatch, type NestedRunResolutionScope } from "../shared/nested-events.ts";

export type ResolvedSubagentRunId =
	| { kind: "async"; id: string; location: AsyncRunLocation }
	| { kind: "nested"; id: string; match: NestedRunMatch };

export interface ResolveSubagentRunIdDeps {
	state?: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	nested?: NestedRunResolutionScope;
}

function nestedScopeFromState(state: SubagentState | undefined): NestedRunResolutionScope | undefined {
	if (!state) return undefined;
	const routes: NestedRoute[] = [];
	const seen = new Set<string>();
	const add = (route: NestedRoute | undefined) => {
		if (!route) return;
		const key = `${route.rootRunId}:${route.eventSink}:${route.controlInbox}`;
		if (seen.has(key)) return;
		seen.add(key);
		routes.push(route);
	};
	for (const run of state.ownedRuns?.values() ?? []) add(findNestedRouteForRootId(run.runId));
	for (const job of state.asyncJobs.values()) add(job.nestedRoute as NestedRoute | undefined);
	return { routes };
}

function asyncPrefixMatches(prefix: string, asyncDirRoot: string, resultsDir: string): Array<{ id: string; location: AsyncRunLocation }> {
	return findAsyncRunPrefixMatches(prefix, asyncDirRoot, resultsDir);
}

export function resolveSubagentRunId(id: string, deps: ResolveSubagentRunIdDeps = {}): ResolvedSubagentRunId | undefined {
	assertSafeNestedId("id", id);
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;

	const nestedScope = deps.nested ?? nestedScopeFromState(deps.state);
	// In a session scope, storage discovery must not hide an authorized descendant route.
	const preferDirectAsync = (runId: string) => !nestedScope || deps.state?.ownedRuns?.has(runId) || deps.state?.asyncJobs.has(runId);
	const exactAsync = exactAsyncRunLocation(id, asyncDirRoot, resultsDir);
	if ((exactAsync.asyncDir || exactAsync.resultPath) && preferDirectAsync(id)) return { kind: "async", id, location: exactAsync };
	const exactNested = findNestedRunMatchesById(id, nestedScope ? { scope: nestedScope } : {});
	if (exactNested.length > 1) throw new Error(`Nested run id '${id}' is ambiguous across authorized registries. Provide the full id after stale registries are cleaned up.`);
	if (exactNested[0]) return { kind: "nested", id, match: exactNested[0] };
	if (exactAsync.asyncDir || exactAsync.resultPath) return { kind: "async", id, location: exactAsync };

	const asyncMatches = asyncPrefixMatches(id, asyncDirRoot, resultsDir);
	const nestedMatches = findNestedRunMatchesById(id, nestedScope ? { prefix: true, scope: nestedScope } : { prefix: true });
	const matches: ResolvedSubagentRunId[] = [];
	for (const match of asyncMatches) {
		if (!preferDirectAsync(match.id) && nestedMatches.some((nested) => nested.run.id === match.id)) continue;
		matches.push({ kind: "async", id: match.id, location: match.location });
	}
	for (const match of nestedMatches) {
		if (preferDirectAsync(match.run.id) && asyncMatches.some((candidate) => candidate.id === match.run.id)) continue;
		matches.push({ kind: "nested", id: match.run.id, match });
	}
	const unique = new Map(matches.map((match) => [match.kind === "nested" ? `nested:${match.match.rootRunId}:${match.id}` : `async:${match.id}`, match]));
	const values = [...unique.values()];
	if (values.length > 1) {
		throw new Error(formatRunIdAmbiguity("subagent", id, values.map((match) => `${match.kind}:${match.id}`)));
	}
	return values[0];
}
