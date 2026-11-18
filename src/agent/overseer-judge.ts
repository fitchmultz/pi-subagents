import type {
  ClassifierApi,
  ClassifierChoiceAnswer,
  ClassifierContext,
  ClassifierModel,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  judgeUnavailableSchema,
  type DelegationContract,
  type Escalation,
  type JudgeUnavailable,
} from "./contracts.ts";
import { branchIssue, type OwnChanges, type RepoSnapshot } from "./overseer-git.ts";
import { isPathAllowedByScope } from "./overseer-scope.ts";
import { read, runDirectory, write } from "./storage.ts";

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

/** Why a checkpoint pauses the child. */
export type Violation = Pick<Escalation, "kind" | "summary">;

function scopeIssue(
  cwd: string,
  scope: readonly string[],
  changedFiles: readonly string[],
): Violation | undefined {
  const out = changedFiles.filter((f) => !isPathAllowedByScope(cwd, f, scope));
  if (out.length === 0) {
    return undefined;
  }
  const allowed = scope.length === 0 ? "read-only ([])" : scope.join(", ");
  return {
    kind: "scope_violation",
    summary: `Modified out-of-scope path(s): ${out.join(", ")} (allowed scope: ${allowed}).`,
  };
}

export function checkDeterministicTripwires(options: {
  cwd: string;
  contract: DelegationContract;
  /** The run's first snapshot. The base-branch rules hold for the whole run. */
  launch: RepoSnapshot;
  current: RepoSnapshot;
  /** The child's own changes since the last accepted snapshot. */
  changes: OwnChanges;
}): Violation | undefined {
  const { cwd, contract, launch, current, changes } = options;
  if (changes.unreadable) {
    return {
      kind: "loop_violation",
      summary: "Git status became unavailable during supervised run.",
    };
  }
  const outOfScope = scopeIssue(cwd, contract.scope, changes.files);
  if (outOfScope !== undefined) {
    return outOfScope;
  }
  const branchMoved =
    changes.files.length > 0 ||
    current.head !== launch.head ||
    current.localBaseHead !== launch.localBaseHead;
  const issue = branchMoved ? branchIssue(contract.baseBranch, launch, current) : undefined;
  return issue === undefined ? undefined : { kind: "branch_violation", summary: issue };
}

const classifierName = (model: ClassifierModel<ClassifierApi>): string =>
  `${model.provider}/${model.id}`;

/**
 * The classifiers a checkpoint may ask, in the order it asks them. A configured judge is the
 * owner's choice and has no substitute. `auto` asks the preferred classifiers first and then
 * every other available one: the judge sends text and one choice question, which every
 * classifier API answers. A classifier whose request failed earlier in the run is asked after
 * the others.
 */
async function judgeCandidates(
  registry: JudgeModelRegistry,
  spec: string,
  failed: ReadonlySet<string>,
): Promise<ClassifierModel<ClassifierApi>[]> {
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
    return [matched];
  }
  const preferred = PREFERRED_AUTO_JUDGES.flatMap(([provider, id]) => {
    const found = available.find((m) => m.provider === provider && m.id === id);
    return found === undefined ? [] : [found];
  });
  return [...new Set([...preferred, ...available])].toSorted(
    (a, b) => Number(failed.has(classifierName(a))) - Number(failed.has(classifierName(b))),
  );
}

/** The verdicts the judge can choose from. */
function judgeCriteria(contract: DelegationContract): Record<string, string> {
  const criteria: Record<string, string> = {
    compliant: "Complies with the prompt, contract, and required primitives",
    scope_violation: "Adds unrequested features, fallbacks, or changes forbidden by nonGoals",
  };
  const req = contract.requiredPrimitives;
  if (req !== undefined && req.length > 0) {
    criteria.primitive_violation = `Bypasses required primitives (${req.join(", ")}) with custom wrappers or plumbing`;
  }
  return criteria;
}

function buildJudgeContext(options: {
  classifier: ClassifierModel<ClassifierApi>;
  criteria: Record<string, string>;
  prompt: string;
  contract: DelegationContract;
  changedFiles: readonly string[];
  acceptedFiles: readonly string[];
  diff: string;
}): ClassifierContext {
  return {
    state: {
      contract: options.contract,
      changedFiles: options.changedFiles,
      acceptedFiles: options.acceptedFiles,
      diff: options.diff.slice(0, Math.max(4096, Math.floor(options.classifier.contextWindow * 2))),
      taskPrompt: options.prompt,
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "Judge ONLY `diff` against contract (requiredPrimitives and nonGoals): it holds the changes since the last accepted state of this run. `acceptedFiles` names the files changed earlier in the run; those changes were already reviewed, so do not judge them. For a file named in both, judge only what `diff` shows. Ignore earlier reverted attempts or conflicting taskPrompt wording.",
        criteria: options.criteria,
      },
    },
  };
}

