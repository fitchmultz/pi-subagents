import type {
  ClassifierApi,
  ClassifierChoiceAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DelegationContract, Escalation } from "./contracts.ts";
import { branchIssue, type OwnChanges, type RepoSnapshot } from "./overseer-git.ts";
import { isPathAllowedByScope } from "./overseer-scope.ts";

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
  consecutiveErrors: number;
}): Violation | undefined {
  const { cwd, contract, launch, current, changes, consecutiveErrors } = options;
  if (consecutiveErrors >= CONSECUTIVE_ERROR_TURN_LIMIT) {
    return {
      kind: "loop_violation",
      summary: `Child hit ${consecutiveErrors} consecutive turns with tool/command errors without clean progress.`,
    };
  }
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
  changedFiles: readonly string[];
  acceptedFiles: readonly string[];
  diff: string;
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
  contract: DelegationContract,
): Violation | undefined {
  if (ans?.choice !== "primitive_violation" && ans?.choice !== "scope_violation") {
    return undefined;
  }
  const id = `${classifier.provider}/${classifier.id}`;
  const req = contract.requiredPrimitives?.join(", ") ?? "";
  return {
    kind: ans.choice,
    summary:
      ans.choice === "primitive_violation"
        ? `Decision judge (${id}, confidence=${ans.confidence.toFixed(2)}) flagged custom plumbing bypassing required primitives (${req}).`
        : `Decision judge (${id}, confidence=${ans.confidence.toFixed(2)}) flagged unrequested scope drift or nonGoal violation.`,
  };
}

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
  signal: AbortSignal | undefined;
}): Promise<Violation | undefined> {
  const spec = options.judgeSpec ?? "auto";
  if (spec === "off" || options.changedFiles.length === 0 || options.diff === "") {
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
  return interpretChoice(classifier, unpackChoice(result), options.contract);
}
