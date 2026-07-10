import type { AgentConfig } from "../agents/agents.ts";
import type { ChainStep, SequentialStep } from "./settings.ts";
import { getStepAgents, isDynamicParallelStep, isParallelStep } from "./settings.ts";
import { createForkContextResolver, resolveSubagentContext, type ForkContextResolverOptions } from "./fork-context.ts";
import { wrapForkTask } from "./types.ts";

export type SubagentExecutionContext = "fresh" | "fork";

interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getSessionDir?(): string;
	openSession?: (path: string, sessionDir?: string) => { createBranchedSession(leafId: string): string | undefined };
}

export interface SubagentParamsLikeForContext {
	agent?: string;
	model?: string;
	tasks?: Array<{ agent: string; model?: string }>;
	chain?: ChainStep[];
	context?: SubagentExecutionContext;
}

interface InvocationAgentTarget {
	agent: string;
	model?: string;
}

export function resolveAgentContext(
	explicitContext: unknown,
	agentName: string | undefined,
	agents: readonly AgentConfig[],
): SubagentExecutionContext {
	if (explicitContext !== undefined) {
		return resolveSubagentContext(explicitContext);
	}
	if (!agentName) return "fresh";
	const agent = agents.find((entry) => entry.name === agentName);
	return agent?.defaultContext === "fork" ? "fork" : "fresh";
}

function collectInvocationAgentTargets(params: SubagentParamsLikeForContext): InvocationAgentTarget[] {
	if (params.tasks?.length) {
		return params.tasks.map((task) => ({ agent: task.agent, model: task.model }));
	}
	if (params.chain?.length) {
		const targets: InvocationAgentTarget[] = [];
		for (const step of params.chain) {
			if (isParallelStep(step)) {
				for (const task of step.parallel) targets.push({ agent: task.agent, model: task.model });
			} else if (isDynamicParallelStep(step)) {
				targets.push({ agent: step.parallel.agent, model: step.parallel.model });
			} else {
				targets.push({ agent: step.agent, model: step.model });
			}
		}
		return targets;
	}
	return params.agent ? [{ agent: params.agent, model: params.model }] : [];
}

export function collectInvocationAgentNames(params: SubagentParamsLikeForContext): string[] {
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	for (const step of params.chain ?? []) names.push(...getStepAgents(step));
	return names;
}

export function validateForkContextModelPolicy(
	params: SubagentParamsLikeForContext,
	agents: readonly AgentConfig[],
	resolveModel?: (model: string) => string | undefined,
): string | undefined {
	for (const target of collectInvocationAgentTargets(params)) {
		const agent = agents.find((entry) => entry.name === target.agent);
		if (!agent || resolveAgentContext(params.context, target.agent, agents) !== "fork") continue;
		const anthropicModel = [target.model ?? agent.model, ...(agent.fallbackModels ?? [])]
			.filter((model): model is string => Boolean(model?.trim()))
			.map((model) => resolveModel?.(model) ?? model)
			.find((model) => model.trim().toLowerCase().startsWith("anthropic/"));
		if (anthropicModel) {
			return `Fork context cannot be used with anthropic/* models. Agent '${target.agent}' has effective model candidate '${anthropicModel}'. Use context: "fresh" or a non-Anthropic model; this restriction cannot be overridden.`;
		}
	}
	return undefined;
}

export function invocationUsesForkContext(
	explicitContext: unknown,
	agentNames: readonly string[],
	agents: readonly AgentConfig[],
): boolean {
	if (explicitContext !== undefined) {
		return resolveSubagentContext(explicitContext) === "fork";
	}
	return agentNames.some((name) => resolveAgentContext(undefined, name, agents) === "fork");
}

export function buildFlatAgentNameResolver(params: SubagentParamsLikeForContext): (index: number) => string | undefined {
	if (params.agent && !params.tasks?.length && !params.chain?.length) {
		return () => params.agent;
	}
	if (params.tasks?.length) {
		return (index) => params.tasks![index]?.agent;
	}
	if (params.chain?.length) {
		const flatAgents: string[] = [];
		for (const step of params.chain) {
			if (isParallelStep(step)) {
				for (const task of step.parallel) flatAgents.push(task.agent);
				continue;
			}
			flatAgents.push(...getStepAgents(step));
		}
		return (index) => flatAgents[index];
	}
	return () => undefined;
}

export function wrapTaskForAgentContext(
	task: string,
	explicitContext: unknown,
	agentName: string | undefined,
	agents: readonly AgentConfig[],
): string {
	return resolveAgentContext(explicitContext, agentName, agents) === "fork" ? wrapForkTask(task) : task;
}

export function wrapChainTasksForAgentContext(
	chain: ChainStep[],
	explicitContext: unknown,
	agents: readonly AgentConfig[],
): ChainStep[] {
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					task: wrapTaskForAgentContext(task.task ?? "{previous}", explicitContext, task.agent, agents),
				})),
			};
		}
		if (isDynamicParallelStep(step)) {
			return {
				...step,
				parallel: {
					...step.parallel,
					task: wrapTaskForAgentContext(
						step.parallel.task ?? "{previous}",
						explicitContext,
						step.parallel.agent,
						agents,
					),
				},
			};
		}
		const sequential = step as SequentialStep;
		const agentName = getStepAgents(step)[0];
		return {
			...sequential,
			task: wrapTaskForAgentContext(
				sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}"),
				explicitContext,
				agentName,
				agents,
			),
		};
	});
}

export function createPerAgentForkContextResolver(
	sessionManager: ForkableSessionManager,
	resolveContextForIndex: (index?: number) => SubagentExecutionContext,
	options: ForkContextResolverOptions & { resolveContextForAgentIndex?: (agentName: string | undefined, index?: number) => SubagentExecutionContext } = {},
): { sessionFileForIndex(index?: number): string | undefined; sessionFileForAgentIndex(agentName: string | undefined, index?: number): string | undefined } {
	let forkResolver: ReturnType<typeof createForkContextResolver> | undefined;
	const sessionFileForContext = (context: SubagentExecutionContext, index = 0): string | undefined => {
		if (context !== "fork") return undefined;
		if (!forkResolver) forkResolver = createForkContextResolver(sessionManager, "fork", options);
		return forkResolver.sessionFileForIndex(index);
	};
	return {
		sessionFileForIndex(index = 0): string | undefined {
			return sessionFileForContext(resolveContextForIndex(index), index);
		},
		sessionFileForAgentIndex(agentName, index = 0): string | undefined {
			const context = options.resolveContextForAgentIndex?.(agentName, index) ?? resolveContextForIndex(index);
			return sessionFileForContext(context, index);
		},
	};
}
