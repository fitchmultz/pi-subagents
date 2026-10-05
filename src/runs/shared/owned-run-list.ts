import { runHistoryIndex } from "./history-index.ts";
import { getSingleResultOutput } from "../../shared/utils.ts";
import type { SubagentParamsLike } from "../foreground/subagent-params.ts";
import type {
  OwnedRun,
  OwnedRunView,
  SubagentExecutionResult,
  SubagentState,
  ReadonlyInput,
} from "../../shared/types.ts";
import { ownedRunView } from "./owned-run-view.ts";
import { compact, ownedRunControl } from "./owned-run-status.ts";

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
    diagnosis: `Saved owner records unavailable: ${String(error)}. Completion is unconfirmed.`,
  };
}

export async function ownedRunList(
  state: SubagentState,
  params: Pick<
    SubagentParamsLike,
    "offset" | "limit" | "cursor" | "sort" | "agent" | "state" | "text"
  > & { signal?: AbortSignal },
): Promise<SubagentExecutionResult> {
  const limit = params.limit ?? 20,
    sort = params.sort;
  if (sort === "relevance") {
    throw new Error("Run list sort must be attention, newest, or oldest.");
  }
  const indexed = await (await runHistoryIndex(state, true)).listRuns({ ...params, sort });
  // The index orders observations; only the bounded selected page gets authoritative controls.
  const page = indexed.rows.map((row) => {
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
  const owned = [...(state.ownedRuns?.values() ?? [])];
  const runs = page.map(
    ({
      runId,
      source,
      mode,
      cwd,
      task,
      state: runState,
      updatedAt,
      attention,
      review,
      rootRunId,
      predecessorRunId,
      predecessorIndex,
      children,
    }) => ({
      runId,
      source,
      mode,
      cwd,
      task: compact(task, 2048),
      state: runState,
      updatedAt,
      attention,
      review,
      rootRunId,
      predecessorRunId,
      predecessorIndex,
      continuations: owned
        .filter((candidate) => candidate.predecessorRunId === runId)
        .map((candidate) => candidate.runId),
      summary: compact(
        children
          .map((child) =>
            child.result ? getSingleResultOutput(child.result) || child.result.error || "" : "",
          )
          .filter(Boolean)
          .join(" | "),
      ),
    }),
  );
  const controls = page.map(ownedRunControl);
  const { offset, nextOffset, nextCursor, total, freshness, version } = indexed;
  const next = nextCursor
    ? {
        action: "list",
        cursor: nextCursor,
        limit,
        ...(sort ? { sort } : {}),
        ...(params.agent ? { agent: params.agent } : {}),
        ...(params.state ? { state: params.state } : {}),
        ...(params.text ? { text: params.text } : {}),
      }
    : undefined;
  return {
    content: [
      {
        type: "text",
        text: total
          ? [
              `Owned runs: ${total} (showing ${page.length ? `${offset + 1}–${offset + page.length}` : "none"}; ${params.sort ?? "attention"} order)`,
              ...(freshness.state !== "current"
                ? [
                    `Browse index: ${freshness.state}; ordering/filter observations may be incomplete. Selected controls are checked against owner records.`,
                  ]
                : []),
              ...runs.map(
                (run) =>
                  `- ${run.runId} | ${run.state}${run.attention.length ? ` | ${run.attention.join(", ")}` : ""} | ${compact(run.task)}${run.summary ? ` | ${run.summary}` : ""} | Launch cwd: ${run.cwd}${run.predecessorRunId ? ` | from ${run.predecessorRunId}:${run.predecessorIndex ?? 0}` : ""}${run.continuations.length ? ` | continued as ${run.continuations.join(", ")} (separate results/reviews)` : ""}`,
              ),
              ...(next ? [`Next: agent_runs(${JSON.stringify(next)})`] : []),
            ].join("\n")
          : "No delegated runs match in this owning session.",
      },
    ],
    details: {
      mode: "management",
      results: [],
      runs,
      managementControls: controls,
      managementControl: controls.find((control) => control.state === "live"),
      runList: {
        total,
        offset,
        limit,
        version,
        freshness,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(nextCursor ? { nextCursor } : {}),
      },
    },
  };
}
