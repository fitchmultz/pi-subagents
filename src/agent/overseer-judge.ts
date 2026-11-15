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
  readonly localBaseHead: string | undefined;
  readonly resolvedBaseHead: string | undefined;
  readonly baseBranchUnborn: boolean;
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

function trimmed(value: string | undefined): string | undefined {
  const s = value?.trim();
  return s !== undefined && s.length > 0 ? s : undefined;
}

function safeReal(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function excludedPrefixes(topLevel: string, paths: readonly string[] | undefined): string[] {
  if (paths === undefined || paths.length === 0) {
    return [];
  }
  const top = safeReal(topLevel);
  return paths.flatMap((raw) => {
    const rel = path.relative(top, safeReal(raw));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
      ? [rel.split(path.sep).join("/")]
      : [];
  });
}

function isExcluded(relPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => relPath === p || relPath.startsWith(`${p}/`));
}

function fileStamp(topLevel: string, relPath: string, code: string): string {
  try {
    const st = fs.lstatSync(path.resolve(topLevel, relPath));
    return `${code}:${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return `${code}:missing`;
  }
}

function isRenameOrCopy(st: string): boolean {
  return st[0] === "R" || st[0] === "C" || st[1] === "R" || st[1] === "C";
}

function setStamp(
  stamps: Map<string, string>,
  relPath: string,
  stamp: string,
  excluded: readonly string[],
): void {
  if (relPath.length > 0 && !isExcluded(relPath, excluded)) {
    stamps.set(relPath, stamp);
  }
}

function parsePorcelainZ(
  top: string,
  raw: string,
  excluded: readonly string[],
): Map<string, string> {
  const stamps = new Map<string, string>();
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length;) {
    const entry = tokens[i] ?? "";
    i += 1;
    if (entry.length < 4) {
      continue;
    }
    const st = entry.slice(0, 2);
    setStamp(stamps, entry.slice(3), fileStamp(top, entry.slice(3), st), excluded);
    if (isRenameOrCopy(st) && i < tokens.length) {
      const orig = tokens[i] ?? "";
      i += 1;
      if (!stamps.has(orig)) {
        setStamp(stamps, orig, `${st}:orig`, excluded);
      }
    }
  }
  return stamps;
}

function untrackedPreview(top: string, files: readonly string[]): string {
  const chunks: string[] = [];
  let budget = 4000;
  for (const rel of files) {
    if (budget <= 0) {
      break;
    }
    try {
      const full = path.resolve(top, rel);
      const st = fs.statSync(full);
      if (st.isFile() && st.size <= 32768) {
        const snippet = fs.readFileSync(full, "utf8").slice(0, Math.min(1200, budget));
        chunks.push(`+++ new file: ${rel}\n${snippet}`);
        budget -= snippet.length;
      }
    } catch {
      // Ignore concurrent deletion.
    }
  }
  return chunks.join("\n");
}

function refCommit(top: string, ref: string): string | undefined {
  return trimmed(runGit(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
}

function baseState(
  top: string,
  baseBranch: string | undefined,
  head: string | undefined,
): { local: string | undefined; resolved: string | undefined; unborn: boolean } {
  if (baseBranch === undefined) {
    return { local: undefined, resolved: undefined, unborn: false };
  }
  const local = refCommit(top, `refs/heads/${baseBranch}`);
  const resolved =
    local ?? refCommit(top, baseBranch) ?? refCommit(top, `refs/remotes/origin/${baseBranch}`);
  return {
    local,
    resolved,
    unborn:
      resolved === undefined &&
      head === undefined &&
      trimmed(runGit(top, ["rev-list", "-n", "1", "--all"])) === undefined,
  };
}

function emptyTree(top: string): string | undefined {
  return trimmed(runGit(top, ["hash-object", "-t", "tree", "/dev/null"]));
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
    return {
      isGit: false,
      topLevel: undefined,
      head: undefined,
      branch: undefined,
      localBaseHead: undefined,
      resolvedBaseHead: undefined,
      baseBranchUnborn: false,
      fileStamps: new Map(),
      rawDiff: "",
      diffExcerpt: "",
      diffLines: 0,
      digest: "non-git",
    };
  }
  const head = trimmed(runGit(top, ["rev-parse", "--verify", "HEAD"]));
  const branch = trimmed(runGit(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  const bs = baseState(top, opts.baseBranch, head);
  const fileStamps = parsePorcelainZ(top, statusRaw, excludedPrefixes(top, opts.excludePaths));
  const untracked = [...fileStamps.entries()]
    .filter(([, c]) => c.startsWith("??:"))
    .map(([f]) => f);
  const rawDiff = [trackedDiff(top, head, opts), untrackedPreview(top, untracked)]
    .filter(Boolean)
    .join("\n");
  const digest = createHash("sha256")
    .update(
      `${head ?? ""}\0${bs.local ?? ""}\0${JSON.stringify([...fileStamps.entries()])}\0${rawDiff}`,
    )
    .digest("hex");
  return {
    isGit: true,
    topLevel: top,
    head,
    branch,
    localBaseHead: bs.local,
    resolvedBaseHead: bs.resolved,
    baseBranchUnborn: bs.unborn,
    fileStamps,
    rawDiff,
    diffExcerpt: rawDiff.slice(0, ESCALATION_EXCERPT_CHARS),
    diffLines: rawDiff === "" ? 0 : rawDiff.split("\n").length,
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

/** Files modified, added, or deleted relative to `baseline`, formatted relative to `cwd`. */
export function changedFilesSinceBaseline(
  cwd: string,
  baseline: RepoSnapshot,
  current: RepoSnapshot,
  excludePaths?: readonly string[],
): string[] {
  const top = current.topLevel;
  if (!current.isGit || top === undefined) {
    return [];
  }
  const excluded = excludedPrefixes(top, excludePaths);
  const paths = new Set<string>();
  const add = (items: Iterable<string>): void => {
    for (const f of items) {
      if (!isExcluded(f, excluded)) {
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
  if (current.localBaseHead !== baseline.localBaseHead) {
    add(committedBetween(top, baseline.localBaseHead, current.localBaseHead));
  }
  const realCwd = safeReal(cwd);
  const realTop = safeReal(top);
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
  if (
    current.localBaseHead !== baseline.localBaseHead ||
    (current.branch === baseBranch && current.head !== baseline.head)
  ) {
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
    current.localBaseHead !== baseline.localBaseHead
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
    const provider = slash > 0 ? spec.slice(0, slash) : "";
    const id = slash > 0 ? spec.slice(slash + 1) : spec;
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
    compliant: "Stays directly focused on the task prompt, contract, and required primitives",
    scope_violation:
      "Introduces unrequested features, speculative fallbacks, or changes forbidden by nonGoals",
  };
  const req = options.contract.requiredPrimitives;
  if (req !== undefined && req.length > 0) {
    criteria.primitive_violation = `Reimplements or bypasses required primitives (${req.join(", ")}) with custom wrappers, caches, or manual plumbing`;
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
        instructions:
          "Select whether the diff complies with the delegation contract or clearly violates it.",
        criteria,
      },
    },
  };
}

function unpackChoice(result: ClassifierResult): ClassifierChoiceAnswer | undefined {
  if (result.stopReason !== "stop") {
    if (result.stopReason === "error") {
      throw new Error(
        `Overseer judge '${result.provider}/${result.model}' failed: ${result.errorMessage ?? "classifier error"}.`,
      );
    }
    return undefined;
  }
  const ans = result.answers.verdict;
  return ans?.type === "choice" ? ans : undefined;
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
