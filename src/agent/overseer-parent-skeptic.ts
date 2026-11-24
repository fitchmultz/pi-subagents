import type { AssistantMessage, Tool } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { arr, bool, compile, obj, str, type Static } from "@earendil-works/pi-schema";
import { stringEnum } from "../shared/schema.ts";
import type { JudgeFailure } from "./contracts.ts";
import { errorText } from "./host.ts";
import {
  captureOwnerBranchContext,
  type OwnerBranchContext,
  type OverseerState,
} from "./overseer.ts";
import { isHighImpactBash } from "./overseer-bash-gate.ts";
import {
  assistantText,
  extractJsonObject,
  MIN_EXCERPT_CHARS,
  modelLabel,
  nonEmpty,
  resolveCandidates,
  type SkepticCandidate,
  type SkepticModelRegistry,
} from "./overseer-skeptic.ts";

export const parentFindingKindSchema = stringEnum([
  "contradicts_owner",
  "dropped_constraint",
  "bypass_protection",
]);

export const parentSkepticFindingSchema = obj(
  {
    kind: parentFindingKindSchema,
    ownerExcerpt: str(),
    actionExcerpt: str({ minLength: 1 }),
    why: str({ minLength: 1 }),
    blocking: bool(),
  },
  { open: true },
);
export type ParentSkepticFinding = Static<typeof parentSkepticFindingSchema>;

const parentSkepticResponseSchema = obj(
  {
    action: stringEnum(["ok", "block"]),
    findings: arr(parentSkepticFindingSchema),
  },
  { open: true },
);
const parseParentResponse = compile(parentSkepticResponseSchema, { coerce: true });

const REPORT_PARENT_FINDINGS_TOOL: Tool = {
  name: "report_parent_findings",
  description:
    "Report grounded contradictions between the parent's proposed action and owner instructions.",
  parameters: parentSkepticResponseSchema,
};

export interface ParentAction {
  readonly kind: "delegate" | "continue" | "bash";
  readonly label: string;
  readonly text: string;
}

export interface ParentSkepticVerdict {
  readonly model: string;
  readonly blocking: readonly ParentSkepticFinding[];
  readonly notes: readonly ParentSkepticFinding[];
  readonly droppedUngrounded: number;
}

export type ParentSkepticOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "aborted" }
  | { readonly kind: "unavailable"; readonly error: string }
  | { readonly kind: "verdict"; readonly verdict: ParentSkepticVerdict };

export interface ParentSkepticInput {
  readonly modelRegistry: SkepticModelRegistry;
  readonly judgeSpec: string;
  readonly context: OwnerBranchContext;
  readonly action: ParentAction;
  readonly failed: Set<string>;
  readonly signal: AbortSignal | undefined;
}

