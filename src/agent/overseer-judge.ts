import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ClassifierApi,
  ClassifierChoiceAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DelegationContract, Escalation } from "./contracts.ts";
import { isPathAllowedByScope } from "./overseer-scope.ts";

// Keep escalation card excerpts compact while full files remain inspectable in the worktree.
const ESCALATION_EXCERPT_CHARS = 3000;
// Product contract (docs/reference.md): 3 consecutive error turns trigger a loop escalation.
export const CONSECUTIVE_ERROR_TURN_LIMIT = 3;
const PREFERRED_AUTO_JUDGES = [
  ["google", "gemini-decision-1"],
  ["cloudflare-workers-ai", "@cf/cloudflare/clef"],
  ["openai", "gpt-6-luna"],
  ["cloudflare-workers-ai", "@cf/cloudflare/clef-flash"],
] as const;

export interface JudgeModelRegistry {
  readonly getAvailableOfType: (
    type: "classifier",
  ) => Promise<readonly ClassifierModel<ClassifierApi>[]>;
  readonly getModelOfType: (
    type: "classifier",
    provider: string,
    modelId: string,
  ) => ClassifierModel<ClassifierApi> | undefined;
  readonly classify: ExtensionContext["modelRegistry"]["classify"];
}

export interface RepoSnapshot {
  readonly isGit: boolean;
  readonly topLevel: string | undefined;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly fileStamps: ReadonlyMap<string, string>;
  readonly rawDiff: string;
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
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]) !== undefined;
}

