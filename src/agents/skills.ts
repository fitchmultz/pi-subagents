import * as path from "node:path";
import { getAgentDir } from "../shared/agent-dir.ts";
import { buildSkillPaths } from "./skill-search-paths.ts";
import { collectFilesystemSkills, readSkill } from "./skill-files.ts";
import type {
  SkillSource,
  ResolvedSkill,
  CachedSkillEntry,
  SkillDiscoveryOptions,
} from "./skill-types.ts";
export type { SkillSource } from "./skill-types.ts";

const SUBAGENT_ORCHESTRATION_SKILL = "pi-subagents";
const LOAD_SKILLS_CACHE_TTL_MS = 5000;
const SOURCE_PRIORITY: Readonly<Record<SkillSource, number>> = {
  project: 700,
  "project-settings": 650,
  "project-package": 600,
  user: 300,
  "user-settings": 250,
  "user-package": 200,
  extension: 150,
  builtin: 100,
  unknown: 0,
};
let loadSkillsCache: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  skills: CachedSkillEntry[];
  timestamp: number;
} | null = null;

function chooseHigherPrioritySkill(
  existing: CachedSkillEntry | undefined,
  candidate: CachedSkillEntry,
): CachedSkillEntry {
  if (existing === undefined) {
    return candidate;
  }
  const existingPriority = SOURCE_PRIORITY[existing.source];
  const candidatePriority = SOURCE_PRIORITY[candidate.source];
  if (candidatePriority > existingPriority) {
    return candidate;
  }
  if (candidatePriority < existingPriority) {
    return existing;
  }
  return candidate.order < existing.order ? candidate : existing;
}

function getCachedSkills(cwd: string, projectTrusted = true): CachedSkillEntry[] {
  const now = Date.now();
  const agentDir = getAgentDir();
  if (
    loadSkillsCache !== null &&
    loadSkillsCache.cwd === cwd &&
    loadSkillsCache.agentDir === agentDir &&
    loadSkillsCache.projectTrusted === projectTrusted &&
    now - loadSkillsCache.timestamp < LOAD_SKILLS_CACHE_TTL_MS
  ) {
    return loadSkillsCache.skills;
  }
  const loaded = collectFilesystemSkills(
    cwd,
    agentDir,
    buildSkillPaths(cwd, agentDir, projectTrusted),
  );
  const deduped = new Map<string, CachedSkillEntry>();
  for (const entry of loaded) {
    deduped.set(entry.name, chooseHigherPrioritySkill(deduped.get(entry.name), entry));
  }
  const skills = [...deduped.values()].sort((a, b) => a.order - b.order);
  loadSkillsCache = { cwd, agentDir, projectTrusted, skills, timestamp: now };
  return skills;
}

export function resolveSkillPath(
  skillName: string,
  cwd: string,
  options: SkillDiscoveryOptions = {},
): { path: string; source: SkillSource } | undefined {
  const skill = getCachedSkills(cwd, options.projectTrusted ?? true).find(
    (entry) => entry.name === skillName,
  );
  return skill === undefined ? undefined : { path: skill.filePath, source: skill.source };
}

export function resolveSkills(
  skillNames: readonly string[],
  cwd: string,
  options: SkillDiscoveryOptions = {},
): { resolved: ResolvedSkill[]; missing: string[] } {
  const resolved: ResolvedSkill[] = [];
  const missing: string[] = [];
  for (const name of skillNames) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const location =
      trimmed === SUBAGENT_ORCHESTRATION_SKILL
        ? undefined
        : resolveSkillPath(trimmed, cwd, options);
    const skill =
      location === undefined ? undefined : readSkill(trimmed, location.path, location.source);
    if (skill === undefined) {
      missing.push(trimmed);
    } else {
      resolved.push(skill);
    }
  }
  return { resolved, missing };
}

export function resolveSkillsWithFallback(
  skillNames: readonly string[],
  primaryCwd: string,
  fallbackCwd?: string,
  options: SkillDiscoveryOptions = {},
): { resolved: ResolvedSkill[]; missing: string[] } {
  const primary = resolveSkills(skillNames, primaryCwd, options);
  if (
    fallbackCwd === undefined ||
    fallbackCwd.length === 0 ||
    primary.missing.length === 0 ||
    path.resolve(primaryCwd) === path.resolve(fallbackCwd)
  ) {
    return primary;
  }
  const fallback = resolveSkills(primary.missing, fallbackCwd, options);
  return { resolved: [...primary.resolved, ...fallback.resolved], missing: fallback.missing };
}

export function buildSkillInjection(skills: readonly ResolvedSkill[]): string {
  return skills
    .map((skill) => `<skill name="${skill.name}">\n${skill.content}\n</skill>`)
    .join("\n\n");
}

function normalizedNames(input: readonly string[]): string[] {
  return [...new Set(input.map((name) => name.trim()).filter((name) => name.length > 0))];
}

export function normalizeSkillInput(
  input: string | readonly string[] | boolean | undefined,
): string[] | false | undefined {
  if (input === false) {
    return false;
  }
  if (input === true || input === undefined) {
    return undefined;
  }
  if (typeof input !== "string") {
    return normalizedNames(input);
  }
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item: unknown) => typeof item === "string")) {
        return normalizedNames(parsed);
      }
    } catch {
      // Invalid JSON keeps the historical comma-separated input fallback.
    }
  }
  return normalizedNames(input.split(","));
}

export function discoverAvailableSkills(
  cwd: string,
  options: SkillDiscoveryOptions = {},
): Array<{ name: string; source: SkillSource; description?: string }> {
  return getCachedSkills(cwd, options.projectTrusted ?? true)
    .filter((skill) => skill.name !== SUBAGENT_ORCHESTRATION_SKILL)
    .map((skill) => ({ name: skill.name, source: skill.source, description: skill.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
