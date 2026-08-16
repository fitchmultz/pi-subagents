import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentDiscoveryOptions, type AgentScope } from "../../agents/agents.ts";
import { materializeAgentDefaultOutputPath, normalizeSingleOutputOverride } from "../shared/single-output.ts";
import type { IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import {
	type ChainStep,
	type DynamicParallelStep,
	type ParallelStep,
	type SequentialStep,
} from "../../shared/settings.ts";
import {
	type AcceptanceInput,
	type ControlConfig,
	type ExtensionConfig,
	type JsonSchemaObject,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SingleResult,
	type SubagentExecutionResult,
	type SubagentRunMode,
	type SubagentState,
} from "../../shared/types.ts";

export function maxParallelTasksMessage(maxParallelTasks: number): string {
	return `Max ${maxParallelTasks} tasks. Split the batch into smaller parallel calls or raise parallel.maxTasks in ~/.pi/agent/extensions/subagent/config.json.`;
}

export interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	outputSchema?: JsonSchemaObject;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	acceptance?: AcceptanceInput;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskParamLike(value: unknown): value is TaskParam {
	return isRecord(value) && typeof value.agent === "string";
}

function isDynamicParallelStepLike(value: unknown): value is DynamicParallelStep {
	return isRecord(value)
		&& isRecord(value.expand)
		&& isRecord(value.parallel)
		&& typeof value.parallel.agent === "string"
		&& isRecord(value.collect)
		&& typeof value.collect.as === "string";
}

function isParallelStepLike(value: unknown): value is ParallelStep {
	return isRecord(value) && Array.isArray(value.parallel) && value.parallel.every(isTaskParamLike);
}

function isSequentialStepLike(value: unknown): value is SequentialStep {
	return isRecord(value) && typeof value.agent === "string";
}

function isChainStepLike(value: unknown): value is ChainStep {
	if (!isRecord(value)) return false;
	return isDynamicParallelStepLike(value) || isParallelStepLike(value) || isSequentialStepLike(value);
}

export interface SubagentParamsLike {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	agent?: string;
	task?: string;
	message?: string;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	timeoutMs?: number;
	maxRuntimeMs?: number;
	extendMs?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	outputSchema?: JsonSchemaObject;
	agentScope?: string;
	chainName?: string;
	config?: unknown;
	chainDir?: string;
	acceptance?: AcceptanceInput;
}

export function resolveAsyncExecutionMode(
	params: Pick<SubagentParamsLike, "async" | "clarify" | "timeoutMs" | "maxRuntimeMs">,
	asyncByDefault: boolean,
): { effectiveAsync: boolean; backgroundRequestedWhileClarifying: boolean } {
	const hasForegroundTimeout = params.timeoutMs !== undefined || params.maxRuntimeMs !== undefined;
	const requestedAsync = params.async ?? (hasForegroundTimeout ? false : asyncByDefault);
	return {
		effectiveAsync: requestedAsync && params.clarify !== true,
		backgroundRequestedWhileClarifying: params.async === true && params.clarify === true,
	};
}

type RawSubagentParamsLike = Record<string, unknown>;

function stringValue(params: RawSubagentParamsLike, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

function booleanValue(params: RawSubagentParamsLike, key: string): boolean | undefined {
	const value = params[key];
	return typeof value === "boolean" ? value : undefined;
}

function numberValue(params: RawSubagentParamsLike, key: string): number | undefined {
	const value = params[key];
	return typeof value === "number" ? value : undefined;
}

function contextValue(params: RawSubagentParamsLike): SubagentParamsLike["context"] {
	const value = params.context;
	return value === "fresh" || value === "fork" ? value : undefined;
}

function outputModeValue(params: RawSubagentParamsLike): SubagentParamsLike["outputMode"] {
	const value = params.outputMode;
	return value === "inline" || value === "file-only" ? value : undefined;
}

function outputValue(params: RawSubagentParamsLike): SubagentParamsLike["output"] {
	const value = params.output;
	return typeof value === "string" || typeof value === "boolean" ? value : undefined;
}

export function usesAgentDefaultOutput(output: string | boolean | undefined): boolean {
	return output === undefined || output === true || output === "true";
}

export function resolveTopLevelOutputOverride(params: {
	requestedOutput: string | boolean | undefined;
	agentDefaultOutput: string | false | undefined;
	artifactsDir: string;
	runId: string;
	agent: string;
	index?: number;
}): string | false | undefined {
	const effectiveOutput = usesAgentDefaultOutput(params.requestedOutput)
		? normalizeSingleOutputOverride(true, params.agentDefaultOutput)
		: normalizeSingleOutputOverride(params.requestedOutput, params.agentDefaultOutput);
	if (!usesAgentDefaultOutput(params.requestedOutput)) return effectiveOutput;
	return materializeAgentDefaultOutputPath({
		output: effectiveOutput,
		artifactsDir: params.artifactsDir,
		runId: params.runId,
		agent: params.agent,
		index: params.index,
	});
}

function skillValue(params: RawSubagentParamsLike): SubagentParamsLike["skill"] {
	const value = params.skill;
	if (typeof value === "string" || typeof value === "boolean") return value;
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function maxOutputValue(params: RawSubagentParamsLike): MaxOutputConfig | undefined {
	const value = params.maxOutput;
	if (!isRecord(value)) return undefined;
	return {
		...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
		...(typeof value.lines === "number" ? { lines: value.lines } : {}),
	};
}

function isControlConfig(value: unknown): value is ControlConfig {
	return isRecord(value);
}

function isAcceptanceInput(value: unknown): value is AcceptanceInput {
	return isRecord(value);
}

export function normalizeSubagentParamsLike(params: RawSubagentParamsLike): SubagentParamsLike {
	const normalized: SubagentParamsLike = {
		action: stringValue(params, "action"),
		id: stringValue(params, "id"),
		runId: stringValue(params, "runId"),
		dir: stringValue(params, "dir"),
		index: numberValue(params, "index"),
		agent: stringValue(params, "agent"),
		task: stringValue(params, "task"),
		message: stringValue(params, "message"),
		concurrency: numberValue(params, "concurrency"),
		timeoutMs: numberValue(params, "timeoutMs"),
		maxRuntimeMs: numberValue(params, "maxRuntimeMs"),
		extendMs: numberValue(params, "extendMs"),
		worktree: booleanValue(params, "worktree"),
		context: contextValue(params),
		async: booleanValue(params, "async"),
		clarify: booleanValue(params, "clarify"),
		share: booleanValue(params, "share"),
		control: isControlConfig(params.control) ? params.control : undefined,
		sessionDir: stringValue(params, "sessionDir"),
		cwd: stringValue(params, "cwd"),
		maxOutput: maxOutputValue(params),
		artifacts: booleanValue(params, "artifacts"),
		includeProgress: booleanValue(params, "includeProgress"),
		progress: booleanValue(params, "progress"),
		model: stringValue(params, "model"),
		skill: skillValue(params),
		output: outputValue(params),
		outputMode: outputModeValue(params),
		outputSchema: isRecord(params.outputSchema) ? params.outputSchema : undefined,
		agentScope: stringValue(params, "agentScope"),
		chainName: stringValue(params, "chainName"),
		config: params.config,
		chainDir: stringValue(params, "chainDir"),
		acceptance: isAcceptanceInput(params.acceptance) ? params.acceptance : undefined,
	};
	if (params.tasks !== undefined) {
		if (!Array.isArray(params.tasks) || !params.tasks.every(isTaskParamLike)) {
			throw new Error("tasks must be an array of task objects with an agent.");
		}
		normalized.tasks = params.tasks;
	}
	if (params.chain !== undefined) {
		if (!Array.isArray(params.chain) || !params.chain.every(isChainStepLike)) {
			throw new Error("chain must contain valid sequential, parallel, or dynamic fanout steps.");
		}
		normalized.chain = params.chain;
	}
	return normalized;
}

export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope, options?: AgentDiscoveryOptions) => { agents: AgentConfig[] };
	allowMutatingManagementActions?: boolean;
}

export interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal | undefined;
	onUpdate?: (r: SubagentExecutionResult) => void;
	agents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForAgentIndex: (agentName: string | undefined, idx?: number) => string | undefined;
	artifactsEnabled: boolean;
	artifactsDir: string;
	backgroundRequestedWhileClarifying: boolean;
	effectiveAsync: boolean;
	foregroundTimeoutMs?: number;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
	onDetachedResultsSettled?: (mode: SubagentRunMode, results: SingleResult[], totalSteps?: number) => void;
}