function interpretChoice(
  classifier: ClassifierModel<ClassifierApi>,
  ans: ClassifierChoiceAnswer,
  contract: DelegationContract,
): Violation | undefined {
  if (ans.choice !== "primitive_violation" && ans.choice !== "scope_violation") {
    return undefined;
  }
  const id = classifierName(classifier);
  const req = contract.requiredPrimitives?.join(", ") ?? "";
  return {
    kind: ans.choice,
    summary:
      ans.choice === "primitive_violation"
        ? `Decision judge (${id}, confidence=${ans.confidence.toFixed(2)}) flagged custom plumbing bypassing required primitives (${req}).`
        : `Decision judge (${id}, confidence=${ans.confidence.toFixed(2)}) flagged unrequested scope drift or nonGoal violation.`,
  };
}

type Asked = { readonly verdict: ClassifierChoiceAnswer } | { readonly failure: string };

/**
 * Asks one classifier. A request that failed, and a response without one of the verdicts that
 * were asked for, are failures: neither says that the work complies. Rejects when `signal`
 * cancelled the request, which is no fault of the classifier.
 */
async function askClassifier(
  classifier: ClassifierModel<ClassifierApi>,
  criteria: Record<string, string>,
  options: Parameters<typeof evaluateDecisionCheckpoint>[0],
): Promise<Asked> {
  const name = classifierName(classifier);
  const result = await options.modelRegistry.classify(
    classifier,
    buildJudgeContext({ classifier, criteria, ...options }),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  if (result.stopReason === "aborted") {
    throw new Error(`The request to overseer judge '${name}' was cancelled.`);
  }
  if (result.stopReason === "error") {
    return {
      failure: `Overseer judge '${name}' failed: ${result.errorMessage ?? "classifier error"}.`,
    };
  }
  const { verdict } = result.answers;
  return verdict?.type === "choice" && Object.hasOwn(criteria, verdict.choice)
    ? { verdict }
    : { failure: `Overseer judge '${name}' failed: the response has no verdict.` };
}

/**
 * Asks the judge about the new work, unless the judge is `off`. Rejects when no classifier gave
 * a verdict: none is available, the configured judge is not an available classifier, or every
 * request failed or came back without a verdict. That is a fault of the judge and never a
 * finding about the work. Also rejects when `signal` cancelled a request, which is neither.
 */
export async function evaluateDecisionCheckpoint(options: {
  modelRegistry: JudgeModelRegistry;
  judgeSpec: string | undefined;
  prompt: string;
  contract: DelegationContract;
  /** The files of the new work, and its diff. */
  changedFiles: readonly string[];
  diff: string;
  /** Files changed earlier in the run, in states that were already accepted. */
  acceptedFiles: readonly string[];
  /** The classifiers whose request failed earlier in the run. The call adds those that fail now. */
  failed: Set<string>;
  signal: AbortSignal | undefined;
}): Promise<Violation | undefined> {
  const spec = options.judgeSpec ?? "auto";
  if (spec === "off" || options.changedFiles.length === 0 || options.diff === "") {
    return undefined;
  }
  const criteria = judgeCriteria(options.contract);
  const failures: string[] = [];
  for (const classifier of await judgeCandidates(options.modelRegistry, spec, options.failed)) {
    const asked = await askClassifier(classifier, criteria, options);
    if ("verdict" in asked) {
      return interpretChoice(classifier, asked.verdict, options.contract);
    }
    options.failed.add(classifierName(classifier));
    failures.push(asked.failure);
  }
  throw new Error(
    failures.length > 0
      ? failures.join(" ")
      : "No classifier model is available for the overseer judge.",
  );
}

const judgeUnavailableFile = (base: string, runId: string): string =>
  path.join(runDirectory(base, runId), "judge-unavailable.json");

/** Why no judge has given a verdict on the latest work of a run, when that is so. */
export const judgeUnavailable = (base: string, runId: string): JudgeUnavailable | undefined =>
  read(judgeUnavailableFile(base, runId), judgeUnavailableSchema);

/** Records, for the completion notice of the run, that its latest work has no verdict. */
export function recordJudgeUnavailable(base: string, runId: string, summary: string): void {
  const unavailable: JudgeUnavailable = { at: Date.now(), summary };
  write(judgeUnavailableFile(base, runId), unavailable);
}

/** The latest work of the run has a verdict, was approved, or is gone. */
export function clearJudgeUnavailable(base: string, runId: string): void {
  fs.rmSync(judgeUnavailableFile(base, runId), { force: true });
}
