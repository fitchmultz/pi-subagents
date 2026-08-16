import { randomUUID } from "node:crypto";
import { toModelInfo } from "../../shared/model-info.ts";
import { executeChain } from "./chain-execution.ts";
import { type ChainStep } from "../../shared/settings.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { executeAsyncChain } from "../background/async-execution.ts";
import { resolveConfiguredChildProjectTrustPolicy } from "../shared/pi-args.ts";
import { wrapChainTasksForAgentContext } from "../../shared/agent-context-policy.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { compactForegroundDetails } from "../../shared/utils.ts";
import { updateForegroundNestedProjection } from "../shared/nested-events.ts";
import { appendWorktreeSummary, extractWorktreeSummary } from "../shared/worktree.ts";
import { type SubagentExecutionResult, resolveCurrentMaxSubagentDepth } from "../../shared/types.ts";
import { type ExecutionContextData, type ExecutorDeps } from "./subagent-params.ts";
import {
	createDetachedCompletionGroup,
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	rememberForegroundRun,
} from "./foreground-control.ts";
import { collectChainSessionFiles } from "./execution-input.ts";

export async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<SubagentExecutionResult> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForAgentIndex,
		artifactsEnabled,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = (id: string, agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForAgentContext(params.chain as ChainStep[], params.context, agents);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const detachedCompletions = createDetachedCompletionGroup({
		pi: deps.pi,
		state: deps.state,
		intercomBridge: data.intercomBridge,
		runId,
		mode: "chain",
		chainSteps: chain.length,
		onResultsSettled: (results) => data.onDetachedResultsSettled?.("chain", results, chain.length),
	});
	const chainResult = await executeChain({
		chain,
		task: params.task,
		agents,
		ctx,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForAgentIndex,
		artifactsDir: artifactsEnabled ? artifactsDir : undefined,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		context: params.context,
		onUpdate,
		onControlEvent,
		controlConfig,
		...(data.foregroundTimeoutMs !== undefined ? { timeoutMs: data.foregroundTimeoutMs } : {}),
		childIntercomTarget: (agent, index) => childIntercomTarget(runId, agent, index),
		orchestratorIntercomTarget: data.intercomBridge.orchestratorTarget,
		foregroundControl,
		nestedRoute: foregroundControl?.nestedRoute,
		chainSkills,
		chainDir: params.chainDir,
		dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: currentMaxSubagentDepth,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
		projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
		onDetachedComplete: detachedCompletions.onComplete,
	});

	if (chainResult.requestedAsync) {
		const id = randomUUID();
		const asyncCtx = {
			pi: deps.pi,
			cwd: ctx.cwd,
			currentSessionId: deps.state.currentSessionId!,
			currentModelProvider: ctx.model?.provider,
			projectTrusted: ctx.isProjectTrusted(),
		};
		const asyncChain = wrapChainTasksForAgentContext(chainResult.requestedAsync.chain, params.context, agents);
		return executeAsyncChain(id, {
			chain: asyncChain,
			task: params.task,
			agents,
			ctx: asyncCtx,
			availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
			cwd: effectiveCwd,
			chainDir: params.chainDir,
			maxOutput: params.maxOutput,
			artifactsDir: artifactsEnabled ? artifactsDir : undefined,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(asyncChain, sessionFileForIndex, sessionFileForAgentIndex, deps.config.chain?.dynamicFanout?.maxItems),
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget: data.intercomBridge.orchestratorTarget,
			childIntercomTarget: (agent, index) => resolveSubagentIntercomTarget(id, agent, index),
			nestedRoute: data.nestedRoute,
			projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
		});
	}

	const chainDetails = chainResult.details ? compactForegroundDetails({ ...chainResult.details, runId }) : undefined;
	if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
	if (chainDetails) {
		rememberForegroundRun(deps.state, { runId, mode: "chain", cwd: effectiveCwd, results: chainDetails.results });
		detachedCompletions.setResults(chainDetails.results, foregroundControl?.nestedChildren);
	}
	const intercomReceipt = chainDetails && !chainDetails.results.some((result) => result.interrupted || result.detached || result.timedOut)
		? await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "chain",
			details: chainDetails,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		})
		: null;
	if (intercomReceipt) {
		const chainText = chainResult.content.map((part) => part.type === "text" ? part.text : "").join("\n");
		const worktreeSummary = extractWorktreeSummary(chainText);
		return {
			...chainResult,
			content: [{ type: "text", text: appendWorktreeSummary(intercomReceipt.text, worktreeSummary) }],
			details: intercomReceipt.details,
			...(intercomReceipt.status !== "completed" ? { isError: true } : {}),
		};
	}

	return chainDetails ? { ...chainResult, details: chainDetails } : chainResult;
}
