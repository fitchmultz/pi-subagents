import type { AssistantMessage, Tool } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { compile, type Static } from "@earendil-works/pi-schema";
import type { JudgeFailure } from "./contracts.ts";
import { errorText } from "./host.ts";
import { captureOwnerContext, type OverseerState } from "./overseer.ts";
import {
  assistantText,
  extractJsonObject,
  modelLabel,
  nonEmpty,
  resolveCandidates,
  type SkepticCandidate,
  type SkepticModelRegistry,
} from "./overseer-skeptic.ts";
import { Type } from "./typebox.ts";

const MIN_EXCERPT_CHARS = 6;

const HIGH_IMPACT_BASH_PATTERNS: readonly RegExp[] = [
  /\bgh(?:-[\w-]+)?\s+(?:pr\s+merge|release\s+(?:create|delete))\b/u,
  /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b/u,
  /\b(?:npm|pnpm|yarn)\s+publish\b/u,
  /\bwrangler\s+deploy\b/u,
  /\bchezmoi\s+apply\b/u,
];

export const parentFindingKindSchema = Type.Union([
  Type.Literal("contradicts_owner"),
  Type.Literal("dropped_constraint"),
  Type.Literal("unverified_action"),
]);

export const parentSkepticFindingSchema = Type.Object({
  kind: parentFindingKindSchema,
  ownerExcerpt: Type.String({ minLength: 1 }),
  actionExcerpt: Type.String({ minLength: 1 }),
  why: Type.String({ minLength: 1 }),
  blocking: Type.Boolean(),
});
export type ParentSkepticFinding = Static<typeof parentSkepticFindingSchema>;

const parentSkepticResponseSchema = Type.Object({
  action: Type.Union([Type.Literal("ok"), Type.Literal("block")]),
  findings: Type.Array(parentSkepticFindingSchema),
});
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
  readonly ownerContext: string;
  readonly action: ParentAction;
  readonly failed: Set<string>;
  readonly signal: AbortSignal | undefined;
}

const PARENT_SKEPTIC_SYSTEM_PROMPT = [
  "You are a grounded skeptic overseeing a parent coding agent before it delegates work or runs an irreversible shell command.",
  "Compare the proposed parent action ONLY against the owner's messages (oldest to newest; newest owner message wins on conflict).",
  "Do NOT block routine delegations, reasonable implementation choices, or normal workflows that align with the owner's intent.",
  "Flag ONLY clear, concrete violations: contradicts_owner (e.g. merging/pushing/deploying despite an explicit hold or rule), dropped_constraint (delegation omits or reverses an explicit owner requirement), or unverified_action (irreversible action that directly conflicts with an active owner hold).",
  "STRICT DOUBLE-GROUNDING RULE: Every finding MUST quote an exact literal `ownerExcerpt` (>= 6 chars) verbatim from the Owner messages AND an exact literal `actionExcerpt` (>= 6 chars) verbatim from the Proposed action. If you cannot quote both verbatim, return action='ok' with findings=[].",
  "Use blocking=true only when the action should be stopped before execution; use blocking=false for a minor heads-up.",
  'Submit your verdict by calling the `report_parent_findings` tool (or if unavailable, respond ONLY with valid JSON: {"action":"ok"|"block","findings":[...]}).',
].join("\n");

export function isHighImpactBash(command: string): boolean {
  return HIGH_IMPACT_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function promptAction(
  kind: "delegate" | "continue",
  baseLabel: string,
  suffix: string | undefined,
  prompt: string | undefined,
): ParentAction | undefined {
  if (prompt === undefined) {
    return undefined;
  }
  const label = suffix === undefined ? baseLabel : `${baseLabel} (${suffix})`;
  return { kind, label, text: prompt };
}

export function extractParentAction(
  toolName: string,
  input: Record<string, unknown>,
): ParentAction | undefined {
  if (toolName === "delegate") {
    return promptAction(
      "delegate",
      "delegate",
      readString(input, "name"),
      readString(input, "prompt"),
    );
  }
  if (toolName === "agent_runs" && input.action === "continue") {
    return promptAction(
      "continue",
      "agent_runs continue",
      readString(input, "id"),
      readString(input, "prompt"),
    );
  }
  if (toolName === "bash") {
    const command = readString(input, "command");
    if (command !== undefined && isHighImpactBash(command)) {
      return { kind: "bash", label: "bash", text: command };
    }
  }
  return undefined;
}

function isParentFindingGrounded(
  finding: ParentSkepticFinding,
  ownerContext: string,
  actionText: string,
): boolean {
  const ownerQuote = finding.ownerExcerpt.trim();
  const actionQuote = finding.actionExcerpt.trim();
  if (ownerQuote.length < MIN_EXCERPT_CHARS || actionQuote.length < MIN_EXCERPT_CHARS) {
    return false;
  }
  return ownerContext.includes(ownerQuote) && actionText.includes(actionQuote);
}

export function validateParentFindings(
  rawInput: unknown,
  ownerContext: string,
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
  if (parsed.value.action === "ok" || parsed.value.findings.length === 0) {
    return { ok: true, blocking: [], notes: [], droppedUngrounded: 0 };
  }
  const blocking: ParentSkepticFinding[] = [];
  const notes: ParentSkepticFinding[] = [];
  let droppedUngrounded = 0;
  for (const finding of parsed.value.findings) {
    if (!isParentFindingGrounded(finding, ownerContext, actionText)) {
      droppedUngrounded += 1;
      continue;
    }
    const clean: ParentSkepticFinding = {
      ...finding,
      ownerExcerpt: finding.ownerExcerpt.trim(),
      actionExcerpt: finding.actionExcerpt.trim(),
      why: finding.why.trim(),
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
  return [
    `## Owner messages (oldest to newest; newest wins on conflict)\n${input.ownerContext}`,
    `## Proposed parent action (${input.action.label})\n${input.action.text}`,
  ].join("\n\n");
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
  const checked = validateParentFindings(extracted.payload, input.ownerContext, input.action.text);
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
  if (input.judgeSpec === "off" || input.ownerContext.trim().length === 0) {
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
  return findings.map(
    (f) =>
      `  - [${f.kind}] Owner said "${f.ownerExcerpt}" vs action "${f.actionExcerpt}" — ${f.why}`,
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
    const ownerContext = captureOwnerContext(ctx.sessionManager);
    if (ownerContext === undefined) {
      return;
    }
    const outcome = await evaluateParentAction({
      modelRegistry: ctx.modelRegistry,
      judgeSpec: state.judge,
      ownerContext,
      action,
      failed,
      signal: ctx.signal,
    });
    return handleParentOutcome(pi, ctx, action, outcome);
  });
}