const PARENT_SKEPTIC_SYSTEM_PROMPT = [
  "You are a grounded skeptic overseeing a parent coding agent before it delegates work or runs an irreversible shell command.",
  "Compare the proposed parent action against the owner's active instructions in chronological order (oldest to newest). Owner decisions arrive in BOTH `[Owner]` chat messages and `[Owner answered ask_question]` `A:` answers — newest owner decision wins across BOTH channels.",
  "`[Assistant before owner reply]` and `Recent parent updates since last owner turn` are context only (never owner authority) so you can understand short owner replies (`a`, `yes`, `both`, `approved`, `lock it in`) and see completed work, posted notices, and verified PR/CI state.",
  "LIFTED HOLDS: When `[Assistant before owner reply]` presented a walkthrough, restatement, or options and `[Owner]` replied affirmatively (or `[Owner answered ask_question]` chose a path), treat the earlier pause/review/hold for that work as satisfied and lifted.",
  "NO ABSENCE-OF-PROOF BLOCKING: Do NOT block merely because verification (CI status, review state, standalone-vs-stacked PR check, merged branch status, or prior steps) is not repeated inside the shell command itself. Rules about `gh stack merge` apply ONLY when evidence shows the PR is part of a stack — never assume a `gh pr merge` targets a stacked PR. Independent single-issue PRs do NOT violate a `gh stack` rule. A narrow follow-up approving one step (e.g. 'publish the PR') does NOT revoke earlier merge authorization unless the owner states a new hold. Acting on one repo/PR in one command does not drop other repos/PRs unless it explicitly cancels or skips them.",
  "Do NOT block routine delegations, reasonable implementation choices, or normal workflows that align with the owner's intent.",
  "Flag ONLY clear, concrete violations:",
  "- `bypass_protection`: the command passes a protection-bypass flag (`--admin` on `gh pr merge`, `--no-verify` / `-n` on `git commit` or `git push`) WITHOUT explicit owner authorization for that bypass in the conversation. Quote the literal bypass command/flag in `actionExcerpt` (`ownerExcerpt` may be empty if the owner did not repeat the standing protection rule in chat).",
  "- `contradicts_owner`: the action affirmatively violates an ACTIVE, UNREVERSED owner instruction or hold (e.g. pushing/merging/deploying despite an unreversed hold, mutating production when forbidden, or running a risky step while skipping an explicit owner requirement to post a pre-action warning/flag/emoji that has NOT yet appeared in `Recent parent updates`).",
  "- `dropped_constraint`: a delegation, steering prompt, or PR-creation command affirmatively drops or reverses an active owner constraint (e.g. telling a child not to push after the owner asked to push ASAP, instructing heavy local tests when forbidden, or bundling multiple distinct subsystems/migrations into a single monolithic `gh pr create` PR — especially when another PR will stack on top — despite an active owner rule requiring focused/stacked PRs).",
  "STRICT DOUBLE-GROUNDING RULE: For `contradicts_owner` and `dropped_constraint`, every finding MUST quote an exact literal `ownerExcerpt` (>= 6 chars) verbatim from an `[Owner]` message or an `[Owner answered ask_question]` `A:` answer (NEVER from assistant text) AND an exact literal `actionExcerpt` (>= 6 chars) verbatim from the Proposed action. For `bypass_protection`, `actionExcerpt` (>= 6 chars) MUST be verbatim from the Proposed action (and include the bypass flag); `ownerExcerpt` is optional. If you cannot satisfy grounding, return action='ok' with findings=[].",
  "Use blocking=true ONLY for an unambiguous active violation that must stop before execution; use blocking=false for minor heads-ups or uncertain edge cases.",
  'Submit your verdict by calling the `report_parent_findings` tool (or if unavailable, respond ONLY with valid JSON: {"action":"ok"|"block","findings":[...]}).',
].join("\n");

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

const ACTION_META_KEYS = ["id", "name", "cwd", "readOnly", "context", "model", "thinking"] as const;

function formatActionInput(input: Record<string, unknown>, prompt: string): string {
  const meta: Record<string, unknown> = {};
  for (const key of ACTION_META_KEYS) {
    if (input[key] !== undefined) {
      meta[key] = input[key];
    }
  }
  return Object.keys(meta).length === 0
    ? prompt
    : `Arguments: ${JSON.stringify(meta)}\nPrompt:\n${prompt}`;
}

function promptAction(
  kind: "delegate" | "continue",
  baseLabel: string,
  suffix: string | undefined,
  input: Record<string, unknown>,
): ParentAction | undefined {
  const prompt = readString(input, "prompt");
  if (prompt === undefined) {
    return undefined;
  }
  const label = suffix === undefined ? baseLabel : `${baseLabel} (${suffix})`;
  return { kind, label, text: formatActionInput(input, prompt) };
}

export function extractParentAction(
  toolName: string,
  input: Record<string, unknown>,
): ParentAction | undefined {
  if (toolName === "delegate") {
    return promptAction("delegate", "delegate", readString(input, "name"), input);
  }
  if (toolName === "agent_runs" && input.action === "continue") {
    return promptAction("continue", "agent_runs continue", readString(input, "id"), input);
  }
  if (toolName === "bash") {
    const command = readString(input, "command");
    if (command !== undefined && isHighImpactBash(command)) {
      return { kind: "bash", label: "bash", text: command };
    }
  }
  return undefined;
}

const normalizeWhitespace = (text: string): string => text.replace(/\s+/gu, " ").trim();

const BYPASS_FLAG_PATTERN =
  /(?:^|\s)(?:--admin|--no-verify)(?:\s|$)|\bgit\b[^;\n|&]*\bcommit\b[^;\n|&]*\s-[a-z]*n[a-z]*(?:\s|$)/u;

function matchesOwnerGroundable(
  ownerQuote: string,
  ownerGroundable: string | readonly string[],
): boolean {
  const normalizedQuote = normalizeWhitespace(ownerQuote);
  if (normalizedQuote.length < MIN_EXCERPT_CHARS) {
    return false;
  }
  return typeof ownerGroundable === "string"
    ? normalizeWhitespace(ownerGroundable).includes(normalizedQuote)
    : ownerGroundable.some((text) => normalizeWhitespace(text).includes(normalizedQuote));
}

