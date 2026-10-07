import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { formatRunAction } from "../../shared/status-format.ts";
import { NativeJournal, ownerProjection, readJsonProjection } from "../../shared/journal-reader.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { runCooperatively, runSynchronously } from "../../shared/cooperative.ts";
import { ASYNC_DIR, TEMP_ROOT_DIR, type AsyncStatus, type AsyncResultFile, type ResolvedAcceptanceConfig, type JsonSchemaObject, type OutputMode, type SavedLaunchConfig, type SingleResult, type AgentProgress } from "../../shared/types.ts";

export const LEGACY_QUESTIONS_DIR = path.join(TEMP_ROOT_DIR, "supervisor-questions");
export const QUESTIONS_DIR = path.join(getAgentDir(), "sessions", "subagent-runs");

export interface SupervisorRunContract {
	legacySource?: string;
	recordVersion?: 3;
	nativeSessionId?: string;
	terminalLeafId?: string | null;
	terminalEntryId?: string;
	attemptBaseline?: string[];
	baselineSource?: "native-migration";
	effectiveConfiguration?: { model?: string; thinking?: string; modelRecordedAt?: number };
	accounting?: { state: "complete" | "incomplete"; error?: string };
	auditPath?: string;
	task?: string;
	label?: string;
	result?: SingleResult;
	effectiveAcceptance?: ResolvedAcceptanceConfig;
	output?: string | false;
	outputMode?: OutputMode;
	outputSchema?: JsonSchemaObject;
	launch?: SavedLaunchConfig;
	/** Kept independently of progress, which is compacted away or stops streaming after detachment. */
	modelSelection?: Pick<AgentProgress, "model" | "thinking" | "modelStartedAt">;
	sessionFile?: string;
	pid?: number;
	processIdentity?: string;
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

export interface SupervisorQuestionSummary extends Pick<SupervisorQuestionView,
	"questionId" | "runId" | "ownerSessionId" | "ownerTarget" | "agent" | "index" | "childSessionId" | "childTarget" |
	"sessionFile" | "cwd" | "pid" | "processIdentity" | "createdAt" | "reason" | "message" | "state" | "answer" | "delivery" | "revival"> {
	questionPath: string;
	answerPath?: string;
	messageTruncated?: boolean;
	answerTruncated?: boolean;
	hasInterview?: boolean;
}

export function summarizeSupervisorQuestion(question: SupervisorQuestionView): SupervisorQuestionSummary {
	const directory = questionDir(question);
	return {
		questionId: question.questionId, runId: question.runId, ownerSessionId: question.ownerSessionId, ownerTarget: question.ownerTarget,
		agent: question.agent, index: question.index, childSessionId: question.childSessionId, childTarget: question.childTarget,
		sessionFile: question.sessionFile, cwd: question.cwd, pid: question.pid, processIdentity: question.processIdentity,
		createdAt: question.createdAt, reason: question.reason, state: question.state, message: question.message.slice(0, 2048),
		questionPath: path.join(directory, "question.json"),
		...(question.message.length > 2048 ? { messageTruncated: true } : {}),
		...(question.interview ? { hasInterview: true } : {}),
		...(question.answer ? { answer: { message: question.answer.message.slice(0, 2048), answeredAt: question.answer.answeredAt, origin: question.answer.origin },
			answerPath: path.join(directory, "answer.json"), ...(question.answer.message.length > 2048 ? { answerTruncated: true } : {}) } : {}),
		...(question.delivery ? { delivery: { kind: question.delivery.kind, runId: question.delivery.runId, deliveredAt: question.delivery.deliveredAt } } : {}),
		...(question.revival ? { revival: { runId: question.revival.runId, pid: question.revival.pid, startedAt: question.revival.startedAt } } : {}),
	};
}

export function supervisorQuestionPage(questions: SupervisorQuestionView[], options: { offset?: number; limit?: number } = {}): {
	questions: SupervisorQuestionSummary[];
	questionList: { total: number; offset: number; limit: number; nextOffset?: number };
} {
	const offset = options.offset ?? 0, limit = options.limit ?? 20;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Question offset must be a non-negative integer.");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Question limit must be from 1 to 100.");
	const pending = (question: SupervisorQuestionView) => question.state === "awaiting_input" || question.state === "answer_pending" ? 0 : 1;
	const sorted = questions.toSorted((a, b) => pending(a) - pending(b) || a.createdAt - b.createdAt || a.questionId.localeCompare(b.questionId));
	return { questions: sorted.slice(offset, offset + limit).map((question) => summarizeSupervisorQuestion(question)),
		questionList: { total: questions.length, offset, limit, ...(offset + limit < questions.length ? { nextOffset: offset + limit } : {}) } };
}

