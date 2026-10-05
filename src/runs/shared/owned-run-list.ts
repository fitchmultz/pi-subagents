import { runHistoryIndex } from "./history-index.ts";
import { getSingleResultOutput } from "../../shared/utils.ts";
import { errorMessage } from "../../shared/unknown.ts";
import type { SubagentParamsLike } from "../foreground/subagent-params.ts";
import type { HistoryRunPage } from "../../shared/types/history.ts";
import type {
  OwnedRun,
  OwnedRunView,
  SubagentExecutionResult,
  SubagentState,
} from "../../shared/types.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { ownedRunView } from "./owned-run-view.ts";
import { compact, ownedRunControl } from "./owned-run-status.ts";

type ListOptions = Readonly<
  Pick<SubagentParamsLike, "offset" | "limit" | "cursor" | "sort" | "agent" | "state" | "text">
> & { readonly signal?: AbortSignal };
type ListRun = NonNullable<SubagentExecutionResult["details"]["runs"]>[number];

function unavailableRunView(run: OwnedRun, error: unknown): OwnedRunView {
  return {
    ...run,
    state: "unknown",
    updatedAt: run.startedAt,
    attention: ["unknown"],
    canInterrupt: false,
    continuations: [],
    children: run.children.map((child) => ({
      ...child,
      state: "unknown",
      configuration: "legacy-partial",
    })),
    diagnosis: `Saved owner records unavailable: ${errorMessage(error)}. Completion is unconfirmed.`,
  };
}

function selectedPage(state: OwnedRunReadState, indexed: HistoryRunPage): OwnedRunView[] {
  // The index orders observations; only this bounded selected page gets authoritative controls.
  return indexed.rows.map((row) => {
    const run = state.ownedRuns?.get(row.runId);
    if (!run || run.ownerSessionId !== row.ownerSessionId) {
      throw new Error("Owning session changed while listing runs.");
    }
    try {
      return ownedRunView(run, state, { includeContinuations: false, readConfiguration: false });
    } catch (error) {
      return unavailableRunView(run, error);
    }
  });
}

function runSummary(view: OwnedRunView, owned: readonly OwnedRun[]): ListRun {
  const {
    runId,
    source,
    mode,
    cwd,
    task,
    state,
    updatedAt,
    attention,
    review,
    rootRunId,
    predecessorRunId,
    predecessorIndex,
  } = view;
  const outputs = view.children.map((child) => {
    if (!child.result) {
      return "";
    }
    const output = getSingleResultOutput(child.result);
    return output !== "" ? output : (child.result.error ?? "");
  });
  return {
    runId,
    source,
    mode,
    cwd,
    task: compact(task, 2048),
    state,
    updatedAt,
    attention,
    review,
    rootRunId,
    predecessorRunId,
    predecessorIndex,
    continuations: owned
      .filter((candidate) => candidate.predecessorRunId === runId)
      .map((candidate) => candidate.runId),
    summary: compact(outputs.filter((output) => output !== "").join(" | ")),
  };
}

function continuationDescription(run: ListRun): string[] {
  const continuations = run.continuations ?? [];
  return continuations.length > 0
    ? [`continued as ${continuations.join(", ")} (separate results/reviews)`]
    : [];
}

function runLine(run: ListRun): string {
  return [
    `- ${run.runId} | ${run.state}`,
    ...(run.attention.length > 0 ? [run.attention.join(", ")] : []),
    compact(run.task),
    ...((run.summary ?? "") !== "" ? [run.summary ?? ""] : []),
    `Launch cwd: ${run.cwd}`,
    ...((run.predecessorRunId ?? "") !== ""
      ? [`from ${run.predecessorRunId ?? ""}:${run.predecessorIndex ?? 0}`]
      : []),
    ...continuationDescription(run),
  ].join(" | ");
}

function nextPage(indexed: HistoryRunPage, params: ListOptions): string[] {
  if (indexed.nextCursor === undefined || indexed.nextCursor === "") {
    return [];
  }
  const next = {
    action: "list",
    cursor: indexed.nextCursor,
    limit: params.limit ?? 20,
    ...(params.sort !== undefined ? { sort: params.sort } : {}),
    ...((params.agent ?? "") !== "" ? { agent: params.agent } : {}),
    ...(params.state !== undefined ? { state: params.state } : {}),
    ...((params.text ?? "") !== "" ? { text: params.text } : {}),
  };
  return [`Next: agent_runs(${JSON.stringify(next)})`];
}

function listDescription(
  indexed: HistoryRunPage,
  runs: readonly ListRun[],
  params: ListOptions,
): string {
  if (indexed.total === 0) {
    return "No delegated runs match in this owning session.";
  }
  const range = runs.length > 0 ? `${indexed.offset + 1}–${indexed.offset + runs.length}` : "none";
  return [
    `Owned runs: ${indexed.total} (showing ${range}; ${params.sort ?? "attention"} order)`,
    ...(indexed.freshness.state !== "current"
      ? [
          `Browse index: ${indexed.freshness.state}; ordering/filter observations may be incomplete. Selected controls are checked against owner records.`,
        ]
      : []),
    ...runs.map(runLine),
    ...nextPage(indexed, params),
  ].join("\n");
}

export async function ownedRunList(
  state: SubagentState,
  params: ListOptions,
): Promise<SubagentExecutionResult> {
  const sort = params.sort;
  if (sort === "relevance") {
    throw new Error("Run list sort must be attention, newest, or oldest.");
  }
  const index = await runHistoryIndex(state, true);
  const indexed = await index.listRuns({ ...params, sort });
  const page = selectedPage(state, indexed);
  const owned = [...(state.ownedRuns?.values() ?? [])];
  const runs = page.map((view) => runSummary(view, owned));
  const controls = page.map(ownedRunControl);
  const { total, offset, nextOffset, nextCursor, freshness, version } = indexed;
  return {
    content: [{ type: "text", text: listDescription(indexed, runs, params) }],
    details: {
      mode: "management",
      results: [],
      runs,
      managementControls: controls,
      managementControl: controls.find((control) => control.state === "live"),
      runList: {
        total,
        offset,
        limit: params.limit ?? 20,
        version,
        freshness,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(nextCursor !== undefined && nextCursor !== "" ? { nextCursor } : {}),
      },
    },
  };
}
