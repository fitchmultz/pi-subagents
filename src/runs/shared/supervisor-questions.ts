import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { formatRunAction } from "../../shared/status-format.ts";
import { buildSessionContext, parseSessionEntries } from "../../shared/native-session.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { ASYNC_DIR, TEMP_ROOT_DIR, type AsyncStatus, type AsyncResultFile, type ResolvedAcceptanceConfig, type JsonSchemaObject, type OutputMode, type SavedLaunchConfig, type SingleResult } from "../../shared/types.ts";

export const LEGACY_QUESTIONS_DIR = path.join(TEMP_ROOT_DIR, "supervisor-questions");
export const QUESTIONS_DIR = path.join(getAgentDir(), "sessions", "subagent-runs");

export interface SupervisorRunContract {
	task?: string;
	label?: string;
	result?: SingleResult;
	effectiveAcceptance?: ResolvedAcceptanceConfig;
	output?: string | false;
	outputMode?: OutputMode;
	outputSchema?: JsonSchemaObject;
	launch?: SavedLaunchConfig;
	sessionFile?: string;
	pid?: number;
	updatedAt?: number;
}

export interface SupervisorQuestion extends SupervisorRunContract {
	questionId: string;
	runId: string;
	ownerSessionId: string;
	ownerTarget: string;
	agent: string;
	index: number;
	childSessionId: string;
	childTarget: string;
	sessionFile: string;
	cwd: string;
	pid: number;
	createdAt: number;
	reason: "need_decision" | "interview_request";
	message: string;
	interview?: unknown;
}

export interface QuestionAnswer {
	message: string;
	answeredAt: number;
	origin?: "human";
}

export interface QuestionDelivery {
	kind: "live" | "revive";
	runId: string;
	deliveredAt: number;
}

export interface SupervisorQuestionView extends SupervisorQuestion {
	state: "awaiting_input" | "answer_pending" | "answered" | "cancelled";
	answer?: QuestionAnswer;
	delivery?: QuestionDelivery;
	revival?: { runId: string; pid: number; startedAt: number };
}

function safeId(value: string): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid run or question ID.");
	return value;
}

export function getRunMetadataDir(runId: string, root = QUESTIONS_DIR): string {
	return path.join(root, safeId(runId));
}

export function saveAsyncRunResult(runId: string, result: AsyncResultFile): void {
	writeAtomicJson(path.join(getRunMetadataDir(runId), "result.json"), result);
}

export function saveRunStatus(runId: string, status: AsyncStatus): void {
	writeAtomicJson(path.join(getRunMetadataDir(runId), "status.json"), status);
}

export function readRunJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function questionDir(question: Pick<SupervisorQuestion, "runId" | "questionId">, root = QUESTIONS_DIR): string {
	return path.join(root, safeId(question.runId), "questions", safeId(question.questionId));
}

