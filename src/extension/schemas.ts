/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "typebox";
import { SUBAGENT_ACTIONS } from "../shared/types.ts";

const SkillOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string", minLength: 1 } },
		{ type: "boolean" },
		{ type: "string" },
	],
	description: "Skill name(s): string, comma-separated string, array, or false to disable",
});

const OutputOverride = Type.Unsafe({
	anyOf: [
		{ type: "string", minLength: 1 },
		{ type: "boolean" },
	],
	description: "Output file path, or false to disable file output.",
});

const OutputModeOverride = Type.Enum(["inline", "file-only"] as const, {
	type: "string",
	description: "inline (default) or file-only; file-only requires output to be a path.",
});

const ReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string", minLength: 1 } },
		{ type: "boolean" },
	],
	description: "Files to read before running, or false to disable",
});

const MaxOutputOverride = Type.Object({
	bytes: Type.Optional(Type.Integer({ minimum: 1, description: "Max output bytes before truncation." })),
	lines: Type.Optional(Type.Integer({ minimum: 1, description: "Max output lines before truncation." })),
}, {
	additionalProperties: false,
	description: "Final output truncation limits. Defaults: 200KB, 5000 lines.",
});

const JsonSchemaObject = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	description: "JSON Schema (object root) for strict structured output.",
});

const AcceptanceEvidenceKind = Type.Enum([
	"changed-files",
	"tests-added",
	"commands-run",
	"validation-output",
	"residual-risks",
	"no-staged-files",
	"diff-summary",
	"review-findings",
	"manual-notes",
] as const, { type: "string" });

const AcceptanceGateSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	must: Type.String({ minLength: 1 }),
	evidence: Type.Optional(Type.Array(AcceptanceEvidenceKind)),
	severity: Type.Optional(Type.Enum(["required", "recommended"] as const, { type: "string" })),
}, { additionalProperties: false });

const AcceptanceVerifyCommandSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	command: Type.String({ minLength: 1 }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	cwd: Type.Optional(Type.String()),
	env: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: { type: "string" } })),
	allowFailure: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const AcceptanceOverride = Type.Unsafe({
	type: "object",
	properties: {
		criteria: {
			type: "array",
			items: {
				anyOf: [
					{ type: "string", minLength: 1 },
					AcceptanceGateSchema,
				],
			},
		},
		evidence: { type: "array", items: AcceptanceEvidenceKind },
		verify: { type: "array", items: AcceptanceVerifyCommandSchema },
		stopRules: { type: "array", items: { type: "string", minLength: 1 } },
		maxFinalizationTurns: { type: "integer", minimum: 1, maximum: 10 },
	},
	additionalProperties: false,
	description: "Optional acceptance contract. criteria=definition of done, evidence/verify=proof, stopRules=constraints, maxFinalizationTurns=self-review budget; at least one required. See the pi-subagents skill.",
});

const TaskItem = Type.Object({
	agent: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking for this task" })),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
	skill: Type.Optional(SkillOverride),
	acceptance: Type.Optional(AcceptanceOverride),
}, { additionalProperties: false });

