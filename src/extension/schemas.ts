/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "../shared/native-typebox.ts";
import { SUBAGENT_ACTIONS } from "../shared/types.ts";
import { AcceptanceOverride } from "./acceptance-schema.ts";
import { ChainItemSchema } from "./chain-schema.ts";
import { AgentRunsValidationParams } from "./everyday-schemas.ts";
import {
  HistoryQueryFields,
  JsonSchemaObject,
  ModelOverride,
  OutputModeOverride,
  SkillOverride,
  TaskItem,
  requiredObject,
} from "./schema-overrides.ts";
export { AcceptanceOverride, DelegateAcceptance } from "./acceptance-schema.ts";
export { ChainItemSchema } from "./chain-schema.ts";
export { DelegateParams, AgentRunsValidationParams, AgentRunsParams } from "./everyday-schemas.ts";

const MaxOutputOverride = Type.Object(
  {
    bytes: Type.Optional(
      Type.Integer({ minimum: 1, description: "Max output bytes before truncation." }),
    ),
    lines: Type.Optional(
      Type.Integer({ minimum: 1, description: "Max output lines before truncation." }),
    ),
  },
  {
    additionalProperties: false,
    description: "Final output truncation limits. Defaults: 200KB, 5000 lines.",
  },
);

const ControlOverrides = Type.Object(
  {
    enabled: Type.Optional(
      Type.Boolean({
        description: "Enable/disable subagent control attention tracking for this run",
      }),
    ),
    needsAttentionAfterMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "No-activity window (ms) before a run needs attention. Default 600000 (10 min).",
      }),
    ),
    failedToolAttemptsBeforeAttention: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Consecutive mutating-tool failures before needs_attention (default: 3)",
      }),
    ),
    notifyOn: Type.Optional(
      Type.Array(Type.Enum(["needs_attention"] as const, { type: "string" }), {
        description:
          "Control event types that should notify the parent/orchestrator. Defaults to needs_attention.",
      }),
    ),
    notifyChannels: Type.Optional(
      Type.Array(Type.Enum(["event", "async", "intercom"] as const, { type: "string" }), {
        description:
          "Notification channels to use when available. Defaults to event, async, and intercom.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const SubagentParams = Type.Object(
  {
    agent: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Agent name; on resume/answer, adopt the current profile including model, thinking and fallbacks; a separate model override wins. Otherwise keep saved settings.",
      }),
    ),
    task: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Task (SINGLE mode, optional for self-contained agents)",
      }),
    ),
    label: TaskItem.properties.label,
    // Management action (when present, tool operates in management mode)
    action: Type.Optional(
      Type.Enum([...SUBAGENT_ACTIONS] as const, {
        type: "string",
        description:
          "Management/control action. Omit for execution mode. nudge sends a live intercom nudge to a running child.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Run id or prefix for status/interrupt/extend/resume/nudge/questions/answer/review actions.",
      }),
    ),
    runId: Type.Optional(
      Type.String({
        description:
          "Target run ID; prefer id. Defaults to the most recently active controllable run for interrupt/extend/nudge.",
      }),
    ),
    questionId: Type.Optional(
      Type.String({ minLength: 1, description: "Durable supervisor question ID for answer." }),
    ),
    decision: Type.Optional(
      Type.Enum(["accepted", "needs_changes"] as const, {
        type: "string",
        description:
          "Parent-only review decision; not sent to the child. Put actionable instructions in resume/nudge. Does not launch work or change runtime acceptance.",
      }),
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Status list offset." })),
    limit: AgentRunsValidationParams.properties.limit,
    ...HistoryQueryFields,
    full: Type.Optional(
      Type.Boolean({
        description:
          "Exact status only: include the full task and saved launch configuration; default is concise.",
      }),
    ),
    dir: Type.Optional(
      Type.String({
        description: "Async run directory for status/resume.",
      }),
    ),
    index: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Zero-based child index for actions that target a specific child.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description:
          "Follow-up for resume, nudge text, answer, or parent-only review note. Review notes are not sent to the child; put actionable instructions in resume/nudge. Use index for multi-child runs.",
      }),
    ),
    extendMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Additional ms for extend; defaults to timeoutMs/maxRuntimeMs.",
      }),
    ),
    // Chain identifier for management (can't reuse 'chain' — that's the execution array)
    chainName: Type.Optional(
      Type.String({
        description: "Chain name for get/update/delete management actions",
      }),
    ),
    // Agent/chain configuration for create/update (nested to avoid conflicts with execution fields)
    config: Type.Optional(
      Type.Unsafe({
        anyOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
        description:
          "Agent or chain config for create/update (object or JSON string). Agent keys: name, package, description, scope ('user'|'project'), systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, model, tools, allowSubagents, extensions, skills, thinking, output, reads, progress, maxSubagentDepth, maxExecutionTimeMs, maxTokens. Chain keys: name, package, description, scope, steps (array of {agent, task?, output?, outputMode?, reads?, model?, skills?, progress?}). Presence of 'steps' creates a chain.",
      }),
    ),
    tasks: Type.Optional(
      Type.Array(TaskItem, {
        minItems: 1,
        description: "PARALLEL mode: concurrent [{agent, task, ...}] tasks.",
      }),
    ),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "PARALLEL mode: max concurrent parallel tasks (default 4).",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Foreground wall-clock timeout (ms); on expiry children are soft-interrupted. When async is omitted, a timeout implies foreground execution; explicit async runs reject it. Short reviewer budgets are raised to a floor; planner/researcher budgets only from run-history data.",
      }),
    ),
    maxRuntimeMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Alias for timeoutMs; same foreground-only policy.",
      }),
    ),
    maxOutput: Type.Optional(MaxOutputOverride),
    worktree: Type.Optional(
      Type.Boolean({
        description:
          "Isolated git worktrees per parallel task; requires clean git state; per-worktree diffs included.",
      }),
    ),
    chain: Type.Optional(
      Type.Array(ChainItemSchema, {
        minItems: 1,
        description:
          "CHAIN mode: sequential pipeline; each step's response becomes {previous} for the next.",
      }),
    ),
    context: Type.Optional(
      Type.Enum(["fresh", "fork"] as const, {
        type: "string",
        description:
          "'fresh' or 'fork' (branch from parent session); overrides each agent's defaultContext. Fork is rejected for agents whose effective model uses the anthropic/ provider.",
      }),
    ),
    chainDir: Type.Optional(
      Type.String({
        description: "Directory for chain artifacts (default: temp, auto-cleaned after 24h)",
      }),
    ),
    async: Type.Optional(
      Type.Boolean({
        description:
          "Run in background. Stock top-level default: true; set false for foreground execution.",
      }),
    ),
    agentScope: Type.Optional(
      Type.Enum(["user", "project", "both"] as const, {
        type: "string",
        description:
          "Agent discovery scope: 'user', 'project', or 'both' (default; project wins collisions)",
      }),
    ),
    cwd: Type.Optional(Type.String()),
    artifacts: Type.Optional(
      Type.Boolean({ description: "Write debug artifacts (default: true)" }),
    ),
    includeProgress: Type.Optional(
      Type.Boolean({ description: "Include full progress in result (default: false)" }),
    ),
    progress: Type.Optional(
      Type.Boolean({ description: "Enable progress.md tracking for a single agent run" }),
    ),
    share: Type.Optional(
      Type.Boolean({ description: "Upload session to GitHub Gist for sharing (default: false)" }),
    ),
    sessionDir: Type.Optional(
      Type.String({ description: "Directory for session logs (default: temp)" }),
    ),
    // Clarification TUI
    clarify: Type.Optional(
      Type.Boolean({
        description: "Show TUI to preview/edit before execution; explicit true forces foreground.",
      }),
    ),
    control: Type.Optional(ControlOverrides),
    // Solo agent overrides
    output: Type.Optional(
      Type.Unsafe({
        anyOf: [{ type: "string" }, { type: "boolean" }],
        description:
          "Output file for single agent, or false to disable. Relative paths resolve against cwd.",
      }),
    ),
    outputMode: Type.Optional(OutputModeOverride),
    skill: Type.Optional(SkillOverride),
    model: ModelOverride,
    outputSchema: Type.Optional(JsonSchemaObject),
    acceptance: Type.Optional(AcceptanceOverride),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: { ...requiredObject("action"), properties: { action: { enum: ["answer"] } } },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          allOf: [
            requiredObject("questionId", "message"),
            { anyOf: [requiredObject("id"), requiredObject("runId")] },
          ],
        },
      },
      {
        if: { ...requiredObject("action"), properties: { action: { enum: ["review"] } } },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          allOf: [
            requiredObject("decision"),
            { anyOf: [requiredObject("id"), requiredObject("runId")] },
          ],
        },
      },
      {
        not: {
          anyOf: [
            requiredObject("agent", "tasks"),
            requiredObject("agent", "chain"),
            requiredObject("tasks", "chain"),
            requiredObject("cursor", "offset"),
            requiredObject("cursor", "before"),
          ],
        },
      },
      {
        if: requiredObject("decision"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { ...requiredObject("action"), properties: { action: { enum: ["review"] } } },
      },
      {
        if: { ...requiredObject("action"), properties: { action: { enum: ["history"] } } },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { anyOf: [requiredObject("id"), requiredObject("runId")] },
      },
      {
        if: { ...requiredObject("action"), properties: { action: { enum: ["search"] } } },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("query"),
      },
      {
        if: requiredObject("offset"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { ...requiredObject("action"), properties: { action: { enum: ["status"] } } },
      },
      {
        if: requiredObject("limit"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          ...requiredObject("action"),
          properties: { action: { enum: ["status", "history", "search"] } },
        },
      },
      {
        if: requiredObject("cursor"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          ...requiredObject("action"),
          properties: { action: { enum: ["status", "history", "search"] } },
        },
      },
      {
        if: requiredObject("sort"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          ...requiredObject("action"),
          properties: { action: { enum: ["status", "search"] } },
        },
      },
      {
        if: {
          allOf: [
            { ...requiredObject("action"), properties: { action: { enum: ["search"] } } },
            requiredObject("index"),
          ],
        },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { anyOf: [requiredObject("id"), requiredObject("runId")] },
      },
      {
        if: { anyOf: [requiredObject("state"), requiredObject("text")] },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { ...requiredObject("action"), properties: { action: { enum: ["status"] } } },
      },
      {
        if: requiredObject("query"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { ...requiredObject("action"), properties: { action: { enum: ["search"] } } },
      },
      {
        if: requiredObject("before"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { ...requiredObject("action"), properties: { action: { enum: ["history"] } } },
      },
      {
        if: { ...requiredObject("action"), properties: { action: { enum: ["status"] } } },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { sort: { enum: ["attention", "newest", "oldest"] } } },
      },
      {
        if: { ...requiredObject("action"), properties: { action: { enum: ["search"] } } },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { sort: { enum: ["relevance", "newest"] } } },
      },
      {
        if: requiredObject("full"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          allOf: [
            { ...requiredObject("action"), properties: { action: { enum: ["status"] } } },
            { anyOf: [requiredObject("id"), requiredObject("runId"), requiredObject("dir")] },
          ],
        },
      },
      {
        if: requiredObject("worktree"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("tasks"),
      },
      {
        if: requiredObject("concurrency"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("tasks"),
      },
      {
        if: requiredObject("chainDir"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("chain"),
      },
      {
        if: {
          anyOf: [
            requiredObject("output"),
            requiredObject("outputMode"),
            requiredObject("skill"),
            requiredObject("model"),
            requiredObject("outputSchema"),
            requiredObject("progress"),
          ],
        },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          anyOf: [
            requiredObject("agent"),
            { ...requiredObject("action"), properties: { action: { enum: ["resume", "answer"] } } },
          ],
        },
      },
      {
        if: requiredObject("acceptance"),

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          anyOf: [
            requiredObject("agent"),
            { ...requiredObject("action"), properties: { action: { enum: ["resume", "answer"] } } },
          ],
        },
      },
    ],
  },
);
