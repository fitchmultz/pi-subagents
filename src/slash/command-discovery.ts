import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, discoverAgentsAll } from "../agents/agents.ts";
import type { ChainConfig } from "../shared/types/config.ts";
import { resolveExecutionCwd } from "../shared/execution-cwd.ts";

export interface SlashDiscoveryState {
  readonly lastUiContext: ExtensionContext | null;
  readonly baseCwd: string;
}
interface Completion {
  readonly value: string;
  readonly label: string;
}

function projectTrusted(state: SlashDiscoveryState): boolean {
  return state.lastUiContext ? state.lastUiContext.isProjectTrusted() : true;
}

function completionCwd(pi: ExtensionAPI, state: SlashDiscoveryState): string | null {
  try {
    return state.lastUiContext ? resolveExecutionCwd(pi, state.lastUiContext) : state.baseCwd;
  } catch {
    return null;
  }
}

export function assertKnownAgents(cwd: string, names: readonly string[], trusted: boolean): void {
  const agents = discoverAgents(cwd, "both", { projectTrusted: trusted }).agents;
  for (const name of names) {
    if (!agents.some((agent) => agent.name === name)) {
      throw new Error(`Unknown agent: ${name}`);
    }
  }
}

function completionPosition(
  prefix: string,
): { readonly word: string; readonly before: string } | undefined {
  const lastArrow = prefix.lastIndexOf(" -> ");
  const segment = lastArrow !== -1 ? prefix.slice(lastArrow + 4) : prefix;
  if (segment.includes(" -- ") || segment.includes('"') || segment.includes("'")) {
    return undefined;
  }
  const word = prefix.match(/(\S*)$/)?.at(1) ?? "";
  return { word, before: prefix.slice(0, prefix.length - word.length) };
}

export function makeAgentCompletions(
  pi: ExtensionAPI,
  state: SlashDiscoveryState,
  multiAgent: boolean,
): (prefix: string) => Completion[] | null {
  return (prefix) => {
    const cwd = completionCwd(pi, state);
    if (cwd === null || cwd.length === 0) {
      return null;
    }
    const agents = discoverAgents(cwd, "both", { projectTrusted: projectTrusted(state) }).agents;
    if (!multiAgent) {
      return prefix.includes(" ")
        ? null
        : agents
            .filter((agent) => agent.name.startsWith(prefix))
            .map((agent) => ({ value: agent.name, label: agent.name }));
    }
    const position = completionPosition(prefix);
    if (!position) {
      return null;
    }
    const { word: lastWord, before: beforeLastWord } = position;
    if (lastWord === "->") {
      return agents.map((agent) => ({ value: `${prefix} ${agent.name}`, label: agent.name }));
    }
    return agents
      .filter((agent) => agent.name.startsWith(lastWord))
      .map((agent) => ({ value: `${beforeLastWord}${agent.name}`, label: agent.name }));
  };
}

export function discoverSavedChains(cwd: string, trusted: boolean): ChainConfig[] {
  const chains = new Map<string, ChainConfig>();
  for (const chain of discoverAgentsAll(cwd, { projectTrusted: trusted }).chains) {
    const existing = chains.get(chain.name);
    const projectOverride = existing?.source === "user" && chain.source === "project";
    const jsonOverride =
      existing?.source === chain.source &&
      chain.filePath.endsWith(".chain.json") &&
      !existing.filePath.endsWith(".chain.json");
    if (!existing || projectOverride || jsonOverride) {
      chains.set(chain.name, chain);
    }
  }
  return [...chains.values()];
}

export function makeChainCompletions(
  pi: ExtensionAPI,
  state: SlashDiscoveryState,
): (prefix: string) => Completion[] | null {
  return (prefix) => {
    const cwd = completionCwd(pi, state);
    if (prefix.includes(" ") || cwd === null || cwd.length === 0) {
      return null;
    }
    return discoverSavedChains(cwd, projectTrusted(state))
      .filter((chain) => chain.name.startsWith(prefix))
      .map((chain) => ({ value: chain.name, label: chain.name }));
  };
}
