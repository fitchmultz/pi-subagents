import type { HistoryPageInput, HistorySearchInput } from "../../history/types.ts";
import type { SubagentParamsLike } from "../foreground/subagent-params.ts";
import type { SubagentExecutionResult, SubagentState } from "../../shared/types.ts";
import { runHistoryIndex } from "./history-index.ts";
import { ownedRunView, resolveOwnedRun } from "./run-records.ts";

/** Browse observations never confer ownership or replace canonical control/receipt checks. */
export async function ownedHistoryQuery(state: SubagentState, params: SubagentParamsLike, signal?: AbortSignal): Promise<SubagentExecutionResult> {
	const requested = params.id ?? params.runId;
	const run = requested ? resolveOwnedRun(state, requested) : undefined;
	if (requested && !run) throw new Error("Run not found in this owning session.");
	const index = await runHistoryIndex(state, true);
	if (params.action === "history") {
		if (!run) throw new Error("History requires an owned run ID.");
		const view = ownedRunView(run, state, { includeContinuations: false, readConfiguration: false, reconcile: false });
		const child = params.index === undefined && view.children.length === 1 ? view.children[0] : view.children.find((child) => child.index === params.index);
		if (!child) throw new Error("Choose index for a run with multiple children.");
		const input: HistoryPageInput = { runId: run.runId, index: child.index, limit: params.limit, before: params.before, cursor: params.cursor, signal,
			...(child.state !== "live" ? { terminalEntryId: child.result?.terminalEntryId, endedAt: child.result?.terminalEntryId ? undefined : view.updatedAt } : {}) };
		const page = await index.historyPage(input);
		const earlier = page.previousCursor ? { action: "history", id: run.runId, index: child.index, limit: params.limit ?? 100, cursor: page.previousCursor } : undefined;
		return { content: [{ type: "text", text: [
			`History: ${run.runId}, child ${child.index} (${child.agent}); ${page.entries.length} of ${page.count} indexed native entries.`,
			`Browse index: ${page.freshness.state}. These are bounded previews, not completion or delivery receipts.`,
			...(page.unavailable ? [page.unavailable] : []),
			...page.entries.map((entry) => `- ${entry.id} · position ${entry.sequence}\n${JSON.stringify(entry.entry)}`),
			...(earlier ? [`Earlier: agent_runs(${JSON.stringify(earlier)})`] : []),
			...(child.sessionFile ? [`Native source: ${child.sessionFile}. Open a selected record in Agents for validated full details.`] : []),
		].join("\n") }], details: { mode: "management", results: [], runId: run.runId, history: page } };
	}
	if (params.action !== "search" || !params.query) throw new Error("Search requires query.");
	if (params.sort && !["relevance", "newest"].includes(params.sort)) throw new Error("Search sort must be relevance or newest.");
	const input: HistorySearchInput = { query: params.query, runId: run?.runId, index: params.index, limit: params.limit, cursor: params.cursor,
		sort: params.sort as HistorySearchInput["sort"], agent: params.agent, signal };
	const page = await index.search(input);
	const next = page.nextCursor ? { action: "search", query: params.query, ...(run ? { id: run.runId } : {}), ...(params.index !== undefined ? { index: params.index } : {}),
		...(params.agent ? { agent: params.agent } : {}), ...(params.sort ? { sort: params.sort } : {}), limit: params.limit ?? 20, cursor: page.nextCursor } : undefined;
	return { content: [{ type: "text", text: [
		`Saved-text search: ${page.matches.length} matches in this owning session; index ${page.freshness.state}.`,
		"Indexed excerpts may be stale. They do not establish completion, ownership, or delivery; full selected records are validated separately.",
		...page.matches.map((match) => `- ${match.runId}:${match.index} (${match.agent}) · entry ${match.entryId}\n${match.preview}\n${match.sessionFile}:${match.ref.start}`),
		...(next ? [`Next: agent_runs(${JSON.stringify(next)})`] : []),
	].join("\n") }], details: { mode: "management", results: [], historySearch: page } };
}
