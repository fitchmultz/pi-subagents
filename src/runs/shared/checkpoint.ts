import * as path from "node:path";
import type { AsyncStatus, SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { hasLiveNestedDescendants, projectNestedRegistryForRoot } from "./nested-events.ts";
import { ownedRunView } from "./run-records.ts";
import { getRunMetadataDir, listSupervisorQuestions, questionProcessAlive, readQuestionContract, readRunJson } from "./supervisor-questions.ts";

/** Read existing run authorities; a terminal label alone is not process exit. */
export function subagentCheckpointBlocker(state: SubagentState, ownerSessionId: string): string | undefined {
	const alive = (pid?: number) => Boolean(pid && questionProcessAlive({ pid }));
	for (const job of state.asyncJobs.values()) {
		// Owned runs have durable authority below; their display can lag a consumed native result.
		const unownedActiveJob = !state.ownedRuns?.has(job.asyncId) && (job.status === "running" || job.status === "queued");
		if (alive(job.pid) || unownedActiveJob || hasLiveNestedDescendants(job.nestedChildren)) return `Background subagent ${job.asyncId} is live`;
	}
	if (listSupervisorQuestions(ownerSessionId).some((q) => q.state === "awaiting_input" || q.state === "answer_pending")) return "Subagent supervisor question is unresolved";
	for (const run of state.ownedRuns?.values() ?? []) {
		const status = (run.asyncDir ? readStatus(run.asyncDir) : undefined) ?? readRunJson<AsyncStatus>(path.join(getRunMetadataDir(run.runId), "status.json"));
		if (alive(run.pid) || alive(status?.pid) || hasLiveNestedDescendants(projectNestedRegistryForRoot(run.runId)?.children)) return `Subagent ${run.runId} process is live`;
		const view = ownedRunView(run, state, { includeContinuations: false });
		if (view.state === "live" || view.state === "unknown" || view.children.some((child) => child.state === "live" || child.state === "unknown" || alive(readQuestionContract(run.runId, child.index)?.pid))) return `Subagent ${run.runId} is live or completion is unconfirmed`;
	}
	return undefined;
}