function safeId(value: string): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid run or question ID.");
	return value;
}

export function getRunMetadataDir(runId: string, root = QUESTIONS_DIR): string {
	return path.join(root, safeId(runId));
}

export function saveAsyncRunResult(runId: string, result: AsyncResultFile): AsyncResultFile {
	const file = path.join(getRunMetadataDir(runId), "result.json");
	const previous = readRunJson<AsyncResultFile>(file);
	if (previous?.completionId && result.completionId && previous.completionId !== result.completionId) throw new Error("Conflicting completion identity");
	const saved = { ...result, recordVersion: 3 as const, completionId: previous?.completionId ?? result.completionId ?? randomUUID(),
		...(preserveLegacyOwner(file, previous) ? { legacySource: `${file}.legacy` } : {}),
		results: result.results?.map((child, index) => compactOwnerResult(runId, index, child)) };
	writeAtomicJson(file, saved);
	return saved;
}

function preserveLegacyOwner(file: string, previous: { recordVersion?: number } | undefined): boolean {
	if (!previous || previous.recordVersion === 3) return false;
	try { fs.copyFileSync(file, `${file}.legacy`, fs.constants.COPYFILE_EXCL); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	return true;
}

export function compactOwnerResult<T extends { finalOutput?: string; output?: string; initialOutput?: string; initialOutputPath?: string; messages?: unknown; artifactPaths?: { outputPath?: string }; fullOutputPath?: string }>(runId: string, index: number, result: T, root = QUESTIONS_DIR): T {
	const output = result.finalOutput ?? result.output;
	let fullOutputPath = result.fullOutputPath;
	if (output && output.length > 8192) {
		fullOutputPath ??= result.artifactPaths?.outputPath;
		if (!fullOutputPath) {
			fullOutputPath = path.join(getRunMetadataDir(runId, root), "outputs", `${index}.txt`);
			fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });
			fs.writeFileSync(fullOutputPath, output, { mode: 0o600 });
		}
	}
	let initialOutputPath = result.initialOutputPath;
	if (result.initialOutput && result.initialOutput.length > 8192 && !initialOutputPath) {
		initialOutputPath = path.join(getRunMetadataDir(runId, root), "outputs", `${index}.initial.txt`);
		fs.mkdirSync(path.dirname(initialOutputPath), { recursive: true });
		fs.writeFileSync(initialOutputPath, result.initialOutput, { mode: 0o600 });
	}
	return { ...result, messages: undefined, ...(fullOutputPath ? { fullOutputPath } : {}),
		...(initialOutputPath ? { initialOutputPath } : {}),
		...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput.slice(-8192) } : {}),
		...(result.output !== undefined ? { output: result.output.slice(-8192) } : {}),
		...(result.initialOutput !== undefined ? { initialOutput: result.initialOutput.slice(-8192) } : {}) };
}

export function saveRunStatus(runId: string, status: AsyncStatus): void {
	writeAtomicJson(path.join(getRunMetadataDir(runId), "status.json"), status);
}

