import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { validateForkContextModelPolicy } from "../../shared/agent-context-policy.ts";
import { toModelInfo } from "../../shared/model-info.ts";
import { createChainDir, isDynamicParallelStep, isParallelStep, removeChainDir, resolveChainTemplates, resolveStepBehavior, type SequentialStep } from "../../shared/settings.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { normalizeSingleOutputOverride } from "../shared/single-output.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import type { SubagentParamsLike } from "./subagent-params.ts";

/** Preview changes launch input only; waiting and background runs share the same owner. */
export async function clarifyInvocation(input: {
	params: SubagentParamsLike;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	cwd: string;
	runId: string;
}): Promise<SubagentParamsLike | undefined> {
	const { params, agents, ctx, cwd, runId } = input;
	if (params.clarify !== true || !ctx.hasUI) return params;
	if (params.chain?.some((step) => isParallelStep(step) || isDynamicParallelStep(step))) return params;
	const mode = params.chain ? "chain" : params.tasks ? "parallel" : "single";
	const steps = params.chain as SequentialStep[] | undefined ?? params.tasks ?? [{ ...params, agent: params.agent!, reads: undefined }];
	const profiles = steps.map((step) => {
		const profile = agents.find((agent) => agent.name === step.agent);
		if (!profile) throw new Error(`Unknown agent: ${step.agent}`);
		return profile;
	});
	const templates = params.chain ? resolveChainTemplates(params.chain) as string[] : steps.map((step) => step.task ?? "");
	const originalTask = params.task ?? (mode === "chain" ? templates[0] ?? "" : "");
	const chainSkills = mode === "chain" ? normalizeSkillInput(params.skill) ?? [] : [];
	const behaviors = profiles.map((profile, index) => {
		const step = steps[index]!;
		return resolveStepBehavior(profile, {
			output: normalizeSingleOutputOverride(step.output, profile.output),
			outputMode: step.outputMode,
			reads: step.reads === true ? undefined : step.reads,
			progress: step.progress,
			skills: normalizeSkillInput(step.skill),
			model: step.model,
		}, chainSkills);
	});
	const models = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const skills = discoverAvailableSkills(cwd, { projectTrusted: ctx.isProjectTrusted() });
	const chainDir = mode === "chain" ? createChainDir(runId, params.chainDir, cwd) : undefined;
	let confirmed = false;
	try {
		const result = await ctx.ui.custom<ChainClarifyResult>((tui, theme, _kb, done) => new ChainClarifyComponent(
			tui, theme, profiles, templates, originalTask, chainDir, behaviors, models, ctx.model?.provider, skills, done, mode,
		), { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } });
		if (!result?.confirmed) return undefined;
		const updated = steps.map((step, index) => {
			const override = result.behaviorOverrides[index];
			return {
				...step, task: result.templates[index]!,
				...(override?.model ? { model: override.model } : {}),
				...(override?.output !== undefined ? { output: override.output } : {}),
				...(override?.reads !== undefined ? { reads: override.reads } : {}),
				...(override?.progress !== undefined ? { progress: override.progress } : {}),
				...(override?.skills !== undefined ? { skill: override.skills } : {}),
			};
		});
		const next: SubagentParamsLike = {
			...params,
			...(mode === "chain" ? { chain: updated as SequentialStep[] }
				: mode === "parallel" ? { tasks: updated } : updated[0]),
			clarify: false, async: result.runInBackground === true,
		};
		const error = validateForkContextModelPolicy(next, agents, (model) => resolveModelCandidate(model, models, ctx.model?.provider));
		if (error) throw new Error(error);
		confirmed = true;
		return next;
	} finally {
		if (!confirmed && chainDir) removeChainDir(chainDir);
	}
}
