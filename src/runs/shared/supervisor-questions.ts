import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { ASYNC_DIR, TEMP_ROOT_DIR, type AsyncStatus, type ResolvedAcceptanceConfig } from "../../shared/types.ts";

export const QUESTIONS_DIR = path.join(TEMP_ROOT_DIR, "supervisor-questions");

export interface SupervisorQuestion {
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
	effectiveAcceptance?: ResolvedAcceptanceConfig;
}

export interface QuestionAnswer {
	message: string;
	answeredAt: number;
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

function readJson<T>(file: string): T | undefined {
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

export function createSupervisorQuestion(input: Omit<SupervisorQuestion, "questionId" | "createdAt" | "ownerSessionId">, root = QUESTIONS_DIR): SupervisorQuestion {
	const runDir = path.join(root, safeId(input.runId));
	const status = root === QUESTIONS_DIR ? readJson<AsyncStatus>(path.join(ASYNC_DIR, safeId(input.runId), "status.json")) : undefined;
	const owner = readJson<{ sessionId: string }>(path.join(runDir, "question-owner.json")) ?? status;
	if (!owner?.sessionId) throw new Error(`Run ${input.runId} has no saved question owner; cannot create a recoverable supervisor question.`);
	if (!input.sessionFile || path.extname(input.sessionFile) !== ".jsonl") throw new Error("Supervisor questions require a saved child session.");
	if (!Number.isSafeInteger(input.index) || input.index < 0) throw new Error("Child index must be a non-negative integer.");
	if (!input.message.trim()) throw new Error("Supervisor question must not be empty.");
	const effectiveAcceptance = status?.steps?.[input.index]?.acceptance?.effectiveAcceptance;
	const question = { ...input, ownerSessionId: owner.sessionId, questionId: randomUUID(), createdAt: Date.now(), ...(effectiveAcceptance ? { effectiveAcceptance } : {}) };
	writeAtomicJson(path.join(questionDir(question, root), "question.json"), question);
	return question;
}

export function readQuestionState(question: SupervisorQuestion, root = QUESTIONS_DIR): SupervisorQuestionView {
	const dir = questionDir(question, root);
	const answer = readJson<QuestionAnswer>(path.join(dir, "answer.json"));
	const delivery = readJson<QuestionDelivery>(path.join(dir, "delivery.json"));
	const cancelled = fs.existsSync(path.join(dir, "cancelled.json"));
	const revival = readJson<SupervisorQuestionView["revival"]>(path.join(dir, "revival.json"));
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
		const question = readJson<SupervisorQuestion>(path.join(runDir, "questions", entry.name, "question.json"));
		return question ? [readQuestionState(question, path.dirname(runDir))] : [];
	});
}

export function listSupervisorQuestions(ownerSessionId: string, runId?: string, root = QUESTIONS_DIR): SupervisorQuestionView[] {
	if (runId !== undefined) safeId(runId);
	if (!fs.existsSync(root)) return [];
	const runs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && (!runId || entry.name.startsWith(runId)));
	const questions = runs.flatMap((entry) => listRunQuestions(path.join(root, entry.name))).filter((question) => question.ownerSessionId === ownerSessionId);
	if (runId && new Set(questions.map((question) => question.runId)).size > 1) throw new Error(`Ambiguous run ID prefix '${runId}'.`);
	return questions.sort((a, b) => a.createdAt - b.createdAt);
}

export function saveQuestionAnswer(question: SupervisorQuestion, message: string, root = QUESTIONS_DIR): QuestionAnswer {
	if (typeof message !== "string" || !message.trim()) throw new Error("action='answer' requires a non-empty message.");
	if (readQuestionState(question, root).state === "cancelled") throw new Error(`Question ${question.questionId} was cancelled. Use continue for a new follow-up.`);
	const answer = { message: message.trim(), answeredAt: Date.now() };
	const file = path.join(questionDir(question, root), "answer.json");
	if (writeOnce(file, answer)) return answer;
	const existing = readJson<QuestionAnswer>(file)!;
	if (existing.message !== answer.message) throw new Error(`Question ${question.questionId} already has a different saved answer. The original answer was retained.`);
	return existing;
}

export function recordQuestionDelivery(question: SupervisorQuestion, delivery: QuestionDelivery, root = QUESTIONS_DIR): void {
	writeOnce(path.join(questionDir(question, root), "delivery.json"), delivery);
}

export function cancelSupervisorQuestion(question: SupervisorQuestion, root = QUESTIONS_DIR): void {
	writeOnce(path.join(questionDir(question, root), "cancelled.json"), { cancelledAt: Date.now() });
}

export function questionProcessAlive(question: Pick<SupervisorQuestion, "pid">): boolean {
	try {
		process.kill(question.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function claimQuestionRevival(question: SupervisorQuestion, root = QUESTIONS_DIR): { claimed: boolean; runId: string } {
	const runId = `answer-${question.questionId}`;
	const file = path.join(questionDir(question, root), "revival.json");
	return { claimed: writeOnce(file, { runId, pid: process.pid, startedAt: Date.now() }), runId };
}

export function releaseQuestionRevival(question: SupervisorQuestion, root = QUESTIONS_DIR): void {
	fs.rmSync(path.join(questionDir(question, root), "revival.json"), { force: true });
}

export function formatSupervisorQuestions(questions: SupervisorQuestionView[]): string {
	if (!questions.length) return "No supervisor questions owned by this session.";
	return questions.map((question) => [
		`Question: ${question.questionId} | ${question.state}`,
		`Run: ${question.runId} | Child: ${question.index} (${question.agent}) | Owner: ${question.ownerSessionId}`,
		`Session: ${question.sessionFile} | Child target: ${question.childTarget}`,
		question.message,
		...(question.answer ? [`Saved answer: ${question.answer.message}`] : []),
		...(question.revival && !question.delivery ? [`Continuation requested: ${question.revival.runId}; delivery unconfirmed. Answer retained.`] : []),
		question.delivery ? `Answer delivered via ${question.delivery.kind}; run: ${question.delivery.runId}`
			: question.state === "cancelled" ? "Question cancelled; use continue for a new follow-up."
			: `Answer: agent_runs({ action: "answer", id: "${question.runId}", questionId: "${question.questionId}", message: "..." })`,
	].join("\n")).join("\n\n");
}
