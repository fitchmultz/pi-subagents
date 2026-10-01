import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "../shared/native-typebox.ts";
import { createSubagentExecutor, normalizeSubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { SubagentExecutionResult, SubagentState } from "../shared/types.ts";
import { activateTools, restoreLazyTools } from "../shared/lazy-tools.ts";
import { runHistoryIndex } from "../runs/shared/history-index.ts";
import type { HistoryRunOptions } from "../history/types.ts";
import { listSupervisorQuestionsAsync } from "../runs/shared/supervisor-questions.ts";
import { renderSubagentResult } from "../tui/render.ts";
import { AgentRunsParams, DelegateParams } from "./schemas.ts";
import { normalizeEverydayParams } from "./tool-input.ts";

type Executor = ReturnType<typeof createSubagentExecutor>;
type AdaptResult = (result: SubagentExecutionResult, ctx: ExtensionContext) => SubagentExecutionResult;

export function registerCompactSubagentTools(pi: ExtensionAPI, options: {
	executor: Executor;
	state: SubagentState;
	adapt: AdaptResult;
	guidelines: readonly string[];
	childSafe?: boolean;
	keepAdvancedActive?: boolean;
	listRuns?: (params: HistoryRunOptions, ctx: ExtensionContext) => Promise<SubagentExecutionResult>;
	asyncByDefault: boolean;
}): () => Promise<void> {
	const { executor, adapt, guidelines, childSafe, asyncByDefault, state } = options;
	let checking: { owner: string | null | undefined; promise: Promise<void> } | undefined;
	const checkRuns = (): Promise<void> => {
		if (pi.getActiveTools().includes("agent_runs") || !state.ownedRuns?.size) return Promise.resolve();
		const owner = state.lastUiContext?.sessionManager.getSessionId() ?? state.currentSessionId;
		if (checking?.owner === owner) return checking.promise;
		const promise = Promise.resolve().then(async () => {
			try {
				const index = await runHistoryIndex(state);
				const needed = await index.needsControls();
				if (state.historyIndex === index && needed) activateTools(pi, ["agent_runs"]);
			} catch {
				// An unavailable browse index cannot establish that genuine owned work is inert.
				if ((state.lastUiContext?.sessionManager.getSessionId() ?? state.currentSessionId) === owner && state.ownedRuns?.size) activateTools(pi, ["agent_runs"]);
			} finally { if (checking?.promise === promise) checking = undefined; }
		});
		checking = { owner, promise };
		return promise;
	};
	const reconcileRuns = () => checkRuns();
	const onRunsChanged = state.onRunsChanged;
	state.onRunsChanged = () => { reconcileRuns(); onRunsChanged?.(); };
	const asyncDescription = asyncByDefault ? "Background by default; false waits for the result." : "Foreground by default; true detaches work. Use false when the result must appear in your report.";
	pi.registerTool({
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
			const result = await executor.execute(id, normalizeSubagentParamsLike(request), signal, onUpdate, ctx);
			await checkRuns();
			return adapt(result, ctx);
		},
		renderResult: renderSubagentResult,
	});
	pi.registerTool({
		name: "agent_runs",
		defaultActive: false,
		label: "Agent Runs",
		description: `List ${childSafe ? "only this child's directly owned" : "your delegated"} runs across working directories (questions/failures, then live work, then unreviewed results; 20 per page). Filter globally by agent/state/text, sort, and page with the returned cursor. history reads 100 bounded native-entry previews; search finds saved visible text using words or quoted phrases, not operators or prefixes. Browse freshness is not completion or delivery proof. Inspect concise results, paths and continuations; full:true includes the full task/configuration. Answer durable questions, nudge, stop, continue, or save parent-only review. Review notes are not sent to children; put actionable instructions in continue/nudge. Inspect/review/nudge never restart finished work. Continue/answer can launch a saved child; async:false waits for its actual result. Saved continuations keep settings unless agent selects a current profile; model overrides win. Live guidance never mutates model or acceptance. profiles lists roles, sources, context and model/thinking/fallback defaults. History survives reload.`,
		parameters: AgentRunsParams,
		async execute(id, params, signal, onUpdate, ctx) {
			const normalized = normalizeEverydayParams(params, true);
			if (params.action === "list" && !params.id && options.listRuns) return adapt(await options.listRuns({ ...normalized, signal }, ctx), ctx);
			const actions = { list: "status", inspect: "status", history: "history", search: "search", nudge: "nudge", stop: "interrupt", continue: "resume", profiles: "list", questions: "questions", answer: "answer", review: "review" };
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
				content: [{ type: "text" as const, text: advanced ? [`Subagent ${added ? "enabled" : "already enabled"}.`, ...guidelines.map((line) => `- ${line}`)].join("\n") : "Run controls enabled. Use agent_runs({action:'profiles'}) to discover agents; list, history, or search browses owned saved work." }],
				details: {},
			};
		},
	});
	const reconcile = async (ctx: ExtensionContext) => {
		if (options.keepAdvancedActive) activateTools(pi, ["subagent"]);
		await checkRuns();
		if (!pi.getActiveTools().includes("agent_runs") && (await listSupervisorQuestionsAsync(ctx.sessionManager.getSessionId())).some((question) => question.state === "awaiting_input" || question.state === "answer_pending")) activateTools(pi, ["agent_runs"]);
	};
	const restore = async (event: { reason?: string }, ctx: ExtensionContext) => {
		if (event.reason !== "reload") restoreLazyTools(pi, ctx, "load_subagent", ["subagent", "agent_runs"]);
		await reconcile(ctx);
	};
	pi.on("session_start", restore);
	pi.on("session_tree", (_event, ctx) => reconcile(ctx));
	pi.on("session_compact", (_event, ctx) => reconcile(ctx));
	pi.on("before_agent_start", (_event, ctx) => reconcile(ctx));
	return reconcileRuns;
}
