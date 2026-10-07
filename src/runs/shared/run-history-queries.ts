import type {
  HistoryIndexHandle,
  HistoryPage,
  HistoryPageInput,
  HistorySearchInput,
  HistorySearchPage,
} from "../../shared/types/history.ts";
import type { SubagentParamsLike } from "../foreground/subagent-params.ts";
import type {
  OwnedRun,
  OwnedRunView,
  SubagentExecutionResult,
  SubagentState,
} from "../../shared/types.ts";
import { runHistoryIndex } from "./history-index.ts";
import { ownedRunView, resolveOwnedRun } from "./run-records.ts";

type OwnedRunChildView = OwnedRunView["children"][number];

type HistoryQuery = Readonly<
  Pick<
    SubagentParamsLike,
    "id" | "runId" | "action" | "index" | "limit" | "before" | "cursor" | "query" | "sort" | "agent"
  >
>;

function selectHistoryChild(view: OwnedRunView, index?: number): OwnedRunChildView {
  const child =
    index === undefined && view.children.length === 1
      ? view.children[0]
      : view.children.find((entry) => entry.index === index);
  if (!child) {
    throw new Error("Choose index for a run with multiple children.");
  }
  return child;
}

function historyInput(
  view: OwnedRunView,
  child: OwnedRunChildView,
  params: HistoryQuery,
  signal?: AbortSignal,
): HistoryPageInput {
  return {
    runId: view.runId,
    index: child.index,
    limit: params.limit,
    before: params.before,
    cursor: params.cursor,
    signal,
    ...(child.state !== "live"
      ? {
          terminalEntryId: child.result?.terminalEntryId,
          endedAt: (child.result?.terminalEntryId ?? "") !== "" ? undefined : view.updatedAt,
        }
      : {}),
  };
}

function historyResult(
  view: OwnedRunView,
  child: OwnedRunChildView,
  page: HistoryPage,
  limit?: number,
): SubagentExecutionResult {
  const earlier =
    (page.previousCursor ?? "") !== ""
      ? {
          action: "history",
          id: view.runId,
          index: child.index,
          limit: limit ?? 100,
          cursor: page.previousCursor,
        }
      : undefined;
  const source = child.sessionFile;
  return {
    content: [
      {
        type: "text",
        text: [
          `History: ${view.runId}, child ${child.index} (${child.agent}); ${page.entries.length} of ${page.count} indexed native entries.`,
          `Browse index: ${page.freshness.state}. These are bounded previews, not completion or delivery receipts.`,
          ...((page.unavailable ?? "") !== "" ? [page.unavailable] : []),
          ...page.entries.map(
            (entry) => `- ${entry.id} · position ${entry.sequence}\n${JSON.stringify(entry.entry)}`,
          ),
          ...(earlier ? [`Earlier: agent_runs(${JSON.stringify(earlier)})`] : []),
          ...(source !== undefined && source !== ""
            ? [
                `Native source: ${source}. Open a selected record in Agents for validated full details.`,
              ]
            : []),
        ].join("\n"),
      },
    ],
    details: { mode: "management", results: [], runId: view.runId, history: page },
  };
}

function searchInput(
  params: HistoryQuery,
  run?: OwnedRun,
  signal?: AbortSignal,
): HistorySearchInput {
  if (params.query === undefined || params.query === "") {
    throw new Error("Search requires query.");
  }
  if (params.sort !== undefined && !["relevance", "newest"].includes(params.sort)) {
    throw new Error("Search sort must be relevance or newest.");
  }
  return {
    query: params.query,
    runId: run?.runId,
    index: params.index,
    limit: params.limit,
    cursor: params.cursor,
    sort: params.sort === "relevance" || params.sort === "newest" ? params.sort : undefined,
    agent: params.agent,
    signal,
  };
}

function searchContinuation(input: HistorySearchInput, page: HistorySearchPage): string[] {
  if ((page.nextCursor ?? "") === "") {
    return [];
  }
  const next = {
    action: "search",
    query: input.query,
    ...(input.runId !== undefined ? { id: input.runId } : {}),
    ...(input.index !== undefined ? { index: input.index } : {}),
    ...((input.agent ?? "") !== "" ? { agent: input.agent } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : {}),
    limit: input.limit ?? 20,
    cursor: page.nextCursor,
  };
  return [`Next: agent_runs(${JSON.stringify(next)})`];
}

async function searchHistory(
  index: HistoryIndexHandle,
  input: HistorySearchInput,
): Promise<SubagentExecutionResult> {
  const page = await index.search(input);
  return {
    content: [
      {
        type: "text",
        text: [
          `Saved-text search: ${page.matches.length} matches in this owning session; index ${page.freshness.state}.`,
          "Indexed excerpts may be stale. They do not establish completion, ownership, or delivery; full selected records are validated separately.",
          ...page.matches.map(
            (match) =>
              `- ${match.runId}:${match.index} (${match.agent}) · entry ${match.entryId}\n${match.preview}\n${match.sessionFile}:${match.ref.start}`,
          ),
          ...searchContinuation(input, page),
        ].join("\n"),
      },
    ],
    details: { mode: "management", results: [], historySearch: page },
  };
}

/** Browse observations never confer ownership or replace canonical control/receipt checks. */
export async function ownedHistoryQuery(
  state: SubagentState,
  params: HistoryQuery,
  signal?: AbortSignal,
): Promise<SubagentExecutionResult> {
  const requested = params.id ?? params.runId;
  const run =
    requested !== undefined && requested !== "" ? resolveOwnedRun(state, requested) : undefined;
  if (requested !== undefined && requested !== "" && !run) {
    throw new Error("Run not found in this owning session.");
  }
  const index = await runHistoryIndex(state, true);
  if (params.action !== "history") {
    if (params.action !== "search") {
      throw new Error("Search requires query.");
    }
    return searchHistory(index, searchInput(params, run, signal));
  }
  if (!run) {
    throw new Error("History requires an owned run ID.");
  }
  const view = ownedRunView(run, state, {
    includeContinuations: false,
    readConfiguration: false,
    reconcile: false,
  });
  const child = selectHistoryChild(view, params.index);
  const page = await index.historyPage(historyInput(view, child, params, signal));
  return historyResult(view, child, page, params.limit);
}
