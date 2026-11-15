import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import type { DelegationContract, Escalation } from "./contracts.ts";
import { isPathAllowedByScope } from "./overseer-scope.ts";

const MAX_JUDGE_DIFF_CHARS = 16000;
const MAX_EXCERPT_CHARS = 3000;
const JUDGE_PROBABILITY_THRESHOLD = 0.85;
const JUDGE_PRIORITY = [
  ["google", "gemini-decision-1"],
  ["cloudflare-workers-ai", "@cf/cloudflare/clef"],
  ["openai", "gpt-6-luna"],
  ["cloudflare-workers-ai", "@cf/cloudflare/clef-flash"],
] as const;

export interface RepoSnapshot {
  readonly isGit: boolean;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly fileStamps: ReadonlyMap<string, string>;
  readonly judgeDiff: string;
  readonly diffExcerpt: string;
  readonly diffLines: number;
  readonly digest: string;
}

export interface ViolationCandidate {
  readonly kind: Escalation["kind"];
  readonly summary: string;
  readonly changedFiles: string[];
  readonly diffExcerpt: string;
  readonly diffDigest: string;
}

function runGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]) !== undefined;
}

function fileStamp(cwd: string, relPath: string, statusCode: string): string {
  try {
    const stat = fs.lstatSync(path.join(cwd, relPath));
    return `${statusCode}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return `${statusCode}:missing`;
  }
}

function parsePorcelain(cwd: string, raw: string): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    const status = line.slice(0, 2);
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    const relPath = (arrow >= 0 ? body.slice(arrow + 4) : body).trim();
    if (relPath.length > 0) {
      stamps.set(relPath, fileStamp(cwd, relPath, status));
    }
  }
  return stamps;
}

function untrackedPreview(cwd: string, files: readonly string[]): string {
  const chunks: string[] = [];
  let budget = 4000;
  for (const rel of files) {
    if (budget <= 0) {
      break;
    }
    try {
      const full = path.join(cwd, rel);
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.size <= 32768) {
        const snippet = fs.readFileSync(full, "utf8").slice(0, Math.min(1200, budget));
        chunks.push(`+++ new file: ${rel}\n${snippet}`);
        budget -= snippet.length;
      }
    } catch {
      // Concurrent file removal between status and preview is harmless.
    }
  }
  return chunks.join("\n");
}

function snapshotDigest(
  head: string | undefined,
  fileStamps: ReadonlyMap<string, string>,
  judgeDiff: string,
): string {
  return createHash("sha256")
    .update(head ?? "")
    .update("\0")
    .update(JSON.stringify([...fileStamps.entries()]))
    .update("\0")
    .update(judgeDiff)
    .digest("hex");
}

function nonemptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Captures a fast, bounded Git status and diff snapshot for `cwd`. */
export function captureRepoSnapshot(cwd: string, baselineHead?: string): RepoSnapshot {
  const statusRaw = runGit(cwd, ["status", "--porcelain=v1", "-uall"]);
  if (statusRaw === undefined) {
    return {
      isGit: false,
      head: undefined,
      branch: undefined,
      fileStamps: new Map(),
      judgeDiff: "",
      diffExcerpt: "",
      diffLines: 0,
      digest: "non-git",
    };
  }
  const head = nonemptyTrimmed(runGit(cwd, ["rev-parse", "--verify", "HEAD"]));
  const branch = nonemptyTrimmed(runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  const fileStamps = parsePorcelain(cwd, statusRaw);
  const trackedDiff = runGit(cwd, ["diff", baselineHead ?? head ?? "HEAD", "--unified=2"]) ?? "";
  const untracked = [...fileStamps.entries()]
    .filter(([, code]) => code.startsWith("??:"))
    .map(([file]) => file);
  const combined = [trackedDiff, untrackedPreview(cwd, untracked)].filter(Boolean).join("\n");
  const judgeDiff = combined.slice(0, MAX_JUDGE_DIFF_CHARS);
  return {
    isGit: true,
    head,
    branch,
    fileStamps,
    judgeDiff,
    diffExcerpt: combined.slice(0, MAX_EXCERPT_CHARS),
    diffLines: combined === "" ? 0 : combined.split("\n").length,
    digest: snapshotDigest(head, fileStamps, judgeDiff),
  };
}

function committedFilesBetween(
  cwd: string,
  fromHead: string | undefined,
  toHead: string | undefined,
): string[] {
  if (fromHead === undefined || toHead === undefined || fromHead === toHead) {
    return [];
  }
  const raw = runGit(cwd, ["diff", "--name-only", fromHead, toHead]) ?? "";
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Files modified, added, or deleted relative to `baseline` (ignores untouched pre-existing dirty files). */
export function changedFilesSinceBaseline(
  cwd: string,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
): string[] {
  const changed = new Set<string>();
  for (const [file, stamp] of current.fileStamps) {
    if (baseline.fileStamps.get(file) !== stamp) {
      changed.add(file);
    }
  }
  for (const file of baseline.fileStamps.keys()) {
    if (!current.fileStamps.has(file)) {
      changed.add(file);
    }
  }
  for (const file of committedFilesBetween(cwd, baseline.head, current.head)) {
    changed.add(file);
  }
  return [...changed].sort();
}

function checkBranchViolation(
  cwd: string,
  baseBranch: string | undefined,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
): string | undefined {
  if (baseBranch === undefined || !current.isGit) {
    return undefined;
  }
  if (
    current.branch === baseBranch &&
    baseline.head !== undefined &&
    current.head !== baseline.head
  ) {
    return `Child committed directly onto base branch '${baseBranch}' instead of a task branch.`;
  }
  if (current.head !== undefined && !isAncestor(cwd, baseBranch, "HEAD")) {
    return `Current HEAD is not descended from expected baseBranch '${baseBranch}'.`;
  }
  return undefined;
}

/** Zero-cost local checks for error loops, out-of-scope edits, and wrong Git branches. */
export function checkDeterministicTripwires(options: {
  cwd: string;
  contract: DelegationContract;
  baseline: RepoSnapshot;
  current: RepoSnapshot;
  consecutiveErrors: number;
}): ViolationCandidate | undefined {
  const { cwd, contract, baseline, current, consecutiveErrors } = options;
  const changedFiles = changedFilesSinceBaseline(cwd, baseline, current);
  if (consecutiveErrors >= 3) {
    return {
      kind: "loop_violation",
      summary: `Child hit ${consecutiveErrors} consecutive turns with tool/command errors without clean progress.`,
      changedFiles,
      diffExcerpt: current.diffExcerpt,
      diffDigest: current.digest,
    };
  }
  const outOfScope = changedFiles.filter(
    (file) => !isPathAllowedByScope(cwd, file, contract.scope),
  );
  if (outOfScope.length > 0) {
    const allowed = contract.scope.length === 0 ? "read-only ([])" : contract.scope.join(", ");
    return {
      kind: "scope_violation",
      summary: `Modified out-of-scope path(s): ${outOfScope.join(", ")} (allowed scope: ${allowed}).`,
      changedFiles,
      diffExcerpt: current.diffExcerpt,
      diffDigest: current.digest,
    };
  }
  if (changedFiles.length > 0 || current.head !== baseline.head) {
    const branchIssue = checkBranchViolation(cwd, contract.baseBranch, baseline, current);
    if (branchIssue !== undefined) {
      return {
        kind: "branch_violation",
        summary: branchIssue,
        changedFiles,
        diffExcerpt: current.diffExcerpt,
        diffDigest: current.digest,
      };
    }
  }
  return undefined;
}

async function selectClassifierModel(
  registry: unknown,
  judgeSpec: string,
): Promise<UnknownRecord | undefined> {
  if (!isRecord(registry)) {
    return undefined;
  }
  const getAvailable = Reflect.get(registry, "getAvailableOfType");
  if (typeof getAvailable !== "function") {
    return undefined;
  }
  const rawList: unknown = await Reflect.apply(getAvailable, registry, ["classifier"]);
  if (!Array.isArray(rawList)) {
    return undefined;
  }
  const models = rawList.filter(isRecord);
  if (judgeSpec !== "auto") {
    const slash = judgeSpec.indexOf("/");
    const provider = slash > 0 ? judgeSpec.slice(0, slash) : "";
    const id = slash > 0 ? judgeSpec.slice(slash + 1) : judgeSpec;
    return models.find((m) => m.provider === provider && m.id === id);
  }
  for (const [provider, id] of JUDGE_PRIORITY) {
    const found = models.find((m) => m.provider === provider && m.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  return models[0];
}

function readBoolProbability(answers: UnknownRecord, key: string): number {
  const entry = answers[key];
  return isRecord(entry) && entry.type === "bool" && typeof entry.probability === "number"
    ? entry.probability
    : 0;
}

function buildJudgeQuestions(contract: DelegationContract): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    scope_violation: {
      type: "bool",
      instructions:
        "Did the diff introduce unrequested features, speculative/contrived fallbacks, or changes forbidden by contract.nonGoals?",
      criteria: {
        true: "Drifted beyond the requested task or violated nonGoals",
        false: "Stays directly focused on the requested task and contract",
      },
    },
  };
  if (contract.requiredPrimitives !== undefined && contract.requiredPrimitives.length > 0) {
    questions.primitive_violation = {
      type: "bool",
      instructions: `Did the diff build custom caches, wrappers, or manual plumbing instead of using the required primitives (${contract.requiredPrimitives.join(", ")})?`,
      criteria: {
        true: "Reimplemented or bypassed required primitives with custom code",
        false: "Uses the required primitives cleanly",
      },
    };
  }
  return questions;
}

function interpretJudgeAnswers(
  classifier: UnknownRecord,
  answers: UnknownRecord,
  options: { contract: DelegationContract; changedFiles: string[]; snapshot: RepoSnapshot },
): ViolationCandidate | undefined {
  const label = `${String(classifier.provider)}/${String(classifier.id)}`;
  const primitiveProb = readBoolProbability(answers, "primitive_violation");
  if (primitiveProb >= JUDGE_PROBABILITY_THRESHOLD) {
    const required = options.contract.requiredPrimitives?.join(", ") ?? "";
    return {
      kind: "primitive_violation",
      summary: `Decision judge (${label}, p=${primitiveProb.toFixed(2)}) flagged custom plumbing bypassing required primitives (${required}).`,
      changedFiles: options.changedFiles,
      diffExcerpt: options.snapshot.diffExcerpt,
      diffDigest: options.snapshot.digest,
    };
  }
  const scopeProb = readBoolProbability(answers, "scope_violation");
  if (scopeProb >= JUDGE_PROBABILITY_THRESHOLD) {
    return {
      kind: "scope_violation",
      summary: `Decision judge (${label}, p=${scopeProb.toFixed(2)}) flagged unrequested scope drift or nonGoal violation.`,
      changedFiles: options.changedFiles,
      diffExcerpt: options.snapshot.diffExcerpt,
      diffDigest: options.snapshot.digest,
    };
  }
  return undefined;
}

async function invokeClassifier(
  registry: unknown,
  classifier: UnknownRecord,
  payload: { state: UnknownRecord; questions: Record<string, unknown> },
  signal: AbortSignal | undefined,
): Promise<UnknownRecord | undefined> {
  const classifyFn = isRecord(registry) ? Reflect.get(registry, "classify") : undefined;
  if (typeof classifyFn !== "function") {
    return undefined;
  }
  try {
    const result: unknown = await Reflect.apply(classifyFn, registry, [
      classifier,
      payload,
      { signal, timeoutMs: 8000 },
    ]);
    return isRecord(result) && result.stopReason === "stop" && isRecord(result.answers)
      ? result.answers
      : undefined;
  } catch {
    return undefined;
  }
}

/** Single-pass Decision-Model check over a bounded diff checkpoint (~$0.0004, 0 output tokens). */
export async function evaluateDecisionCheckpoint(options: {
  modelRegistry: unknown;
  judgeSpec: string | undefined;
  prompt: string;
  contract: DelegationContract;
  changedFiles: string[];
  snapshot: RepoSnapshot;
  signal: AbortSignal | undefined;
}): Promise<ViolationCandidate | undefined> {
  const judgeSpec = options.judgeSpec ?? "auto";
  if (
    judgeSpec === "off" ||
    options.changedFiles.length === 0 ||
    options.snapshot.judgeDiff === ""
  ) {
    return undefined;
  }
  const classifier = await selectClassifierModel(options.modelRegistry, judgeSpec);
  if (classifier === undefined) {
    return undefined;
  }
  const answers = await invokeClassifier(
    options.modelRegistry,
    classifier,
    {
      state: {
        taskPrompt: options.prompt.slice(0, 4000),
        contract: options.contract,
        changedFiles: options.changedFiles,
        diff: options.snapshot.judgeDiff,
      },
      questions: buildJudgeQuestions(options.contract),
    },
    options.signal,
  );
  return answers === undefined ? undefined : interpretJudgeAnswers(classifier, answers, options);
}