function isParentFindingGrounded(
  finding: ParentSkepticFinding,
  ownerGroundable: string | readonly string[],
  actionText: string,
): boolean {
  const ownerQuote = finding.ownerExcerpt.trim();
  const actionQuote = finding.actionExcerpt.trim();
  const normalizedActionQuote = normalizeWhitespace(actionQuote);
  if (
    normalizedActionQuote.length < MIN_EXCERPT_CHARS ||
    !normalizeWhitespace(actionText).includes(normalizedActionQuote)
  ) {
    return false;
  }
  if (finding.kind === "bypass_protection") {
    if (!BYPASS_FLAG_PATTERN.test(normalizedActionQuote)) {
      return false;
    }
    return ownerQuote.length === 0 || matchesOwnerGroundable(ownerQuote, ownerGroundable);
  }
  return matchesOwnerGroundable(ownerQuote, ownerGroundable);
}

export function validateParentFindings(
  rawInput: unknown,
  ownerGroundable: string | readonly string[],
  actionText: string,
):
  | {
      readonly ok: true;
      readonly blocking: ParentSkepticFinding[];
      readonly notes: ParentSkepticFinding[];
      readonly droppedUngrounded: number;
    }
  | { readonly ok: false; readonly reason: string } {
  const raw = typeof rawInput === "string" ? extractJsonObject(rawInput) : rawInput;
  if (raw === undefined) {
    return { ok: false, reason: "response did not contain valid JSON" };
  }
  const parsed = parseParentResponse.parse(raw);
  if (!parsed.ok) {
    return { ok: false, reason: "response JSON did not match parent skeptic schema" };
  }
  if (parsed.value.findings.length === 0) {
    return { ok: true, blocking: [], notes: [], droppedUngrounded: 0 };
  }
  const blocking: ParentSkepticFinding[] = [];
  const notes: ParentSkepticFinding[] = [];
  let droppedUngrounded = 0;
  const allowBlocking = parsed.value.action === "block";
  for (const finding of parsed.value.findings) {
    if (!isParentFindingGrounded(finding, ownerGroundable, actionText)) {
      droppedUngrounded += 1;
      continue;
    }
    const clean: ParentSkepticFinding = {
      ...finding,
      ownerExcerpt: finding.ownerExcerpt.trim(),
      actionExcerpt: finding.actionExcerpt.trim(),
      why: finding.why.trim(),
      blocking: allowBlocking && finding.blocking,
    };
    (clean.blocking ? blocking : notes).push(clean);
  }
  return { ok: true, blocking, notes, droppedUngrounded };
}

function extractParentPayload(
  message: AssistantMessage,
):
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly reason: string } {
  for (const block of message.content) {
    if (block.type === "toolCall" && block.name === REPORT_PARENT_FINDINGS_TOOL.name) {
      if (block.argumentsError !== undefined) {
        return {
          ok: false,
          reason: nonEmpty(block.argumentsError, "invalid report_parent_findings call"),
        };
      }
      return { ok: true, payload: block.arguments };
    }
  }
  return { ok: true, payload: assistantText(message) };
}

function buildParentUserMessage(input: ParentSkepticInput): string {
  const sections = [
    `## Owner conversation (oldest to newest; newest owner decision wins across [Owner] and [Owner answered ask_question])\n${input.context.ownerConversation}`,
  ];
  if (input.context.recentAssistantUpdates.length > 0) {
    sections.push(
      `## Recent parent updates since last owner turn (context only — NOT owner authority)\n${input.context.recentAssistantUpdates.join("\n\n")}`,
    );
  }
  sections.push(`## Proposed parent action (${input.action.label})\n${input.action.text}`);
  return sections.join("\n\n");
}

type AskParentOutcome =
  | { readonly verdict: ParentSkepticVerdict }
  | { readonly failure: JudgeFailure };

