import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSubagentExecutor, normalizeSubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { SubagentExecutionResult } from "../shared/types.ts";
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
	adapt: AdaptResult;
	guidelines: readonly string[];
	childSafe?: boolean;
	keepAdvancedActive?: boolean;
	listRuns?: (params: { offset?: number; limit?: number }, ctx: ExtensionContext) => SubagentExecutionResult;
	asyncByDefault: boolean;
}): void {
	const { executor, adapt, guidelines, childSafe, asyncByDefault } = options;
	const lifecycle = subagentToolLifecycle(executor, adapt);
	const asyncDescription = asyncByDefault ? "Background by default; false waits for the result." : "Foreground by default; true detaches work. Use false when the result must appear in your report.";
	pi.registerTool({
		...lifecycle,
		name: "delegate",
		label: "Delegate",
		description: `Delegate one bounded task to a configured agent. Discover profiles with agent_runs({action:'profiles'}). ${asyncDescription} Use worktree for an isolated writer, acceptance for explicit requirements, and fresh context for independent review. Advanced workflows remain behind load_subagent.`,
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
		description: `List ${childSafe ? "only this child's directly owned" : "your delegated"} runs across working directories (questions/failures, then live work, then unreviewed results; 20 per page). Inspect concise results, paths and continuations; full:true includes the full task/configuration. Answer durable questions, nudge, stop, continue, or save parent-only review. Review notes are not sent to children; put actionable instructions in continue/nudge. Inspect/review/nudge never restart finished work. Continue/answer can launch a saved child; async:false waits for its actual result. Overrides apply only to a new continuation, never to live acceptance. profiles lists agents. History survives reload.`,
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
		description: `Enable advanced subagent orchestration: parallel groups, chains, saved workflows, detailed overrides, get, extend and doctor.${childSafe ? " Agent-definition mutations remain blocked." : " Includes agent-definition management."} Ordinary delegation and control use delegate and agent_runs. After loading, call subagent with { action: "list" } before execution.`,
		promptSnippet: "Load advanced subagent orchestration; use delegate and agent_runs for ordinary work.",
		parameters: Type.Object({}),
		async execute() {
			if (!pi.getAllTools().some((tool) => tool.name === "subagent")) {
				throw new Error("Subagent is unavailable because the full tool is excluded from this session.");
			}
			const active = pi.getActiveTools();
			const added = !active.includes("subagent");
			if (added) pi.setActiveTools([...active, "subagent"]);
			return {
				content: [{ type: "text" as const, text: [`Subagent ${added ? "enabled" : "already enabled"}.`, ...guidelines.map((line) => `- ${line}`)].join("\n") }],
				details: {},
			};
		},
	});
	const resetActivation = (_event?: unknown, ctx?: ExtensionContext) => {
		const available = pi.getAllTools();
		// An explicit subagent-only policy must remain usable without an excluded loader.
		if (!available.some((tool) => tool.name === "load_subagent")) return;
		// Native recovery resolves original calls against active tools, including after restart.
		const keepAdvanced = options.keepAdvancedActive || (ctx as AsyncContext | undefined)?.getPendingToolCalls?.().some((call) => call.toolName === "subagent");
		const active = pi.getActiveTools();
		const reset = keepAdvanced ? [...active] : active.filter((name) => name !== "subagent");
		if (keepAdvanced && !reset.includes("subagent") && available.some((tool) => tool.name === "subagent")) reset.push("subagent");
		if (!reset.includes("load_subagent")) reset.push("load_subagent");
		if (reset.length !== active.length || reset.some((name, index) => name !== active[index])) pi.setActiveTools(reset);
	};
	pi.on("session_start", resetActivation);
	pi.on("session_tree", resetActivation);
	pi.on("session_compact", resetActivation);
}