function fileStamp(topLevel: string, relPath: string, statusCode: string): string {
  try {
    const stat = fs.lstatSync(path.resolve(topLevel, relPath));
    return `${statusCode}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return `${statusCode}:missing`;
  }
}

function isRenameOrCopy(status: string): boolean {
  return status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C";
}

function parsePorcelainZ(topLevel: string, raw: string): Map<string, string> {
  const stamps = new Map<string, string>();
  const tokens = raw.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const entry = tokens[index] ?? "";
    index += 1;
    if (entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const relPath = entry.slice(3);
    if (relPath.length > 0) {
      stamps.set(relPath, fileStamp(topLevel, relPath, status));
    }
    if (isRenameOrCopy(status) && index < tokens.length) {
      const origPath = tokens[index] ?? "";
      index += 1;
      if (origPath.length > 0 && !stamps.has(origPath)) {
        stamps.set(origPath, `${status}:orig`);
      }
    }
  }
  return stamps;
}

function untrackedPreview(topLevel: string, files: readonly string[]): string {
  const chunks: string[] = [];
  let budget = 4000;
  for (const rel of files) {
    if (budget <= 0) {
      break;
    }
    try {
      const full = path.resolve(topLevel, rel);
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
  rawDiff: string,
): string {
  return createHash("sha256")
    .update(head ?? "")
    .update("\0")
    .update(JSON.stringify([...fileStamps.entries()]))
    .update("\0")
    .update(rawDiff)
    .digest("hex");
}

function nonemptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Captures a NUL-delimited Git status and diff snapshot anchored at the repository root. */
export function captureRepoSnapshot(cwd: string, baselineHead?: string): RepoSnapshot {
  const topLevel = nonemptyTrimmed(runGit(cwd, ["rev-parse", "--show-toplevel"]));
  const statusRaw =
    topLevel === undefined
      ? undefined
      : runGit(topLevel, ["status", "--porcelain=v1", "-z", "-uall"]);
  if (topLevel === undefined || statusRaw === undefined) {
    return {
      isGit: false,
      topLevel: undefined,
      head: undefined,
      branch: undefined,
      fileStamps: new Map(),
      rawDiff: "",
      diffExcerpt: "",
      diffLines: 0,
      digest: "non-git",
    };
  }
  const head = nonemptyTrimmed(runGit(topLevel, ["rev-parse", "--verify", "HEAD"]));
  const branch = nonemptyTrimmed(runGit(topLevel, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  const fileStamps = parsePorcelainZ(topLevel, statusRaw);
  const trackedDiff =
    runGit(topLevel, [
      "-c",
      "core.quotePath=false",
      "diff",
      baselineHead ?? head ?? "HEAD",
      "--unified=2",
    ]) ?? "";
  const untracked = [...fileStamps.entries()]
    .filter(([, code]) => code.startsWith("??:"))
    .map(([file]) => file);
  const rawDiff = [trackedDiff, untrackedPreview(topLevel, untracked)].filter(Boolean).join("\n");
  return {
    isGit: true,
    topLevel,
    head,
    branch,
    fileStamps,
    rawDiff,
    diffExcerpt: rawDiff.slice(0, ESCALATION_EXCERPT_CHARS),
    diffLines: rawDiff === "" ? 0 : rawDiff.split("\n").length,
    digest: snapshotDigest(head, fileStamps, rawDiff),
  };
}

function committedFilesBetween(
  topLevel: string,
  fromHead: string | undefined,
  toHead: string | undefined,
): string[] {
  if (fromHead === undefined || toHead === undefined || fromHead === toHead) {
    return [];
  }
  const raw = runGit(topLevel, ["diff", "-z", "--name-only", fromHead, toHead]) ?? "";
  return raw.split("\0").filter((entry) => entry.length > 0);
}

function formatPathForCwd(topLevel: string, cwd: string, repoRelPath: string): string {
  let realCwd = path.resolve(cwd);
  let realTop = path.resolve(topLevel);
  try {
    realCwd = fs.realpathSync(cwd);
    realTop = fs.realpathSync(topLevel);
  } catch {
    // Fall back to lexical resolution if cwd disappeared concurrently.
  }
  const abs = path.resolve(realTop, repoRelPath);
  const rel = path.relative(realCwd, abs);
  return (rel === "" ? repoRelPath : rel).split(path.sep).join("/");
}

/** Files modified, added, or deleted relative to `baseline`, formatted relative to `cwd`. */
export function changedFilesSinceBaseline(
  cwd: string,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
): string[] {
  if (!current.isGit || current.topLevel === undefined) {
    return [];
  }
  const changedRepoPaths = new Set<string>();
  for (const [file, stamp] of current.fileStamps) {
    if (baseline.fileStamps.get(file) !== stamp) {
      changedRepoPaths.add(file);
    }
  }
  for (const file of committedFilesBetween(current.topLevel, baseline.head, current.head)) {
    changedRepoPaths.add(file);
  }
  return [...changedRepoPaths]
    .map((repoRel) => formatPathForCwd(current.topLevel ?? cwd, cwd, repoRel))
    .sort();
}

function checkBranchViolation(
  cwd: string,
  baseBranch: string | undefined,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
): string | undefined {
  if (
    baseBranch === undefined ||
    !current.isGit ||
    baseline.head === undefined ||
    current.head === undefined ||
    current.head === baseline.head
  ) {
    return undefined;
  }
  if (current.branch === baseBranch) {
    return `Child committed directly onto base branch '${baseBranch}' instead of a task branch.`;
  }
  const baselineMergeBase = nonemptyTrimmed(runGit(cwd, ["merge-base", baseBranch, baseline.head]));
  if (baselineMergeBase !== undefined && !isAncestor(cwd, baselineMergeBase, current.head)) {
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
  if (consecutiveErrors >= CONSECUTIVE_ERROR_TURN_LIMIT) {
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
  registry: JudgeModelRegistry,
  judgeSpec: string,
): Promise<ClassifierModel<ClassifierApi> | undefined> {
  const available = await registry.getAvailableOfType("classifier");
  if (judgeSpec !== "auto") {
    const slash = judgeSpec.indexOf("/");
    const provider = slash > 0 ? judgeSpec.slice(0, slash) : "";
    const id = slash > 0 ? judgeSpec.slice(slash + 1) : judgeSpec;
    const matched =
      available.find((model) => model.provider === provider && model.id === id) ??
      registry.getModelOfType("classifier", provider, id);
    if (matched === undefined) {
      throw new Error(
        `Configured overseer judge '${judgeSpec}' is not an available classifier model.`,
      );
    }
    return matched;
  }
  for (const [provider, id] of PREFERRED_AUTO_JUDGES) {
    const found = available.find((model) => model.provider === provider && model.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  return available[0];
}

function buildJudgeContext(options: {
  classifier: ClassifierModel<ClassifierApi>;
  prompt: string;
  contract: DelegationContract;
  changedFiles: string[];
  snapshot: RepoSnapshot;
}): ClassifierContext {
  // Reserve half of the model's token context window (~4 chars/token) for state metadata + schema.
  const diffCharBudget = Math.max(4096, Math.floor(options.classifier.contextWindow * 2));
  const criteria: Record<string, string> = {
    compliant: "Stays directly focused on the task prompt, contract, and required primitives",
    scope_violation:
      "Introduces unrequested features, speculative fallbacks, or changes forbidden by nonGoals",
  };
  const required = options.contract.requiredPrimitives;
  if (required !== undefined && required.length > 0) {
    criteria.primitive_violation = `Reimplements or bypasses required primitives (${required.join(", ")}) with custom wrappers, caches, or manual plumbing`;
  }
  return {
    state: {
      taskPrompt: options.prompt,
      contract: options.contract,
      changedFiles: options.changedFiles,
      diff: options.snapshot.rawDiff.slice(0, diffCharBudget),
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "Select whether the diff complies with the delegation contract or clearly violates it.",
        criteria,
      },
    },
  };
}

function interpretVerdict(
  classifier: ClassifierModel<ClassifierApi>,
  verdictLabel: string,
  confidence: number,
  options: { contract: DelegationContract; changedFiles: string[]; snapshot: RepoSnapshot },
): ViolationCandidate | undefined {
  const modelId = `${classifier.provider}/${classifier.id}`;
  if (verdictLabel === "primitive_violation") {
    const required = options.contract.requiredPrimitives?.join(", ") ?? "";
    return {
      kind: "primitive_violation",
      summary: `Decision judge (${modelId}, confidence=${confidence.toFixed(2)}) flagged custom plumbing bypassing required primitives (${required}).`,
      changedFiles: options.changedFiles,
      diffExcerpt: options.snapshot.diffExcerpt,
      diffDigest: options.snapshot.digest,
    };
  }
  if (verdictLabel === "scope_violation") {
    return {
      kind: "scope_violation",
      summary: `Decision judge (${modelId}, confidence=${confidence.toFixed(2)}) flagged unrequested scope drift or nonGoal violation.`,
      changedFiles: options.changedFiles,
      diffExcerpt: options.snapshot.diffExcerpt,
      diffDigest: options.snapshot.digest,
    };
  }
  return undefined;
}

function unpackVerdictChoice(result: ClassifierResult): ClassifierChoiceAnswer | undefined {
  if (result.stopReason !== "stop") {
    if (result.stopReason === "error") {
      throw new Error(
        `Overseer judge '${result.provider}/${result.model}' failed: ${result.errorMessage ?? "classifier error"}.`,
      );
    }
    return undefined;
  }
  const answer = result.answers.verdict;
  return answer?.type === "choice" ? answer : undefined;
}

/** Single-pass Decision-Model check over a diff checkpoint sized to the classifier's contextWindow. */
export async function evaluateDecisionCheckpoint(options: {
  modelRegistry: JudgeModelRegistry;
  judgeSpec: string | undefined;
  prompt: string;
  contract: DelegationContract;
  changedFiles: string[];
  snapshot: RepoSnapshot;
  signal: AbortSignal | undefined;
}): Promise<ViolationCandidate | undefined> {
  const judgeSpec = options.judgeSpec ?? "auto";
  if (judgeSpec === "off" || options.changedFiles.length === 0 || options.snapshot.rawDiff === "") {
    return undefined;
  }
  const classifier = await selectClassifierModel(options.modelRegistry, judgeSpec);
  if (classifier === undefined) {
    return undefined;
  }
  const result = await options.modelRegistry.classify(
    classifier,
    buildJudgeContext({ classifier, ...options }),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  const answer = unpackVerdictChoice(result);
  return answer === undefined
    ? undefined
    : interpretVerdict(classifier, answer.choice, answer.confidence, options);
}