export function readRunJson<T>(file: string): T | undefined {
	try {
		return readJsonProjection(file, ownerProjection) as T;
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
	const file = path.join(root, safeId(runId), "contracts", `${index}.json`);
	const previous = readRunJson<SupervisorRunContract>(file);
	writeAtomicJson(file, { ...previous, ...contract, recordVersion: 3,
		...(preserveLegacyOwner(file, previous) ? { legacySource: `${file}.legacy` } : {}),
		...(previous?.attemptBaseline && contract.baselineSource !== "native-migration" ? { attemptBaseline: previous.attemptBaseline } : {}),
		...(contract.result ? { result: compactOwnerResult(runId, index, contract.result, root) } : {}),
		...(previous?.launch ? { launch: previous.launch } : {}) });
}

export function readQuestionContract(runId: string, index: number, root = QUESTIONS_DIR, projection: { sessionFile?: string; endedAt?: number; readConfiguration?: false } = {}): SupervisorRunContract | undefined {
	const contract = readRunJson<SupervisorRunContract>(path.join(root, safeId(runId), "contracts", `${index}.json`));
	if (!contract?.launch || projection.readConfiguration === false) return contract;
	const sessionFile = projection.sessionFile ?? contract.sessionFile;
	if (contract.recordVersion !== 3 && !contract.effectiveConfiguration && sessionFile && fs.existsSync(sessionFile) && !contract.launch.model?.startsWith("claude-code/")) {
		// One-time read-only native recovery. Subsequent controls use the compact
		// selection, and the frozen requested profile is never rewritten.
		const journal = new NativeJournal(sessionFile, "inspect", true);
		contract.effectiveConfiguration = journal.configuration(projection.endedAt, contract.terminalLeafId);
		saveQuestionContract(runId, index, { effectiveConfiguration: contract.effectiveConfiguration }, root);
	}
	const native = contract.effectiveConfiguration ?? {};
	return { ...contract, launch: { ...contract.launch, ...native } };
}

export function migrateSupervisorQuestions(ownerSessionId: string, runId?: string): void {
	runSynchronously(migrateSupervisorQuestionSteps(ownerSessionId, runId));
}

export function* migrateSupervisorQuestionSteps(ownerSessionId: string, runId?: string): Generator<void> {
	if (!fs.existsSync(LEGACY_QUESTIONS_DIR)) return;
	const runs = runId === undefined ? fs.readdirSync(LEGACY_QUESTIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [safeId(runId)];
	for (const id of runs) {
		yield;
		try {
			const source = getRunMetadataDir(id, LEGACY_QUESTIONS_DIR);
			const owner = readRunJson<{ sessionId?: string }>(path.join(source, "question-owner.json"));
			if (owner?.sessionId !== ownerSessionId) continue;
			fs.cpSync(source, getRunMetadataDir(id), { recursive: true, force: false });
		} catch (error) {
			if (runId !== undefined) throw error;
			console.error(`Could not recover legacy questions for ${id}: ${String(error)}`);
		}
	}
}

export function createSupervisorQuestion(input: Omit<SupervisorQuestion, "questionId" | "createdAt" | "ownerSessionId">, root = QUESTIONS_DIR): SupervisorQuestion {
	const runDir = path.join(root, safeId(input.runId));
	const status = readRunJson<AsyncStatus>(path.join(runDir, "status.json"))
		?? (root === QUESTIONS_DIR ? readRunJson<AsyncStatus>(path.join(ASYNC_DIR, safeId(input.runId), "status.json")) : undefined);
	const owner = readRunJson<{ sessionId: string }>(path.join(runDir, "question-owner.json")) ?? status;
	if (!owner?.sessionId) throw new Error(`Run ${input.runId} has no saved question owner; cannot create a recoverable supervisor question.`);
	if (!input.sessionFile || path.extname(input.sessionFile) !== ".jsonl") throw new Error("Supervisor questions require a saved child session.");
	if (!Number.isSafeInteger(input.index) || input.index < 0) throw new Error("Child index must be a non-negative integer.");
	if (!input.message.trim()) throw new Error("Supervisor question must not be empty.");
	const contract = readQuestionContract(input.runId, input.index, root, { sessionFile: input.sessionFile })
		?? { effectiveAcceptance: status?.steps?.[input.index]?.acceptance?.effectiveAcceptance };
	const question = { ...input, ...contract, sessionFile: input.sessionFile, pid: input.pid, ownerSessionId: owner.sessionId, questionId: randomUUID(), createdAt: Date.now() };
	writeAtomicJson(path.join(questionDir(question, root), "question.json"), question);
	return question;
}

function questionStatePaths(question: SupervisorQuestion, file: string, root: string): string[] {
	const current = path.join(questionDir(question, root), file);
	const legacy = questionDir(question, LEGACY_QUESTIONS_DIR);
	// Old waiters still claim the legacy file; both runtimes must compete on that same inode.
	return root === QUESTIONS_DIR && fs.existsSync(path.join(legacy, "question.json")) ? [path.join(legacy, file), current] : [current];
}

function writeQuestionStateOnce(question: SupervisorQuestion, file: string, value: object, root: string): boolean {
	const [primary, ...mirrors] = questionStatePaths(question, file, root);
	const written = writeOnce(primary!, value);
	const winner = written ? value : readRunJson<object>(primary!)!;
	for (const target of mirrors) writeOnce(target, winner);
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

/** Known run IDs need neither a global directory walk nor prefix resolution. */
export function listOwnedRunQuestions(ownerSessionId: string, runId: string): SupervisorQuestionView[] {
	migrateSupervisorQuestions(ownerSessionId, runId);
	return listRunQuestions(getRunMetadataDir(runId)).filter((question) => question.ownerSessionId === ownerSessionId);
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
	return runSynchronously(supervisorQuestionSteps(ownerSessionId, runId, root));
}

export function listSupervisorQuestionsAsync(ownerSessionId: string): Promise<SupervisorQuestionView[]> {
	return runCooperatively(supervisorQuestionSteps(ownerSessionId));
}

function* supervisorQuestionSteps(ownerSessionId: string, runId?: string, root = QUESTIONS_DIR): Generator<void, SupervisorQuestionView[]> {
	if (runId !== undefined) safeId(runId);
	if (root === QUESTIONS_DIR) yield* migrateSupervisorQuestionSteps(ownerSessionId);
	if (!fs.existsSync(root)) return [];
	const runs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && (!runId || entry.name.startsWith(runId)));
	const questions: SupervisorQuestionView[] = [];
	for (const entry of runs) {
		yield;
		try { questions.push(...listRunQuestions(path.join(root, entry.name)).filter((question) => question.ownerSessionId === ownerSessionId)); }
		catch (error) {
			if (runId !== undefined) throw error;
			console.error(`Could not list questions for ${entry.name}: ${String(error)}`);
		}
	}
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

export function formatSupervisorQuestions(questions: SupervisorQuestionSummary[], childSafe = false): string {
	if (!questions.length) return "No supervisor questions owned by this session.";
	return questions.map((question) => [
		`Question: ${question.questionId} | ${question.state}`,
		`Run: ${question.runId} | Child: ${question.index} (${question.agent}) | Owner: ${question.ownerSessionId}`,
		`Session: ${question.sessionFile} | Child target: ${question.childTarget}`,
		question.message,
		...(question.messageTruncated ? [`[Question preview truncated. Full question: ${question.questionPath}]`] : []),
		...(question.hasInterview ? [`Structured interview: ${question.questionPath}`] : []),
		...(question.answer ? [`Saved answer: ${question.answer.message}`, ...(question.answerTruncated ? [`[Answer preview truncated. Exact saved answer: ${question.answerPath}]`] : [])] : []),
		...(question.revival && !question.delivery ? [`Continuation requested: ${question.revival.runId}; delivery unconfirmed. Answer retained.`, questionRecoveryHint(question, childSafe)] : []),
		question.delivery ? `Answer delivered via ${question.delivery.kind}; run: ${question.delivery.runId}`
			: question.state === "cancelled" ? "Question cancelled; use continue for a new follow-up."
			: question.answerTruncated ? `Retry answer with the exact saved message from ${question.answerPath}; a preview is not a valid replacement.`
			: `Answer: ${formatRunAction("answer", question.runId, { questionId: question.questionId, message: question.answer?.message ?? "..." }, childSafe)}`,
	].join("\n")).join("\n\n");
}
