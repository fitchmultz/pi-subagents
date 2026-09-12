import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { IntercomEventBus, SubagentExecutionResult } from "../../shared/types.ts";
import { cancelSupervisorQuestion, claimQuestionRevival, formatSupervisorQuestions, listSupervisorQuestions, questionProcessAlive, questionRecoveryHint, readQuestionState, recordQuestionDelivery, releaseQuestionRevival, saveQuestionAnswer, type SupervisorQuestionView } from "../shared/supervisor-questions.ts";
import { liveLaunchOverrideNotice, nestedResolutionScopeForExecutor, reviveSavedSubagent } from "./foreground-control.ts";
import type { ExecutorDeps, SubagentParamsLike } from "./subagent-params.ts";

function questionResult(questions: SupervisorQuestionView[], text = formatSupervisorQuestions(questions)): SubagentExecutionResult {
	return { content: [{ type: "text", text }], details: { mode: "management", results: [], questions } };
}

export function projectSupervisorQuestions(result: SubagentExecutionResult, params: SubagentParamsLike, ownerSessionId: string, childSafe = false): SubagentExecutionResult {
	if (result.isError && !result.content.some((item) => item.type === "text" && /Async run not found|Status file not found/.test(item.text))) return result;
	const questions = listSupervisorQuestions(ownerSessionId, params.id ?? params.runId ?? (params.dir ? path.basename(params.dir) : undefined))
		.filter((question) => question.state === "awaiting_input" || question.state === "answer_pending");
	if (!questions.length) return result;
	const questionOnly = result.isError && result.content.some((item) => item.type === "text" && /Async run not found|Status file not found/.test(item.text));
	return {
		...result,
		...(questionOnly ? { isError: false } : {}),
		content: [{ type: "text", text: [`Supervisor input (not execution completion):\n${formatSupervisorQuestions(questions, childSafe)}`, ...(questionOnly ? [] : result.content.map((item) => item.type === "text" ? item.text : ""))].join("\n\n") }],
		details: { ...result.details, questions },
	};
}

export function cancelSupervisorInput(result: SubagentExecutionResult, params: SubagentParamsLike, ownerSessionId: string, events?: IntercomEventBus): SubagentExecutionResult {
	if (result.isError && !result.content.some((item) => item.type === "text" && /No interrupt-capable run|No running async run|has no (active|running) child at index \d+/.test(item.text))) return result;
	const id = result.details.managementControl?.runId ?? params.id ?? params.runId;
	if (!id) return result;
	const questions = listSupervisorQuestions(ownerSessionId, id).filter((question) => (params.index === undefined || params.index === question.index) && (question.state === "awaiting_input" || question.state === "answer_pending"));
	if (!questions.length) return result;
	for (const question of questions) {
		cancelSupervisorQuestion(question);
		events?.emit("subagent:supervisor-question-resolved", { questionId: question.questionId });
	}
	const cancelled = questions.map((question) => readQuestionState(question));
	return result.isError ? questionResult(cancelled, `Cancelled ${questions.length} pending supervisor question(s). Any live waiter will abort its agent; cancellation is requested, not proof of process exit.`)
		: { ...result, details: { ...result.details, questions: cancelled } };
}

export function controlSupervisorQuestion(input: { params: SubagentParamsLike; requestCwd: string; ctx: ExtensionContext; deps: ExecutorDeps }): SubagentExecutionResult {
	try {
		const { params } = input;
		const id = params.id ?? params.runId;
		if (params.dir !== undefined) throw new Error("questions/answer use a run id, not dir.");
		if (params.index !== undefined && (!Number.isSafeInteger(params.index) || params.index < 0)) throw new Error("index must be a non-negative integer.");
		const questions = listSupervisorQuestions(input.ctx.sessionManager.getSessionId(), id)
			.filter((question) => params.index === undefined || question.index === params.index);
		if (params.action === "questions") return questionResult(questions, formatSupervisorQuestions(questions, Boolean(nestedResolutionScopeForExecutor(input.deps))));
		if (!id || !params.questionId) throw new Error("action='answer' requires id and questionId.");
		const question = questions.find((entry) => entry.questionId === params.questionId);
		if (!question) throw new Error("Question not found in this session's runs. Resume the owning supervisor session to answer it.");
		const answer = saveQuestionAnswer(question, params.message ?? "", undefined, params.messageOrigin);
		input.deps.pi.events.emit("subagent:supervisor-question-resolved", { questionId: question.questionId });
		if (!question.delivery && questionProcessAlive(question)) return questionResult([readQuestionState(question)], [`Answer saved for question ${question.questionId}. The live child will read it from the durable waiter; delivery is pending, not execution completion.`, liveLaunchOverrideNotice(params)].filter(Boolean).join("\n"));
		const delivery = readQuestionState(question).delivery;
		if (delivery) return questionResult([readQuestionState(question)], `Question ${question.questionId} was already answered; no new work started. Delivery: ${delivery.kind}, run: ${delivery.runId}.`);
		const claim = claimQuestionRevival(question);
		if (!claim.claimed) return questionResult([readQuestionState(question)], `Answer retained for question ${question.questionId}; continuation ${claim.runId} was already requested. No duplicate process started. Inspect that run first. ${questionRecoveryHint(question, Boolean(nestedResolutionScopeForExecutor(input.deps)))}`);
		const result = reviveSavedSubagent({ ...input, params: { ...params, message: `${answer.origin === "human" ? "Direct user answer (human origin)" : "Supervisor answer"} to question ${question.questionId}:\n\n${answer.message}\n\nOriginal question:\n${question.message}` } }, { ...question, source: "question" }, claim.runId);
		if (result.isError) {
			releaseQuestionRevival(question);
			return { ...result, details: { ...result.details, questions: [readQuestionState(question)] } };
		}
		recordQuestionDelivery(question, { kind: "revive", runId: claim.runId, deliveredAt: Date.now() });
		return { ...result, details: { ...result.details, questions: [readQuestionState(question)] } };
	} catch (error) {
		return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "management", results: [] } };
	}
}