async function askParentSkeptic(
  candidate: SkepticCandidate,
  input: ParentSkepticInput,
): Promise<AskParentOutcome> {
  const label = modelLabel(candidate.model, candidate.thinking);
  const message = await input.modelRegistry
    .streamSimple(
      candidate.model,
      {
        systemPrompt: PARENT_SKEPTIC_SYSTEM_PROMPT,
        tools: [REPORT_PARENT_FINDINGS_TOOL],
        messages: [{ role: "user", content: buildParentUserMessage(input), timestamp: Date.now() }],
      },
      {
        ...(candidate.thinking !== undefined && candidate.model.reasoning
          ? { reasoning: candidate.thinking }
          : {}),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    )
    .result();
  if (message.stopReason === "aborted") {
    throw new Error(`Parent overseer skeptic '${label}' request was cancelled.`);
  }
  if (message.stopReason === "error") {
    return { failure: { model: label, reason: nonEmpty(message.errorMessage, "model error") } };
  }
  const extracted = extractParentPayload(message);
  if (!extracted.ok) {
    return { failure: { model: label, reason: extracted.reason } };
  }
  const checked = validateParentFindings(
    extracted.payload,
    input.context.ownerTexts,
    input.action.text,
  );
  if (!checked.ok) {
    return { failure: { model: label, reason: checked.reason } };
  }
  return {
    verdict: {
      model: label,
      blocking: checked.blocking,
      notes: checked.notes,
      droppedUngrounded: checked.droppedUngrounded,
    },
  };
}

export async function evaluateParentAction(
  input: ParentSkepticInput,
): Promise<ParentSkepticOutcome> {
  if (input.judgeSpec === "off" || input.context.ownerTexts.length === 0) {
    return { kind: "skipped" };
  }
  try {
    const candidates = resolveCandidates(input.modelRegistry, input.judgeSpec, input.failed);
    const failures: JudgeFailure[] = [];
    for (const candidate of candidates) {
      const asked = await askParentSkeptic(candidate, input);
      if ("verdict" in asked) {
        return { kind: "verdict", verdict: asked.verdict };
      }
      input.failed.add(asked.failure.model);
      failures.push(asked.failure);
    }
    const error =
      failures.length > 0
        ? failures.map((f) => `Overseer judge '${f.model}' failed: ${f.reason}.`).join(" ")
        : "No overseer judge model is available.";
    return { kind: "unavailable", error };
  } catch (error) {
    if (input.signal?.aborted === true) {
      return { kind: "aborted" };
    }
    return { kind: "unavailable", error: nonEmpty(errorText(error), "model error") };
  }
}

function formatParentFindings(findings: readonly ParentSkepticFinding[]): string[] {
  return findings.map((f) =>
    f.ownerExcerpt.length > 0
      ? `  - [${f.kind}] Owner said "${f.ownerExcerpt}" vs action "${f.actionExcerpt}" — ${f.why}`
      : `  - [${f.kind}] Action "${f.actionExcerpt}" — ${f.why}`,
  );
}

function formatParentBlockReason(action: ParentAction, verdict: ParentSkepticVerdict): string {
  return [
    `Overseer skeptic (${verdict.model}) blocked ${action.label}:`,
    ...formatParentFindings(verdict.blocking),
    "Fix the action to match the owner's instructions or ask the owner before proceeding.",
  ].join("\n");
}

function handleParentOutcome(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: ParentAction,
  outcome: ParentSkepticOutcome,
): ToolCallEventResult | undefined {
  if (outcome.kind === "unavailable") {
    if (ctx.hasUI) {
      ctx.ui.notify(`Overseer parent check skipped: ${outcome.error}`, "warning");
    }
    return undefined;
  }
  if (outcome.kind !== "verdict") {
    return undefined;
  }
  if (outcome.verdict.blocking.length > 0) {
    return { block: true, reason: formatParentBlockReason(action, outcome.verdict) };
  }
  if (outcome.verdict.notes.length > 0) {
    pi.sendMessage(
      {
        customType: "overseer-note",
        display: true,
        content: [
          `[Overseer parent heads-up (non-blocking) - ${outcome.verdict.model}] Before ${action.label}:`,
          ...formatParentFindings(outcome.verdict.notes),
        ].join("\n"),
        details: { scope: "parent", action: action.label, findings: outcome.verdict.notes },
      },
      { triggerTurn: false },
    );
  }
  return undefined;
}

export function attachParentSkeptic(pi: ExtensionAPI, currentState: () => OverseerState): void {
  const failed = new Set<string>();
  pi.on("tool_call", async (event, ctx) => {
    const state = currentState();
    if (!state.enabled || state.judge === "off") {
      return;
    }
    const action = extractParentAction(event.toolName, event.input);
    if (action === undefined) {
      return;
    }
    const context = captureOwnerBranchContext(ctx.sessionManager);
    if (context === undefined) {
      return;
    }
    const outcome = await evaluateParentAction({
      modelRegistry: ctx.modelRegistry,
      judgeSpec: state.judge,
      context,
      action,
      failed,
      signal: ctx.signal,
    });
    return handleParentOutcome(pi, ctx, action, outcome);
  });
}
