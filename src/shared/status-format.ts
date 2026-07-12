import type { ActivityState, AsyncJobStep, ManagementAction, ManagementControl, ManagementRunState, SubagentLiveIntercomHealth } from "./types.ts";

export function buildManagementControl(input: {
	state: ManagementRunState;
	runId: string;
	index?: number;
	intercomTarget?: string;
	canExtend?: boolean;
	canResume?: boolean;
	canNudge?: boolean;
	canInterrupt?: boolean;
	unavailableActions?: Partial<Record<ManagementAction, string>>;
	revivedFromRunId?: string;
}): ManagementControl {
	const capabilities: ManagementAction[] = ["status"];
	if (input.state === "live") {
		if (input.canNudge) capabilities.push("nudge");
		if (input.canResume) capabilities.push("resume");
		if (input.canInterrupt) capabilities.push("interrupt");
	} else if (input.canResume) capabilities.push("resume");
	if (input.state === "live" && input.canExtend) capabilities.push("extend");
	return {
		state: input.state,
		runId: input.runId,
		capabilities,
		nextActions: capabilities.map((action) => ({
			action,
			runId: input.runId,
			...(input.index !== undefined && (action === "nudge" || action === "resume") ? { index: input.index } : {}),
			...(input.intercomTarget && (action === "nudge" || action === "resume") ? { intercomTarget: input.intercomTarget } : {}),
		})),
		...(input.unavailableActions ? { unavailableActions: input.unavailableActions } : {}),
		...(input.revivedFromRunId ? { revivedFromRunId: input.revivedFromRunId, pendingReplyContextValid: false } : {}),
	};
}

type StepStatusLike = Pick<AsyncJobStep, "status">;

function formatActivityAge(ms: number): string {
	if (ms < 1000) return "now";
	if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
	return `${Math.floor(ms / 60000)}m`;
}

export function formatActivityLabel(lastActivityAt: number | undefined, activityState?: ActivityState, now = Date.now()): string | undefined {
	if (lastActivityAt === undefined) {
		if (activityState === "needs_attention") return "needs attention";
		return undefined;
	}
	const age = formatActivityAge(Math.max(0, now - lastActivityAt));
	if (activityState === "needs_attention") return `no activity for ${age}`;
	return age === "now" ? "active now" : `active ${age} ago`;
}

function isCompletedStepStatus(status: AsyncJobStep["status"]): boolean {
	return status === "complete" || status === "completed";
}

export function aggregateStepStatus(steps: StepStatusLike[]): AsyncJobStep["status"] {
	if (steps.some((step) => step.status === "running")) return "running";
	if (steps.some((step) => step.status === "failed")) return "failed";
	if (steps.some((step) => step.status === "paused")) return "paused";
	if (steps.length > 0 && steps.every((step) => isCompletedStepStatus(step.status))) return "complete";
	return "pending";
}

export function formatAgentRunningLabel(count: number): string {
	return count === 1 ? "1 agent running" : `${count} agents running`;
}

export function formatLiveIntercomActionLines(input: {
	runId: string;
	target: string;
	index?: number;
	health?: SubagentLiveIntercomHealth;
	indent?: string;
}): string[] {
	const indexPart = input.index !== undefined ? `, index: ${input.index}` : "";
	const healthText = !input.health
		? "unknown"
		: input.health.status === "registered"
			? `registered${input.health.sessionStatus ? `, ${input.health.sessionStatus}` : ""}${input.health.acceptsAsks !== undefined ? `, accepts_asks:${input.health.acceptsAsks}` : ""}${input.health.pendingAsks !== undefined ? `, pending_asks:${input.health.pendingAsks}` : ""}`
			: input.health.status.replace(/_/g, " ");
	const indent = input.indent ?? "";
	return [
		`${indent}Intercom: ${healthText} (${input.target})`,
		`${indent}Nudge: subagent({ action: "nudge", id: "${input.runId}"${indexPart}, message: "What are you blocked on?" })`,
		`${indent}Ask: intercom({ action: "ask", to: "${input.target}", delivery: "steer", message: "What are you blocked on?" })`,
	];
}

export function formatParallelOutcome(steps: StepStatusLike[], total: number, options: { showRunning?: boolean } = {}): string {
	const running = steps.filter((step) => step.status === "running").length;
	const succeeded = steps.filter((step) => isCompletedStepStatus(step.status)).length;
	const failed = steps.filter((step) => step.status === "failed").length;
	const paused = steps.filter((step) => step.status === "paused").length;
	const parts = [`${succeeded}/${total} succeeded`];
	if (options.showRunning !== false && running > 0) parts.unshift(formatAgentRunningLabel(running));
	if (failed > 0) parts.push(`${failed} failed`);
	if (paused > 0) parts.push(`${paused} paused`);
	return parts.join(" · ");
}
