import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  excludedRepoPrefixes,
  isExcludedRepoPath,
  isPathAllowedByScope,
  parsePorcelainZ,
  safeRealpath,
  untrackedFilesPreview,
} from "./overseer-scope.ts";

const ESCALATION_EXCERPT_CHARS = 3000;
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

export interface SnapshotOptions {
  readonly baselineHead?: string | undefined;
  readonly hasBaseline?: boolean | undefined;
  readonly baseBranch?: string | undefined;
  readonly excludePaths?: readonly string[] | undefined;
}

export interface RepoSnapshot {
  readonly isGit: boolean;
  readonly topLevel: string | undefined;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly baseBranch: string | undefined;
  readonly resolvedBaseHead: string | undefined;
  readonly baseBranchUnborn: boolean;
  readonly branchHeads: ReadonlyMap<string, string>;
  readonly fileStamps: ReadonlyMap<string, string>;
  readonly rawDiff: string;
  readonly diffExcerpt: string;
  readonly digest: string;
}

export type ViolationCandidate = Pick<
  Escalation,
  "kind" | "summary" | "changedFiles" | "diffExcerpt" | "diffDigest"
>;

const NON_GIT_SNAPSHOT: RepoSnapshot = {
  isGit: false,
  topLevel: undefined,
  head: undefined,
  branch: undefined,
  baseBranch: undefined,
  resolvedBaseHead: undefined,
  baseBranchUnborn: false,
  branchHeads: new Map(),
  fileStamps: new Map(),
  rawDiff: "",
  diffExcerpt: "",
  digest: "non-git",
};

function runGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 67108864,
    });
  } catch {
    return undefined;
  }
}

function trimmed(value: string | undefined): string | undefined {
  const s = value?.trim();
  return s !== undefined && s.length > 0 ? s : undefined;
}

const refCommit = (top: string, ref: string): string | undefined =>
  trimmed(runGit(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));

function isUpstreamSync(
  top: string,
  name: string,
  sha: string | undefined,
  baseline: RepoSnapshot,
): boolean {
  if (sha === undefined || name !== baseline.baseBranch) {
    return false;
  }
  if (sha === baseline.resolvedBaseHead) {
    return true;
  }
  const remoteRef = `refs/remotes/origin/${name}`;
  const remote = refCommit(top, remoteRef);
  const log = runGit(top, ["log", "-g", "-1", "--format=%gs", remoteRef]) ?? "";
  return (
    remote !== undefined &&
    !log.startsWith("update by push") &&
    runGit(top, ["merge-base", "--is-ancestor", sha, remote]) !== undefined
  );
}

const emptyTree = (top: string): string | undefined =>
  trimmed(runGit(top, ["hash-object", "-t", "tree", "/dev/null"]));

function localBranchHeads(top: string): Map<string, string> {
  const raw =
    runGit(top, ["for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname)", "refs/heads"]) ??
    "";
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const nul = line.indexOf("\0");
    if (nul > 0) {
      map.set(line.slice(0, nul), line.slice(nul + 1).trim());
    }
  }
  return map;
}

function baseState(
  top: string,
  baseBranch: string | undefined,
  head: string | undefined,
  branchHeads: ReadonlyMap<string, string>,
): { resolved: string | undefined; unborn: boolean } {
  if (baseBranch === undefined) {
    return { resolved: undefined, unborn: false };
  }
  const resolved =
    branchHeads.get(baseBranch) ??
    refCommit(top, baseBranch) ??
    refCommit(top, `refs/remotes/origin/${baseBranch}`);
  const unborn =
    resolved === undefined &&
    head === undefined &&
    trimmed(runGit(top, ["rev-list", "-n", "1", "--all"])) === undefined;
  return { resolved, unborn };
}

