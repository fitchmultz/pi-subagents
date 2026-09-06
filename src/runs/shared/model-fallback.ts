import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { ModelAttempt, ResourceLimitExceeded, Usage } from "../../shared/types.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/usage\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/database is locked/i,
	/\bsqlite_busy\b/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
];

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

const NON_RECOVERABLE_SAME_MODEL_PATTERNS = [
	/usage\s*limit/i,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
];

const SAME_MODEL_RECOVERY_PATTERNS = [
	/web\s*socket/i,
	/websocket/i,
	/transport/i,
	/stream/i,
	/socket/i,
	/connection/i,
	/fetch failed/i,
	/network/i,
	/http idle/i,
	/timed? out/i,
	/timeout/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/database is locked/i,
	/\bsqlite_busy\b/i,
	/econnreset/i,
	/etimedout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
];

export function isRecoverableSameModelFailure(error: string | undefined, exitCode?: number | null): boolean {
	if (exitCode === 143) return true;
	if (!error) return false;
	if (NON_RECOVERABLE_SAME_MODEL_PATTERNS.some((pattern) => pattern.test(error))) return false;
	return SAME_MODEL_RECOVERY_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}

export function formatModelRecoveryAttemptNote(attempt: ModelAttemptSummary, retryNumber: number, maxRetries: number): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return `[retry] ${attempt.model} failed: ${failure}. Retrying same model (${retryNumber}/${maxRetries}).`;
}

export interface AttemptOutcome {
	exitCode: number | null;
	error?: string;
	model?: string;
	usage: Usage;
	interrupted?: boolean;
	timedOut?: boolean;
	resourceLimitExceeded?: ResourceLimitExceeded;
	terminalFailure?: boolean;
}

export function sumAttemptUsage(attempts: readonly ModelAttempt[]): Usage {
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const attempt of attempts) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) usage[key] += attempt.usage?.[key] ?? 0;
	}
	return usage;
}

export async function runModelAttempts<T extends AttemptOutcome>(input: {
	candidates: readonly (string | undefined)[];
	signal?: AbortSignal;
	runAttempt: (model: string | undefined, notes: string[]) => Promise<T>;
}): Promise<{ result: T; modelAttempts: ModelAttempt[]; attemptedModels: string[]; notes: string[]; usage: Usage }> {
	const candidates = input.candidates.length ? input.candidates : [undefined];
	const modelAttempts: ModelAttempt[] = [];
	const attemptedModels: string[] = [];
	const notes: string[] = [];
	let result!: T;
	modelLoop:
	for (let index = 0; index < candidates.length; index++) {
		const model = candidates[index];
		for (let recovery = 0; ; recovery++) {
			result = await input.runAttempt(model, notes);
			if (model) attemptedModels.push(model);
			const attempt: ModelAttempt = {
				model: model ?? result.model ?? "default",
				success: result.exitCode === 0 && !result.error && !result.interrupted,
				exitCode: result.exitCode,
				error: result.error,
				usage: { ...result.usage },
			};
			modelAttempts.push(attempt);
			if (attempt.success || input.signal?.aborted || result.interrupted || result.timedOut || result.resourceLimitExceeded || result.terminalFailure) break modelLoop;
			const recoverable = isRecoverableSameModelFailure(result.error, result.exitCode);
			if (recoverable && recovery === 0) {
				notes.push(formatModelRecoveryAttemptNote(attempt, 1, 1));
				continue;
			}
			if ((!recoverable && !isRetryableModelFailure(result.error)) || index === candidates.length - 1) break modelLoop;
			notes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
			break;
		}
	}
	return { result, modelAttempts, attemptedModels, notes, usage: sumAttemptUsage(modelAttempts) };
}