// Parallel task item (within a parallel step)
const ParallelTaskSchema = Type.Object({
	agent: Type.String({ minLength: 1 }),
	task: Type.Optional(Type.String({ minLength: 1, description: "Task template with {task}, {previous}, {chain_dir} variables. Defaults to {previous}." })),
	phase: Type.Optional(Type.String({ description: "Phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "User-facing label for this parallel task." })),
	as: Type.Optional(Type.String({ description: "Safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times." })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
	acceptance: Type.Optional(AcceptanceOverride),
}, { additionalProperties: false });

const DynamicExpandSchema = Type.Object({
	from: Type.Object({
		output: Type.String({ description: "Prior named structured output to expand from." }),
		path: Type.String({ description: "JSON Pointer into the structured output, e.g. /items." }),
	}, { additionalProperties: false }),
	item: Type.Optional(Type.String({ description: "Template variable name for each item. Defaults to item." })),
	key: Type.Optional(Type.String({ description: "JSON Pointer relative to each item for stable child ids." })),
	maxItems: Type.Optional(Type.Integer({ minimum: 0, description: "Required fanout bound unless configured globally." })),
	onEmpty: Type.Optional(Type.Enum(["skip", "fail"] as const, { type: "string", description: "Empty input behavior. Defaults to skip." })),
}, { additionalProperties: false });

const DynamicParallelTemplateSchema = Type.Object({
	agent: Type.String({ minLength: 1 }),
	task: Type.Optional(Type.String({ description: "Task template with {item}, {item.path}, {task}, {previous}, {chain_dir}, {outputs.name} variables." })),
	phase: Type.Optional(Type.String({ description: "Phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "User-facing label; item templates supported." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
	acceptance: Type.Optional(AcceptanceOverride),
}, { additionalProperties: false });

const DynamicCollectSchema = Type.Object({
	as: Type.String({ description: "Safe output name for the ordered collected result array." }),
	outputSchema: Type.Optional(JsonSchemaObject),
}, { additionalProperties: false });

// Flattened so chain steps do not need an object-shape anyOf/oneOf union.
export const ChainItemSchema = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1, description: "Sequential step agent name" })),
	task: Type.Optional(Type.String({
		description: "Task template: {task}=original request, {previous}=prior step response, {chain_dir}=shared folder, {outputs.name}=prior named output. Required for first step; defaults to '{previous}'."
	})),
	phase: Type.Optional(Type.String({ description: "Phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "User-facing label for this chain step." })),
	as: Type.Optional(Type.String({ description: "Safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this step" })),
	acceptance: Type.Optional(AcceptanceOverride),
	parallel: Type.Optional(Type.Unsafe({
		anyOf: [
			Type.Array(ParallelTaskSchema, { minItems: 1, description: "Tasks to run in parallel" }),
			DynamicParallelTemplateSchema,
		],
		description: "Static parallel tasks array, or a single dynamic fanout child template when expand/collect are present.",
	})),
	expand: Type.Optional(DynamicExpandSchema),
	collect: Type.Optional(DynamicCollectSchema),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for each parallel task."
	})),
}, {
	description: "Chain step: {agent, task?} sequential, {parallel: [...]} concurrent, or {expand, parallel: {...}, collect} dynamic fanout.",
	additionalProperties: false,
	allOf: [
		{ anyOf: [{ required: ["agent"] }, { required: ["parallel"] }] },
		{ not: { required: ["agent", "parallel"] } },
		{ if: { required: ["expand"] }, then: { required: ["parallel", "collect"], properties: { parallel: { type: "object" } } } },
		{ if: { required: ["collect"] }, then: { required: ["expand", "parallel"], properties: { parallel: { type: "object" } } } },
		{ not: { required: ["expand"], properties: { parallel: { type: "array", items: {} } } } },
	],
});

const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable/disable subagent control attention tracking for this run" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "No-activity window (ms) before a run needs attention. Default 600000 (10 min)." })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before needs_attention (default: 3)" })),
	notifyOn: Type.Optional(Type.Array(Type.Enum(["needs_attention"] as const, { type: "string" }), {
		description: "Control event types that should notify the parent/orchestrator. Defaults to needs_attention.",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.Enum(["event", "async", "intercom"] as const, { type: "string" }), {
		description: "Notification channels to use when available. Defaults to event, async, and intercom.",
	})),
}, { additionalProperties: false });

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1, description: "Agent name (SINGLE mode) or target for management get/update/delete" })),
	task: Type.Optional(Type.String({ description: "Task (SINGLE mode, optional for self-contained agents)" })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.Enum([...SUBAGENT_ACTIONS] as const, {
		type: "string",
		description: "Management/control action. Omit for execution mode. nudge sends a live intercom nudge to a running child."
	})),
	id: Type.Optional(Type.String({
		description: "Run id or prefix for status/interrupt/extend/resume/nudge actions."
	})),
	runId: Type.Optional(Type.String({
		description: "Target run ID; prefer id. Defaults to the most recently active controllable run for interrupt/extend/nudge."
	})),
	dir: Type.Optional(Type.String({
		description: "Async run directory for status/resume."
	})),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for actions that target a specific child." })),
	message: Type.Optional(Type.String({ description: "Follow-up message for resume, or nudge text. Use index to pick a child in multi-child runs." })),
	extendMs: Type.Optional(Type.Integer({ minimum: 1, description: "Additional ms for extend; defaults to timeoutMs/maxRuntimeMs." })),
	// Chain identifier for management (can't reuse 'chain' — that's the execution array)
	chainName: Type.Optional(Type.String({
		description: "Chain name for get/update/delete management actions"
	})),
	// Agent/chain configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "object", additionalProperties: true },
			{ type: "string" },
		],
		description: "Agent or chain config for create/update (object or JSON string). Agent keys: name, package, description, scope ('user'|'project'), systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, model, tools, allowSubagents, extensions, skills, thinking, output, reads, progress, maxSubagentDepth, maxExecutionTimeMs, maxTokens. Chain keys: name, package, description, scope, steps (array of {agent, task?, output?, outputMode?, reads?, model?, skills?, progress?}). Presence of 'steps' creates a chain."
	})),
	tasks: Type.Optional(Type.Array(TaskItem, { minItems: 1, description: "PARALLEL mode: concurrent [{agent, task, ...}] tasks." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "PARALLEL mode: max concurrent parallel tasks (default 4)." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Foreground wall-clock timeout (ms); on expiry children are soft-interrupted. When async is omitted, a timeout implies foreground execution; explicit async runs reject it. Short reviewer budgets are raised to a floor; planner/researcher budgets only from run-history data." })),
	maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1, description: "Alias for timeoutMs; same foreground-only policy." })),
	maxOutput: Type.Optional(MaxOutputOverride),
	worktree: Type.Optional(Type.Boolean({
		description: "Isolated git worktrees per parallel task; requires clean git state; per-worktree diffs included."
	})),
	chain: Type.Optional(Type.Array(ChainItemSchema, { minItems: 1, description: "CHAIN mode: sequential pipeline; each step's response becomes {previous} for the next." })),
	context: Type.Optional(Type.Enum(["fresh", "fork"] as const, {
		type: "string",
		description: "'fresh' or 'fork' (branch from parent session); overrides each agent's defaultContext. Fork is rejected for agents whose effective model uses the anthropic/ provider.",
	})),
	chainDir: Type.Optional(Type.String({ description: "Directory for chain artifacts (default: temp, auto-cleaned after 24h)" })),
	async: Type.Optional(Type.Boolean({ description: "Run in background. Stock top-level default: true; set false for foreground execution." })),
	agentScope: Type.Optional(Type.Enum(["user", "project", "both"] as const, { type: "string", description: "Agent discovery scope: 'user', 'project', or 'both' (default; project wins collisions)" })),
	cwd: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking for a single agent run" })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist for sharing (default: false)" })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory for session logs (default: temp)" }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show TUI to preview/edit before execution; explicit true forces foreground." })),
	control: Type.Optional(ControlOverrides),
	// Solo agent overrides
	output: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string" },
			{ type: "boolean" },
		],
		description: "Output file for single agent, or false to disable. Relative paths resolve against cwd.",
	})),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for single agent (e.g. 'anthropic/claude-sonnet-4')" })),
	outputSchema: Type.Optional(JsonSchemaObject),
	acceptance: Type.Optional(AcceptanceOverride),
}, {
	additionalProperties: false,
	allOf: [
		{ not: { required: ["agent", "tasks"] } },
		{ not: { required: ["agent", "chain"] } },
		{ not: { required: ["tasks", "chain"] } },
	],
});
