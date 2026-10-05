import type { AgentScope, AgentConfig } from "../shared/types/config.ts";

export function mergeAgentsForScope(
  scope: AgentScope,
  userAgents: readonly AgentConfig[],
  projectAgents: readonly AgentConfig[],
  builtinAgents: readonly AgentConfig[] = [],
): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();

  for (const agent of builtinAgents) {
    agentMap.set(agent.name, agent);
  }

  if (scope === "both") {
    for (const agent of userAgents) {
      agentMap.set(agent.name, agent);
    }
    for (const agent of projectAgents) {
      agentMap.set(agent.name, agent);
    }
  } else if (scope === "user") {
    for (const agent of userAgents) {
      agentMap.set(agent.name, agent);
    }
  } else {
    for (const agent of projectAgents) {
      agentMap.set(agent.name, agent);
    }
  }

  return Array.from(agentMap.values());
}
