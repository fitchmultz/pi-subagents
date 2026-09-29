import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSubagentExecutor, normalizeSubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { SubagentExecutionResult, SubagentState } from "../shared/types.ts";
import { activateTools, restoreLazyTools } from "../shared/lazy-tools.ts";
import { ownedRunView } from "../runs/shared/run-records.ts";
import { listSupervisorQuestions } from "../runs/shared/supervisor-questions.ts";
import type { AsyncContext } from "../runs/shared/native-async.ts";
import { renderSubagentResult } from "../tui/render.ts";
import { AgentRunsParams, DelegateParams } from "./schemas.ts";
import { normalizeEverydayParams } from "./tool-input.ts";

type Executor = ReturnType<typeof createSubagentExecutor>;
type AdaptResult = (result: SubagentExecutionResult, ctx: ExtensionContext) => SubagentExecutionResult;

export function subagentToolLifecycle(executor: Executor, adapt: AdaptResult) {
	return {
		async: true,
		resume: async (id: string, _params: unknown, signal: AbortSignal | undefined,
			onUpdate: ((result: SubagentExecutionResult) => void) | undefined, ctx: ExtensionContext) => {
			const result = await executor.resume(id, {}, signal, onUpdate, ctx);
			return result && adapt(result, ctx);
		},
	};
}