// Atomic publication without replacement: concurrent answers/launches have exactly one winner.
function writeOnce(file: string, value: object): boolean {
	const temporary = `${file}.${randomUUID()}.tmp`;
	writeAtomicJson(temporary, value);
	try {
		fs.linkSync(temporary, file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

export function saveQuestionOwner(runId: string, sessionId: string, root = QUESTIONS_DIR): void {
	writeAtomicJson(path.join(root, safeId(runId), "question-owner.json"), { sessionId });
}

export function saveQuestionContract(runId: string, index: number, contract: SupervisorRunContract, root = QUESTIONS_DIR): void {
	if (!Number.isSafeInteger(index) || index < 0) throw new Error("Child index must be a non-negative integer.");
	writeAtomicJson(path.join(root, safeId(runId), "contracts", `${index}.json`), { ...readQuestionContract(runId, index, root), ...contract });
}

export function readQuestionContract(runId: string, index: number, root = QUESTIONS_DIR): SupervisorRunContract | undefined {
	return readRunJson<SupervisorRunContract>(path.join(root, safeId(runId), "contracts", `${index}.json`));
}

export function readNativeSessionConfiguration(sessionFile: string | undefined): { model?: string; thinking?: string } {
	if (!sessionFile || !fs.existsSync(sessionFile)) return {};
	const entries = parseSessionEntries(fs.readFileSync(sessionFile, "utf8"));
	if (entries[0]?.type !== "session") return {};
	const context = buildSessionContext(entries.filter((entry) => entry.type !== "session"));
	return { ...(context.model ? { model: `${context.model.provider}/${context.model.modelId}` } : {}), ...(entries.some((entry) => entry.type === "thinking_level_change") ? { thinking: context.thinkingLevel } : {}) };
}

export function refreshQuestionLaunch(runId: string, index: number, sessionFile: string | undefined): void {
	if (!runId) return;
	const contract = readQuestionContract(runId, index);
	if (!contract?.launch) return;
	const native = readNativeSessionConfiguration(sessionFile);
	saveQuestionContract(runId, index, { ...contract, sessionFile: sessionFile ?? contract.sessionFile, launch: { ...contract.launch, ...native } });
}

export function migrateSupervisorQuestions(ownerSessionId: string): void {
	if (!fs.existsSync(LEGACY_QUESTIONS_DIR)) return;
	for (const entry of fs.readdirSync(LEGACY_QUESTIONS_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const source = getRunMetadataDir(entry.name, LEGACY_QUESTIONS_DIR);
		const owner = readRunJson<{ sessionId?: string }>(path.join(source, "question-owner.json"));
		if (owner?.sessionId !== ownerSessionId) continue;
		fs.cpSync(source, getRunMetadataDir(entry.name), { recursive: true, force: false });
	}
}

export function createSupervisorQuestion(input: Omit<SupervisorQuestion, "questionId" | "createdAt" | "ownerSessionId">, root = QUESTIONS_DIR): SupervisorQuestion {
	const runDir = path.join(root, safeId(input.runId));
	const status = root === QUESTIONS_DIR ? readRunJson<AsyncStatus>(path.join(ASYNC_DIR, safeId(input.runId), "status.json")) : undefined;
	const owner = readRunJson<{ sessionId: string }>(path.join(runDir, "question-owner.json")) ?? status;
	if (!owner?.sessionId) throw new Error(`Run ${input.runId} has no saved question owner; cannot create a recoverable supervisor question.`);
	if (!input.sessionFile || path.extname(input.sessionFile) !== ".jsonl") throw new Error("Supervisor questions require a saved child session.");
	if (!Number.isSafeInteger(input.index) || input.index < 0) throw new Error("Child index must be a non-negative integer.");
	if (!input.message.trim()) throw new Error("Supervisor question must not be empty.");
	if (root === QUESTIONS_DIR) refreshQuestionLaunch(input.runId, input.index, input.sessionFile);
	const contract = readQuestionContract(input.runId, input.index, root)
		?? { effectiveAcceptance: status?.steps?.[input.index]?.acceptance?.effectiveAcceptance };
	const question = { ...input, ...contract, ownerSessionId: owner.sessionId, questionId: randomUUID(), createdAt: Date.now() };
	writeAtomicJson(path.join(questionDir(question, root), "question.json"), question);
	return question;
}

function questionStatePaths(question: SupervisorQuestion, file: string, root: string): string[] {
	const current = path.join(questionDir(question, root), file);
	const legacy = questionDir(question, LEGACY_QUESTIONS_DIR);
	return root === QUESTIONS_DIR && fs.existsSync(path.join(legacy, "question.json")) ? [current, path.join(legacy, file)] : [current];
}

function writeQuestionStateOnce(question: SupervisorQuestion, file: string, value: object, root: string): boolean {
	const [current, ...legacy] = questionStatePaths(question, file, root);
	const written = writeOnce(current!, value);
	for (const target of legacy) writeOnce(target, value);
	return written;
}

export function readQuestionState(question: SupervisorQuestion, root = QUESTIONS_DIR): SupervisorQuestionView {
	const read = <T>(file: string): T | undefined => questionStatePaths(question, file, root).map((entry) => readRunJson<T>(entry)).find((entry) => entry !== undefined);
	const answer = read<QuestionAnswer>("answer.json");
	const delivery = read<QuestionDelivery>("delivery.json");
	const cancelled = read("cancelled.json") !== undefined;
	const revival = read<SupervisorQuestionView["revival"]>("revival.json");
	return { ...question, state: delivery ? "answered" : cancelled ? "cancelled" : answer ? "answer_pending" : "awaiting_input", ...(answer ? { answer } : {}), ...(delivery ? { delivery } : {}), ...(revival ? { revival } : {}) };
}

export function listRunQuestions(runDir: string): SupervisorQuestionView[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(runDir, "questions"), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries.filter((entry) => entry.isDirectory()).flatMap((entry) => {
		const question = readRunJson<SupervisorQuestion>(path.join(runDir, "questions", entry.name, "question.json"));
		return question ? [readQuestionState(question, path.dirname(runDir))] : [];
	});
}

export function pendingSupervisorQuestion(input: { runId: string; agent: string; index: number; sessionFile?: string; pid?: number }): import("../../shared/types.ts").ControlEvent["supervisorQuestion"] {
	if (!input.sessionFile) return undefined;
	try {
		const pid = input.pid ?? readQuestionContract(input.runId, input.index)?.pid;
		const question = listRunQuestions(getRunMetadataDir(input.runId)).find((question) =>
			question.runId === input.runId && question.agent === input.agent && question.index === input.index
			&& question.sessionFile === input.sessionFile && question.pid === pid
			&& (question.state === "awaiting_input" || question.state === "answer_pending"));
		if (question && (question.state === "awaiting_input" || question.state === "answer_pending")) return {
			questionId: question.questionId, state: question.state, ...(question.answer ? { answer: question.answer.message } : {}),
		};
	} catch (error) {
		console.error(`Could not read supervisor wait for ${input.runId}:${input.index}:`, error);
	}
	return undefined;
}

export function listSupervisorQuestions(ownerSessionId: string, runId?: string, root = QUESTIONS_DIR): SupervisorQuestionView[] {
	if (runId !== undefined) safeId(runId);
	if (root === QUESTIONS_DIR) migrateSupervisorQuestions(ownerSessionId);
	if (!fs.existsSync(root)) return [];
	const runs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && (!runId || entry.name.startsWith(runId)));
	const questions = runs.flatMap((entry) => listRunQuestions(path.join(root, entry.name))).filter((question) => question.ownerSessionId === ownerSessionId);
	if (runId && new Set(questions.map((question) => question.runId)).size > 1) throw new Error(`Ambiguous run ID prefix '${runId}'.`);
	return questions.sort((a, b) => a.createdAt - b.createdAt);
}

export function saveQuestionAnswer(question: SupervisorQuestion, message: string, root = QUESTIONS_DIR, origin?: "human"): QuestionAnswer {
	if (typeof message !== "string" || !message.trim()) throw new Error("action='answer' requires a non-empty message.");
	const state = readQuestionState(question, root);
	if (state.state === "cancelled") throw new Error(`Question ${question.questionId} was cancelled. Use continue for a new follow-up.`);
	const answer: QuestionAnswer = { message: message.trim(), answeredAt: state.answer?.answeredAt ?? Date.now(), ...(state.answer?.origin ?? origin ? { origin: state.answer?.origin ?? origin } : {}) };
	if (state.answer && state.answer.message !== answer.message) throw new Error(`Question ${question.questionId} already has a different saved answer. The original answer was retained.`);
	if (writeQuestionStateOnce(question, "answer.json", answer, root)) return answer;
	const existing = readQuestionState(question, root).answer!;
	if (existing.message !== answer.message) throw new Error(`Question ${question.questionId} already has a different saved answer. The original answer was retained.`);
	return existing;
}

export function recordQuestionDelivery(question: SupervisorQuestion, delivery: QuestionDelivery, root = QUESTIONS_DIR): void {
	writeQuestionStateOnce(question, "delivery.json", delivery, root);
}

export function cancelSupervisorQuestion(question: SupervisorQuestion, root = QUESTIONS_DIR): void {
	writeQuestionStateOnce(question, "cancelled.json", { cancelledAt: Date.now() }, root);
}

export function questionProcessAlive(question: Pick<SupervisorQuestion, "pid">): boolean {
	if (!Number.isSafeInteger(question.pid) || question.pid <= 0) throw new Error("Invalid child process ID.");
	try {
		process.kill(question.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function claimQuestionRevival(question: SupervisorQuestion, root = QUESTIONS_DIR): { claimed: boolean; runId: string } {
	const runId = `answer-${question.questionId}`;
	if (readQuestionState(question, root).revival) return { claimed: false, runId };
	return { claimed: writeQuestionStateOnce(question, "revival.json", { runId, pid: process.pid, startedAt: Date.now() }, root), runId };
}

export function releaseQuestionRevival(question: SupervisorQuestion, root = QUESTIONS_DIR): void {
	for (const file of questionStatePaths(question, "revival.json", root)) fs.rmSync(file, { force: true });
}

export function questionRecoveryHint(question: SupervisorQuestion, childSafe = false): string {
	return `Recover an unlaunched continuation: ${formatRunAction("resume", question.runId, { index: question.index, message: "Continue with the saved supervisor answer." }, childSafe)}`;
}

export function formatSupervisorQuestions(questions: SupervisorQuestionView[], childSafe = false): string {
	if (!questions.length) return "No supervisor questions owned by this session.";
	return questions.map((question) => [
		`Question: ${question.questionId} | ${question.state}`,
		`Run: ${question.runId} | Child: ${question.index} (${question.agent}) | Owner: ${question.ownerSessionId}`,
		`Session: ${question.sessionFile} | Child target: ${question.childTarget}`,
		question.message,
		...(question.answer ? [`Saved answer: ${question.answer.message}`] : []),
		...(question.revival && !question.delivery ? [`Continuation requested: ${question.revival.runId}; delivery unconfirmed. Answer retained.`, questionRecoveryHint(question, childSafe)] : []),
		question.delivery ? `Answer delivered via ${question.delivery.kind}; run: ${question.delivery.runId}`
			: question.state === "cancelled" ? "Question cancelled; use continue for a new follow-up."
			: `Answer: ${formatRunAction("answer", question.runId, { questionId: question.questionId, message: question.answer?.message ?? "..." }, childSafe)}`,
	].join("\n")).join("\n\n");
}
