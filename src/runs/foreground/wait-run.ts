import { writeAtomicJson } from "../../shared/atomic-json.ts";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ownedRunStatusResult, ownedRunView, resolveOwnedRun } from "../shared/run-records.ts";
import { listSupervisorQuestions, questionProcessAlive } from "../shared/supervisor-questions.ts";
import { getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, type SubagentExecutionResult } from "../../shared/types.ts";
import type { ExecutorDeps, SubagentParamsLike } from "./subagent-params.ts";

/** Wait on the saved outcome, not the transient notification file or an early terminal status. */
export async function waitForOwnedRun(input: {
	params: SubagentParamsLike;
	deps: ExecutorDeps;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	onUpdate?: (result: SubagentExecutionResult) => void;
	cancelNewRun?: boolean;
}): Promise<SubagentExecutionResult> {
	const { deps, params, ctx } = input;
	const owner = ctx.sessionManager.getSessionId(), session = deps.state.currentSessionId;
	const requested = params.id ?? params.runId;
	if (!requested) return { content: [{ type: "text", text: "Wait requires an owned run id." }], isError: true, details: { mode: "management", results: [] } };
	let run;
	try { run = resolveOwnedRun(deps.state, requested); } catch (error) {
		return { content: [{ type: "text", text: String(error) }], isError: true, details: { mode: "management", results: [] } };
	}
	if (!run || run.ownerSessionId !== owner) return { content: [{ type: "text", text: "Run not found in this parent session. No work started." }], isError: true, details: { mode: "management", results: [] } };
	const target = run;
	return new Promise((resolve) => {
		let finished = false, timer: ReturnType<typeof setInterval> | undefined, unsubscribe: (() => void) | undefined;
		let previous = "";
		const finish = (status: "completed" | "cancelled" | "yielded" | "awaiting_input" | "unavailable", text: string, result?: SubagentExecutionResult) => {
			if (finished) return;
			finished = true;
			if (timer) clearInterval(timer);
			unsubscribe?.(); input.signal?.removeEventListener("abort", abort);
			resolve({ ...result, content: [{ type: "text", text }], ...(status === "unavailable" || status === "cancelled" ? { isError: true } : {}),
				details: { ...result?.details, mode: "management", results: [], wait: { runId: target.runId, index: params.index, status } } });
		};
		const abort = () => {
			if (input.cancelNewRun && target.asyncDir) {
				writeAtomicJson(path.join(target.asyncDir, "control-request.json"), { requestId: randomUUID(), runId: target.runId, action: "cancel", createdAt: Date.now() });
			}
			finish("cancelled", input.cancelNewRun ? `Wait cancelled; cancellation requested for newly launched run ${target.runId}. Process exit is not yet confirmed.` : `Stopped waiting for ${target.runId}. The child was not stopped; wait again to collect its result.`);
		};
		const check = () => {
			if (deps.state.currentSessionId !== session || ctx.sessionManager.getSessionId() !== owner) { finish("unavailable", "The owning session changed. This wait ended without stopping the child."); return; }
			try {
				const view = ownedRunView(target, deps.state);
				const children = view.children.filter((child) => params.index === undefined || child.index === params.index);
				if (!children.length) { finish("unavailable", `Run ${target.runId} has no child at index ${params.index}.`); return; }
				const result = ownedRunStatusResult(target, deps.state);
				const questions = listSupervisorQuestions(owner, target.runId).filter((question) => (params.index === undefined || question.index === params.index) && question.state === "awaiting_input");
				if (questions.length) { result.details.questions = questions; finish("awaiting_input", `Run ${target.runId} needs input; waiting ended without stopping it.\n\n${questions.map((question) => `Question ${question.questionId}: ${question.message}`).join("\n\n")}`, result); return; }
				if ((params.index !== undefined || view.resultPath) && children.every((child) => child.result && child.state !== "live" && child.state !== "unknown") && (params.index !== undefined || view.state !== "live")) {
					result.isError = children.some((child) => child.state === "failed") || (params.index === undefined && view.state === "failed") || undefined;
					finish("completed", [`Saved result for ${target.runId}${params.index !== undefined ? ` child ${params.index}` : ""}: ${params.index !== undefined ? children[0]!.state : view.state}`, ...children.map((child) => `\n${child.agent}: ${child.state}\n${getSingleResultOutput(child.result!) || child.result?.error || "(no output)"}`), result.content.map((part) => part.type === "text" ? part.text : "").join("\n")].join("\n"), result);
					return;
				}
				const pid = target.pid ?? (target.asyncDir ? readStatus(target.asyncDir)?.pid : undefined);
				const producerAlive = deps.state.foregroundControls.has(target.runId) || (pid ? questionProcessAlive({ pid }) : children.some((child) => child.state === "live"));
				if (!producerAlive) { finish("unavailable", `No saved final result is available for ${target.runId}; completion is unconfirmed. Inspect the saved session. No work was started.`, result); return; }
				const update = `Waiting for ${target.runId}${params.index !== undefined ? ` child ${params.index}` : ""}: ${children.map((child) => child.state).join(", ")}. ${input.cancelNewRun ? "Cancelling requests cancellation of this newly launched run; process exit still needs confirmation." : "Cancelling this wait leaves existing work alive."}`;
				if (update !== previous) { previous = update; input.onUpdate?.({ content: [{ type: "text", text: update }], details: { mode: "management", results: [], run: view } }); }
			} catch (error) { finish("unavailable", `Wait could not read ${target.runId}: ${error instanceof Error ? error.message : String(error)}`); }
		};
		unsubscribe = deps.pi.events.on(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (finished || !payload || typeof payload !== "object") return;
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			deps.pi.events.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
			finish("yielded", `Released the wait for an incoming Intercom message. Run ${target.runId} is unchanged; use wait on this id again to collect its result.`);
		});
		input.signal?.addEventListener("abort", abort, { once: true });
		if (input.signal?.aborted) abort(); else check();
		if (!finished) { timer = setInterval(check, 100); timer.unref?.(); }
	});
}