export function registerCompactSubagentTools(pi: ExtensionAPI, options: {
	executor: Executor;
	state: SubagentState;
	adapt: AdaptResult;
	guidelines: readonly string[];
	childSafe?: boolean;
	keepAdvancedActive?: boolean;
	listRuns?: (params: { offset?: number; limit?: number }, ctx: ExtensionContext) => SubagentExecutionResult;
	asyncByDefault: boolean;
}): () => void {
	const { executor, adapt, guidelines, childSafe, asyncByDefault, state } = options;
	const reconcileRuns = () => {
		if (pi.getActiveTools().includes("agent_runs")) return;
		if ([...(state.ownedRuns?.values() ?? [])].some((run) => {
			const view = ownedRunView(run, state, { readConfiguration: false, includeContinuations: false });
			return view.state === "live" || view.attention.length > 0;
		})) activateTools(pi, ["agent_runs"]);
	};
	const onRunsChanged = state.onRunsChanged;
	state.onRunsChanged = () => { reconcileRuns(); onRunsChanged?.(); };
	const lifecycle = subagentToolLifecycle(executor, adapt);
	const asyncDescription = asyncByDefault ? "Background by default; false waits for the result." : "Foreground by default; true detaches work. Use false when the result must appear in your report.";
	pi.registerTool({
		...lifecycle,
		name: "delegate",
		label: "Delegate",
		description: `Delegate one bounded task to a configured agent. For profiles/history, load_subagent({advanced:false}) enables agent_runs. Delegation enables run controls automatically. ${asyncDescription} Use worktree for an isolated writer, acceptance for explicit requirements, and fresh context for independent review. Fresh handoffs must include relevant exact user instructions and settled decisions or readable source references, not just summaries, alongside the bounded task. Advanced workflows remain behind load_subagent.`,
		...(childSafe ? { promptGuidelines: [...guidelines] } : {}),
		parameters: Type.Object({ ...DelegateParams.properties, async: Type.Optional(Type.Boolean({ description: asyncDescription })) }, { additionalProperties: false }),
		async execute(id, params, signal, onUpdate, ctx) {
			const { worktree, context, async: background, ...task } = normalizeEverydayParams(params);
			const request = worktree
				? { tasks: [task], worktree: true, context, async: background, cwd: task.cwd }
				: { ...task, context, async: background };
			return adapt(await executor.execute(id, normalizeSubagentParamsLike(request), signal, onUpdate, ctx), ctx);
		},
		renderResult: renderSubagentResult,
	});
	pi.registerTool({
		...lifecycle,
		name: "agent_runs",
		label: "Agent Runs",
		description: `List ${childSafe ? "only this child's directly owned" : "your delegated"} runs across working directories (questions/failures, then live work, then unreviewed results; 20 per page). Inspect concise results, paths and continuations; full:true includes the full task/configuration. Answer durable questions, nudge, stop, continue, or save parent-only review. Review notes are not sent to children; put actionable instructions in continue/nudge. Inspect/review/nudge never restart finished work. Continue/answer can launch a saved child; async:false waits for its actual result. Saved continuations keep settings unless agent selects a current profile; model overrides win. Live guidance never mutates model or acceptance. profiles lists roles, sources, context and model/thinking/fallback defaults. History survives reload.`,
		parameters: AgentRunsParams,
		async execute(id, params, signal, onUpdate, ctx) {
			const normalized = normalizeEverydayParams(params, true);
			if (params.action === "list" && !params.id && options.listRuns) return adapt(options.listRuns(normalized, ctx), ctx);
			const actions = { list: "status", inspect: "status", nudge: "nudge", stop: "interrupt", continue: "resume", profiles: "list", questions: "questions", answer: "answer", review: "review" };
			return adapt(await executor.execute(id, normalizeSubagentParamsLike({ ...normalized, action: actions[params.action] }), signal, onUpdate, ctx), ctx);
		},
		renderResult: renderSubagentResult,
	});
	pi.registerTool({
		name: "load_subagent",
		label: "Load Subagent",
		description: `Enable agent_runs for profiles, history and run controls; advanced:false loads only those controls. By default also enable advanced subagent orchestration: parallel groups, chains, saved workflows, detailed overrides, get, extend and doctor.${childSafe ? " Agent-definition mutations remain blocked." : " Includes agent-definition management."} Ordinary delegation and control use delegate and agent_runs. After loading advanced workflows, call subagent with { action: "list" } before execution.`,
		promptSnippet: "Discover profiles/history with advanced:false, or load full subagent orchestration by default.",
		parameters: Type.Object({ advanced: Type.Optional(Type.Boolean({ description: "Also enable advanced orchestration (default true); false loads only agent_runs for profiles, history and controls." })) }),
		async execute(_id, params) {
			const advanced = params.advanced !== false;
			if (advanced && !pi.getAllTools().some((tool) => tool.name === "subagent" && !("namespace" in tool && tool.namespace))) {
				throw new Error("Subagent is unavailable because the full tool is excluded from this session.");
			}
			if (!advanced && !pi.getAllTools().some((tool) => tool.name === "agent_runs" && !("namespace" in tool && tool.namespace))) throw new Error("Run controls are excluded from this session.");
			const added = !pi.getActiveTools().includes(advanced ? "subagent" : "agent_runs");
			activateTools(pi, advanced ? ["agent_runs", "subagent"] : ["agent_runs"]);
			return {
				content: [{ type: "text" as const, text: advanced ? [`Subagent ${added ? "enabled" : "already enabled"}.`, ...guidelines.map((line) => `- ${line}`)].join("\n") : "Run controls enabled. Use agent_runs({action:'profiles'}) to discover agents or agent_runs({action:'list'}) for owned history." }],
				details: {},
			};
		},
	});
	const reconcile = (ctx: ExtensionContext) => {
		const pending = (ctx as AsyncContext).getPendingToolCalls?.() ?? [];
		activateTools(pi, pending.filter((call) => ["subagent", "delegate", "agent_runs"].includes(call.toolName)).map((call) => call.toolName));
		if (options.keepAdvancedActive) activateTools(pi, ["subagent"]);
		if (pending.some((call) => ["subagent", "delegate", "agent_runs"].includes(call.toolName))) activateTools(pi, ["agent_runs"]);
		reconcileRuns();
		if (!pi.getActiveTools().includes("agent_runs") && listSupervisorQuestions(ctx.sessionManager.getSessionId()).some((question) => question.state === "awaiting_input" || question.state === "answer_pending")) activateTools(pi, ["agent_runs"]);
	};
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		restoreLazyTools(pi, ctx, "load_subagent", ["subagent", "agent_runs"]);
		reconcile(ctx);
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("session_compact", (_event, ctx) => reconcile(ctx));
	return reconcileRuns;
}
