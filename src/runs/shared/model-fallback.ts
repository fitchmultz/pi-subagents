import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type {
  ModelAttempt,
  ResourceLimitExceeded,
  Usage,
  UsageAccumulator,
  ReadonlyInput,
} from "../../shared/types.ts";

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
  if (colonIdx === -1) {
    return { baseModel: model, thinkingSuffix: "" };
  }
  return {
    baseModel: model.substring(0, colonIdx),
    thinkingSuffix: model.substring(colonIdx),
  };
}

function preferredModel(
  matches: ReadonlyInput<readonly AvailableModelInfo[]>,
  provider: string | undefined,
): ReadonlyInput<AvailableModelInfo> | undefined {
  return provider === undefined || provider.length === 0
    ? undefined
    : matches.find((entry) => entry.provider === provider);
}

export function resolveModelCandidate(
  model: string | undefined,
  availableModels: ReadonlyInput<readonly AvailableModelInfo[]> | undefined,
  preferredProvider?: string,
): string | undefined {
  if (model === undefined || model.length === 0) {
    return undefined;
  }
  if (model.includes("/")) {
    return model;
  }
  if (!availableModels || availableModels.length === 0) {
    return model;
  }

  const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
  const matches = availableModels.filter((entry) => entry.id === baseModel);
  const preferredMatch = preferredModel(matches, preferredProvider);
  if (preferredMatch) {
    return `${preferredMatch.fullId}${thinkingSuffix}`;
  }
  if (matches.length !== 1) {
    return model;
  }
  const match = matches.at(0);
  return match === undefined ? model : `${match.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
  primaryModel: string | undefined,
  fallbackModels: readonly string[] | undefined,
  availableModels: ReadonlyInput<readonly AvailableModelInfo[]> | undefined,
  preferredProvider?: string,
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
    if (raw === undefined || raw.length === 0) {
      continue;
    }
    const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
    if (normalized === undefined || normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
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
  if (error === undefined || error.length === 0) {
    return false;
  }
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

export function isRecoverableSameModelFailure(
  error: string | undefined,
  exitCode?: number | null,
): boolean {
  if (exitCode === 143) {
    return true;
  }
  if (error === undefined || error.length === 0) {
    return false;
  }
  if (NON_RECOVERABLE_SAME_MODEL_PATTERNS.some((pattern) => pattern.test(error))) {
    return false;
  }
  return SAME_MODEL_RECOVERY_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(
  attempt: ReadonlyInput<ModelAttemptSummary>,
  nextModel?: string,
): string {
  const failure = failureDescription(attempt);
  return nextModel !== undefined && nextModel.length > 0
    ? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
    : `[fallback] ${attempt.model} failed: ${failure}.`;
}

export function formatModelRecoveryAttemptNote(
  attempt: ReadonlyInput<ModelAttemptSummary>,
  retryNumber: number,
  maxRetries: number,
): string {
  const failure = failureDescription(attempt);
  return `[retry] ${attempt.model} failed: ${failure}. Retrying same model (${retryNumber}/${maxRetries}).`;
}

export interface AttemptOutcome {
  accounting?: ModelAttempt["accounting"];
  exitCode: number | null;
  error?: string;
  model?: string;
  usage: Usage;
  interrupted?: boolean;
  timedOut?: boolean;
  resourceLimitExceeded?: ResourceLimitExceeded;
  terminalFailure?: boolean;
}

export function sumAttemptUsage(attempts: ReadonlyInput<readonly ModelAttempt[]>): Usage {
  const usage: UsageAccumulator = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  for (const attempt of attempts) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
      usage[key] += attempt.usage?.[key] ?? 0;
    }
    const contributions = attempt.usage?.contributions;
    if (contributions !== undefined && contributions.length > 0) {
      (usage.contributions ??= []).push(...contributions);
    }
  }
  return usage;
}

function failureDescription(attempt: ReadonlyInput<ModelAttemptSummary>): string {
  const error = attempt.error?.trim();
  return error !== undefined && error.length > 0 ? error : `exit ${attempt.exitCode ?? 1}`;
}

function successfulAttempt(result: ReadonlyInput<AttemptOutcome>): boolean {
  return (
    result.exitCode === 0 &&
    (result.error === undefined || result.error.length === 0) &&
    result.interrupted !== true
  );
}
function terminalAttempt(result: ReadonlyInput<AttemptOutcome>, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    result.resourceLimitExceeded !== undefined ||
    result.terminalFailure === true ||
    result.interrupted === true ||
    result.timedOut === true
  );
}
function summarizeAttempt(
  model: string | undefined,
  result: ReadonlyInput<AttemptOutcome>,
): ModelAttempt {
  return {
    model: model ?? result.model ?? "default",
    success: successfulAttempt(result),
    exitCode: result.exitCode,
    error: result.error,
    accounting: result.accounting,
    usage: { ...result.usage },
  };
}
function retryDecision(
  result: ReadonlyInput<AttemptOutcome>,
  recovery: number,
  lastCandidate: boolean,
  signal?: AbortSignal,
): "stop" | "recover" | "fallback" {
  if (terminalAttempt(result, signal) || successfulAttempt(result)) {
    return "stop";
  }
  const recoverable = isRecoverableSameModelFailure(result.error, result.exitCode);
  if (recoverable && recovery === 0) {
    return "recover";
  }
  return lastCandidate || (!recoverable && !isRetryableModelFailure(result.error))
    ? "stop"
    : "fallback";
}

export async function runModelAttempts<T extends AttemptOutcome>(
  input: ReadonlyInput<{
    readonly candidates: readonly (string | undefined)[];
    readonly signal?: AbortSignal;
    readonly runAttempt: (model: string | undefined, notes: readonly string[]) => Promise<T>;
  }>,
): Promise<{
  result: T;
  modelAttempts: ModelAttempt[];
  attemptedModels: string[];
  notes: string[];
  usage: Usage;
}> {
  const candidates = input.candidates.length > 0 ? input.candidates : [undefined];
  const modelAttempts: ModelAttempt[] = [];
  const attemptedModels: string[] = [];
  const notes: string[] = [];
  let result!: T;
  modelLoop: for (let index = 0; index < candidates.length; index++) {
    const model = candidates[index];
    for (let recovery = 0; ; recovery++) {
      // A recovery needs the previous finalized outcome and accumulated notes before it starts.
      // oxlint-disable-next-line no-await-in-loop
      result = await input.runAttempt(model, notes);
      if (model !== undefined && model.length > 0) {
        attemptedModels.push(model);
      }
      const attempt = summarizeAttempt(model, result);
      modelAttempts.push(attempt);
      const decision = retryDecision(
        result,
        recovery,
        index === candidates.length - 1,
        input.signal,
      );
      if (decision === "stop") {
        break modelLoop;
      }
      if (decision === "recover") {
        notes.push(formatModelRecoveryAttemptNote(attempt, 1, 1));
        continue;
      }
      notes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
      break;
    }
  }
  return { result, modelAttempts, attemptedModels, notes, usage: sumAttemptUsage(modelAttempts) };
}
