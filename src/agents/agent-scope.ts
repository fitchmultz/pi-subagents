import type { AgentScope } from "./agents.ts";

export function resolveExecutionAgentScope(scope: unknown): AgentScope {
	if (scope === undefined) return "both";
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	throw new Error("agentScope must be 'user', 'project', or 'both'.");
}
