import * as path from "node:path";
import { writeAsyncControlRequest } from "../background/async-control.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ownedRunExecutionResult, ownedRunProgressResult, ownedRunStatusResult, ownedRunView, resolveOwnedRun } from "../shared/run-records.ts";
import { getRunMetadataDir, listOwnedRunQuestions, questionProcessAlive, readRunJson } from "../shared/supervisor-questions.ts";
import { getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, type OwnedRun, type SubagentExecutionResult } from "../../shared/types.ts";
import { resolveSubagentRunId } from "../background/run-id-resolver.ts";
import { resolveNestedAsyncDir } from "../shared/nested-events.ts";
import { nestedResolutionScopeForExecutor } from "./foreground-control.ts";
import type { ExecutorDeps } from "./subagent-params.ts";

/** Wait on the saved outcome, not the transient notification file or an early terminal status. */
export async function waitForOwnedRun(input: {
	id: string;
	index?: number;
	deps: ExecutorDeps;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	onUpdate?: (result: SubagentExecutionResult) => void;
	cancelNewRun?: boolean;
	executionResult?: boolean;
	includeProgress?: boolean;
	nativeAsync?: boolean;
}): Promise<SubagentExecutionResult> {
	const { deps, id, index, ctx } = input;
	const owner = ctx.sessionManager.getSessionId(), session = deps.state.currentSessionId;
	let run: OwnedRun | undefined, nested = false;
	try {
		run = resolveOwnedRun(deps.state, id);
		if (!run) {
			const resolved = resolveSubagentRunId(id, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
			if (resolved?.kind === "nested") {
				const asyncDir = resolveNestedAsyncDir(resolved.match.rootRunId, resolved.match.run);
				const status = asyncDir ? readStatus(asyncDir) : null;
				if (status?.runId === resolved.id) {
					const savedOwner = readRunJson<{ sessionId: string }>(path.join(getRunMetadataDir(resolved.id), "question-owner.json"));
					// Read through the authorized route without adopting the descendant or attributing its usage to this caller.
					run = { runId: resolved.id, rootRunId: resolved.match.rootRunId, ownerSessionId: savedOwner?.sessionId ?? status.sessionId ?? "",
						source: "async", mode: status.mode, cwd: status.cwd ?? "", task: "Nested delegated run", startedAt: status.startedAt, asyncDir, pid: status.pid,
						children: (status.steps ?? []).map((step, index) => ({ agent: step.agent, index, sessionFile: step.sessionFile })) };
					nested = true;
				}
			}
		}
	} catch (error) {
		return { content: [{ type: "text", text: String(error) }], isError: true, details: { mode: "management", results: [] } };
	}
	if (!run || (!nested && run.ownerSessionId !== owner)) return { content: [{ type: "text", text: "Run is not available to wait on in this session. This wait did not start or stop work." }], isError: true, details: { mode: "management", results: [] } };
	const target = run;
	const waiting = deps.state.waitingRuns ??= new Map();
	waiting.set(target.runId, (waiting.get(target.runId) ?? 0) + 1);
	return new Promise((resolve) => {
		let finished = false, timer: ReturnType<typeof setInterval> | undefined, unsubscribe: (() => void) | undefined;
		let previous = "";
		const finish = (status: "completed" | "cancelled" | "yielded" | "awaiting_input" | "unavailable", text: string, result?: SubagentExecutionResult) => {
			if (finished) return;
			finished = true;
			const remaining = (waiting.get(target.runId) ?? 1) - 1;
			if (remaining) waiting.set(target.runId, remaining); else waiting.delete(target.runId);
			if (timer) clearInterval(timer);
			unsubscribe?.(); input.signal?.removeEventListener("abort", abort);
			const execution = input.executionResult && status === "completed" ? ownedRunExecutionResult(target, deps.state, index, input.includeProgress) : undefined;
			const pending = input.nativeAsync && input.signal?.aborted;
			resolve({ ...result, ...execution, content: status === "completed" && execution ? execution.content : [{ type: "text", text }],
				...(pending ? { pending: true } : status === "unavailable" || status === "cancelled" ? { isError: true } : {}),
				details: { mode: "management", results: [], ...result?.details, ...execution?.details, wait: { runId: target.runId, index, status } } });
		};
		const abort = () => {
			if (input.cancelNewRun && target.asyncDir) {
				writeAsyncControlRequest(target.asyncDir, target.runId, "cancel");
			}
			finish("cancelled", input.cancelNewRun ? `Wait cancelled; cancellation requested for newly launched run ${target.runId}. Process exit is not yet confirmed.` : `Stopped waiting for ${target.runId}. The child was not stopped; completion will arrive automatically.`);
		};
		const check = () => {
			if (deps.state.currentSessionId !== session || ctx.sessionManager.getSessionId() !== owner) { finish("unavailable", "The owning session changed. This wait ended without stopping the child."); return; }
			try {
				const runQuestions = listOwnedRunQuestions(target.ownerSessionId, target.runId);
				// Poll execution facts once. Native conversation configuration is only
				// needed when returning an inspection, never for live progress.
				const view = ownedRunView(target, deps.state, {
					pendingInput: runQuestions.some((question) => question.state === "awaiting_input" || question.state === "answer_pending"),
					readConfiguration: false, includeContinuations: false,
				});
				const children = view.children.filter((child) => index === undefined || child.index === index);
				if (index !== undefined && !children.length) { finish("unavailable", `Run ${target.runId} has no child at index ${index}.`); return; }
				const questions = runQuestions.filter((question) => question.ownerSessionId === owner && (index === undefined || question.index === index) && question.state === "awaiting_input");
				if (questions.length && !input.nativeAsync) {
					const result = ownedRunStatusResult(target, deps.state);
					result.details.questions = questions; finish("awaiting_input", `Run ${target.runId} needs input; waiting ended without stopping it.\n\n${questions.map((question) => `Question ${question.questionId}: ${question.message}`).join("\n\n")}`, result); return;
				}
				if ((index !== undefined || view.resultPath) && children.every((child) => child.result && child.state !== "live" && child.state !== "unknown") && (index !== undefined || view.state !== "live")) {
					const result = ownedRunStatusResult(target, deps.state);
					result.isError = children.some((child) => child.state === "failed") || (index === undefined && view.state === "failed") || undefined;
					finish("completed", [`Saved result for ${target.runId}${index !== undefined ? ` child ${index}` : ""}: ${index !== undefined ? children[0]!.state : view.state}`, ...children.map((child) => `\n${child.agent}: ${child.state}\n${getSingleResultOutput(child.result!) || child.result?.error || "(no output)"}`), result.content.map((part) => part.type === "text" ? part.text : "").join("\n")].join("\n"), result);
					return;
				}
				const pid = target.pid ?? (target.asyncDir ? readStatus(target.asyncDir)?.pid : undefined);
				const producerAlive = pid ? questionProcessAlive({ pid }) : children.some((child) => child.state === "live");
				if (!producerAlive) { finish("unavailable", `No saved final result is available for ${target.runId}; completion is unconfirmed. Inspect the saved session. No work was started.`, ownedRunStatusResult(target, deps.state)); return; }
				const update = `Waiting for ${target.runId}${index !== undefined ? ` child ${index}` : ""}: ${children.map((child) => child.state).join(", ")}. ${input.cancelNewRun ? "Cancelling requests cancellation of this newly launched run; process exit still needs confirmation." : "Cancelling this wait leaves existing work alive."}`;
				if (input.onUpdate) {
					const progress = ownedRunProgressResult(target, deps.state, index, view);
					const signature = JSON.stringify(progress.details.progress?.map(({ durationMs: _duration, ...activity }) => activity));
					if (signature !== previous) { previous = signature; input.onUpdate({ ...progress, content: [{ type: "text", text: update }, ...progress.content] }); }
				}
			} catch (error) { finish("unavailable", `Wait could not read ${target.runId}: ${error instanceof Error ? error.message : String(error)}`); }
		};
		unsubscribe = deps.pi.events.on(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (finished || !payload || typeof payload !== "object") return;
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			deps.pi.events.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
			if (input.nativeAsync) return;
			finish("yielded", `Released the wait for an incoming Intercom message. Run ${target.runId} is unchanged. Continue useful work or end the turn; completion will arrive automatically.`);
		});
		input.signal?.addEventListener("abort", abort, { once: true });
		if (input.signal?.aborted) abort(); else check();
		// Unlike passive background tracking, this foreground call owes a result.
		// The detached runner cannot keep this process alive; finish() releases the timer.
		if (!finished) timer = setInterval(check, 100);
	});
}