function trackedDiff(top: string, head: string | undefined, opts: SnapshotOptions): string {
  if (head === undefined) {
    return runGit(top, ["-c", "core.quotePath=false", "diff", "--cached", "--unified=2"]) ?? "";
  }
  const base = opts.hasBaseline === true ? (opts.baselineHead ?? emptyTree(top)) : head;
  return base === undefined
    ? ""
    : (runGit(top, ["-c", "core.quotePath=false", "diff", base, "--unified=2"]) ?? "");
}

/** Captures a NUL-delimited Git status and diff snapshot anchored at the repository root. */
export function captureRepoSnapshot(cwd: string, options?: string | SnapshotOptions): RepoSnapshot {
  const opts =
    typeof options === "string" ? { baselineHead: options, hasBaseline: true } : (options ?? {});
  const top = trimmed(runGit(cwd, ["rev-parse", "--show-toplevel"]));
  const statusRaw =
    top === undefined ? undefined : runGit(top, ["status", "--porcelain=v1", "-z", "-uall"]);
  if (top === undefined || statusRaw === undefined) {
    return NON_GIT_SNAPSHOT;
  }
  const head = trimmed(runGit(top, ["rev-parse", "--verify", "HEAD"]));
  const branch = trimmed(runGit(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  const branchHeads = localBranchHeads(top);
  const bs = baseState(top, opts.baseBranch, head, branchHeads);
  const fileStamps = parsePorcelainZ(top, statusRaw, excludedRepoPrefixes(top, opts.excludePaths));
  const untracked = [...fileStamps.entries()]
    .filter(([, c]) => c.startsWith("??:"))
    .map(([f]) => f);
  const rawDiff = [trackedDiff(top, head, opts), untrackedFilesPreview(top, untracked)]
    .filter(Boolean)
    .join("\n");
  const digest = createHash("sha256")
    .update(
      `${head ?? ""}\0${JSON.stringify([...branchHeads.entries()])}\0${JSON.stringify([...fileStamps.entries()])}\0${rawDiff}`,
    )
    .digest("hex");
  return {
    isGit: true,
    topLevel: top,
    head,
    branch,
    baseBranch: opts.baseBranch,
    resolvedBaseHead: bs.resolved,
    baseBranchUnborn: bs.unborn,
    branchHeads,
    fileStamps,
    rawDiff,
    diffExcerpt: rawDiff.slice(0, ESCALATION_EXCERPT_CHARS),
    digest,
  };
}

function committedBetween(top: string, from: string | undefined, to: string | undefined): string[] {
  if (to === undefined || from === to) {
    return [];
  }
  const base = from ?? emptyTree(top);
  if (base === undefined) {
    return [];
  }
  return (runGit(top, ["diff", "-z", "--no-renames", "--name-only", base, to]) ?? "")
    .split("\0")
    .filter(Boolean);
}

function addBranchRefChanges(
  top: string,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
  add: (items: Iterable<string>) => void,
): void {
  const anchor = baseline.head ?? baseline.resolvedBaseHead;
  for (const [name, tip] of current.branchHeads) {
    const prev = baseline.branchHeads.get(name);
    if (prev === tip || isUpstreamSync(top, name, tip, baseline)) {
      continue;
    }
    const from =
      prev ??
      (anchor === undefined ? undefined : trimmed(runGit(top, ["merge-base", anchor, tip])));
    add(committedBetween(top, from, tip));
  }
}

/** Files modified, added, or deleted relative to `baseline`, formatted relative to `cwd`. */
export function changedFilesSinceBaseline(
  cwd: string,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
  excludePaths?: readonly string[],
): string[] {
  const top = current.topLevel;
  if (!current.isGit || top === undefined) {
    return baseline.isGit ? ["(git-status-unavailable)"] : [];
  }
  const excluded = excludedRepoPrefixes(top, excludePaths);
  const paths = new Set<string>();
  const add = (items: Iterable<string>): void => {
    for (const f of items) {
      if (!isExcludedRepoPath(f, excluded)) {
        paths.add(f);
      }
    }
  };
  add(
    [...current.fileStamps.entries()]
      .filter(([f, s]) => baseline.fileStamps.get(f) !== s)
      .map(([f]) => f),
  );
  add(committedBetween(top, baseline.head, current.head));
  addBranchRefChanges(top, baseline, current, add);
  const realCwd = safeRealpath(cwd);
  const realTop = safeRealpath(top);
  return [...paths]
    .map((rel) => {
      const out = path.relative(realCwd, path.resolve(realTop, rel));
      return (out === "" ? rel : out).split(path.sep).join("/");
    })
    .sort();
}

function headAncestryIssue(
  top: string,
  baseBranch: string,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
): string | undefined {
  if (current.head === undefined || current.head === baseline.head) {
    return undefined;
  }
  if (baseline.baseBranchUnborn && current.resolvedBaseHead === undefined) {
    return undefined;
  }
  const anchor =
    baseline.head !== undefined && baseline.resolvedBaseHead !== undefined
      ? trimmed(runGit(top, ["merge-base", baseline.resolvedBaseHead, baseline.head]))
      : current.resolvedBaseHead;
  return anchor !== undefined &&
    runGit(top, ["merge-base", "--is-ancestor", anchor, current.head]) !== undefined
    ? undefined
    : `Current HEAD is not descended from expected baseBranch '${baseBranch}'.`;
}

function branchViolation(
  baseBranch: string | undefined,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
): string | undefined {
  if (baseBranch === undefined || !current.isGit || current.topLevel === undefined) {
    return undefined;
  }
  const localBase = current.branchHeads.get(baseBranch);
  const localBaseMutated =
    localBase !== baseline.branchHeads.get(baseBranch) &&
    !isUpstreamSync(current.topLevel, baseBranch, localBase, baseline);
  if (localBaseMutated) {
    return `Child committed directly onto base branch '${baseBranch}' instead of a task branch.`;
  }
  if (current.resolvedBaseHead === undefined && !baseline.baseBranchUnborn) {
    return `Expected baseBranch '${baseBranch}' could not be resolved in Git.`;
  }
  return headAncestryIssue(current.topLevel, baseBranch, baseline, current);
}

/** Zero-cost local checks for error loops, out-of-scope edits, and wrong Git branches. */
export function checkDeterministicTripwires(options: {
  cwd: string;
  contract: DelegationContract;
  baseline: RepoSnapshot;
  current: RepoSnapshot;
  consecutiveErrors: number;
  excludePaths?: readonly string[] | undefined;
}): ViolationCandidate | undefined {
  const { cwd, contract, baseline, current, consecutiveErrors, excludePaths } = options;
  const changedFiles = changedFilesSinceBaseline(cwd, baseline, current, excludePaths);
  const hit = (kind: Escalation["kind"], summary: string): ViolationCandidate => ({
    kind,
    summary,
    changedFiles,
    diffExcerpt: current.diffExcerpt,
    diffDigest: current.digest,
  });
  if (consecutiveErrors >= CONSECUTIVE_ERROR_TURN_LIMIT) {
    return hit(
      "loop_violation",
      `Child hit ${consecutiveErrors} consecutive turns with tool/command errors without clean progress.`,
    );
  }
  const out = changedFiles.filter((f) => !isPathAllowedByScope(cwd, f, contract.scope));
  if (out.length > 0) {
    const allowed = contract.scope.length === 0 ? "read-only ([])" : contract.scope.join(", ");
    return hit(
      "scope_violation",
      `Modified out-of-scope path(s): ${out.join(", ")} (allowed scope: ${allowed}).`,
    );
  }
  const branchIssue =
    changedFiles.length > 0 ||
    current.head !== baseline.head ||
    (contract.baseBranch !== undefined &&
      current.branchHeads.get(contract.baseBranch) !==
        baseline.branchHeads.get(contract.baseBranch))
      ? branchViolation(contract.baseBranch, baseline, current)
      : undefined;
  return branchIssue === undefined ? undefined : hit("branch_violation", branchIssue);
}

async function selectClassifier(
  registry: JudgeModelRegistry,
  spec: string,
): Promise<ClassifierModel<ClassifierApi> | undefined> {
  const available = await registry.getAvailableOfType("classifier");
  if (spec !== "auto") {
    const slash = spec.indexOf("/");
    const [provider, id] = slash > 0 ? [spec.slice(0, slash), spec.slice(slash + 1)] : ["", spec];
    const matched =
      available.find((m) => m.provider === provider && m.id === id) ??
      registry.getModelOfType("classifier", provider, id);
    if (matched === undefined) {
      throw new Error(`Configured overseer judge '${spec}' is not an available classifier model.`);
    }
    return matched;
  }
  for (const [provider, id] of PREFERRED_AUTO_JUDGES) {
    const found = available.find((m) => m.provider === provider && m.id === id);
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
  const criteria: Record<string, string> = {
    compliant: "Complies with the prompt, contract, and required primitives",
    scope_violation: "Adds unrequested features, fallbacks, or changes forbidden by nonGoals",
  };
  const req = options.contract.requiredPrimitives;
  if (req !== undefined && req.length > 0) {
    criteria.primitive_violation = `Bypasses required primitives (${req.join(", ")}) with custom wrappers or plumbing`;
  }
  return {
    state: {
      taskPrompt: options.prompt,
      contract: options.contract,
      changedFiles: options.changedFiles,
      diff: options.snapshot.rawDiff.slice(
        0,
        Math.max(4096, Math.floor(options.classifier.contextWindow * 2)),
      ),
    },
    questions: {
      verdict: {
        type: "choice",
        instructions: "Classify whether the diff complies with or violates the contract.",
        criteria,
      },
    },
  };
}

function unpackChoice(result: ClassifierResult): ClassifierChoiceAnswer | undefined {
  if (result.stopReason === "error") {
    throw new Error(
      `Overseer judge '${result.provider}/${result.model}' failed: ${result.errorMessage ?? "classifier error"}.`,
    );
  }
  return result.stopReason === "stop" && result.answers.verdict?.type === "choice"
    ? result.answers.verdict
    : undefined;
}

function interpretChoice(
  classifier: ClassifierModel<ClassifierApi>,
  ans: ClassifierChoiceAnswer | undefined,
  options: { contract: DelegationContract; changedFiles: string[]; snapshot: RepoSnapshot },
): ViolationCandidate | undefined {
  if (ans?.choice !== "primitive_violation" && ans?.choice !== "scope_violation") {
    return undefined;
  }
  const id = `${classifier.provider}/${classifier.id}`;
  const req = options.contract.requiredPrimitives?.join(", ") ?? "";
  return {
    kind: ans.choice,
    summary:
      ans.choice === "primitive_violation"
        ? `Decision judge (${id}, confidence=${ans.confidence.toFixed(2)}) flagged custom plumbing bypassing required primitives (${req}).`
        : `Decision judge (${id}, confidence=${ans.confidence.toFixed(2)}) flagged unrequested scope drift or nonGoal violation.`,
    changedFiles: options.changedFiles,
    diffExcerpt: options.snapshot.diffExcerpt,
    diffDigest: options.snapshot.digest,
  };
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
  const spec = options.judgeSpec ?? "auto";
  if (spec === "off" || options.changedFiles.length === 0 || options.snapshot.rawDiff === "") {
    return undefined;
  }
  const classifier = await selectClassifier(options.modelRegistry, spec);
  if (classifier === undefined) {
    return undefined;
  }
  const result = await options.modelRegistry.classify(
    classifier,
    buildJudgeContext({ classifier, ...options }),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return interpretChoice(classifier, unpackChoice(result), options);
}
