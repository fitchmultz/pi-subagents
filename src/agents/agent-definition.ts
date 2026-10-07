import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, AgentSource } from "../shared/types/config.ts";
import { KNOWN_FIELDS } from "./agent-serializer.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";
import {
  listFilesRecursive,
  pathIsInside,
  type AgentDiscoveryDiagnostic,
} from "./discovery-paths.ts";
import { csvItems, splitToolList, errorMessage } from "./config-values.ts";
import {
  defaultSystemPromptMode,
  defaultInheritProjectContext,
  defaultInheritSkills,
} from "./agent-defaults.ts";

type Frontmatter = Readonly<Partial<Record<string, string>>>;
const reportedDiagnostics = new Map<string, { filePath: string; error: string }>();
const loggedDiagnostics = new Set<string>();
const MAX_DIAGNOSTICS = 1_000;

function reportDiagnostic(filePath: string, message: string): void {
  const key = `${filePath}\0${message}`;
  if (!reportedDiagnostics.has(key) && reportedDiagnostics.size >= MAX_DIAGNOSTICS) {
    const oldest = reportedDiagnostics.keys().next().value;
    if (oldest !== undefined) {
      reportedDiagnostics.delete(oldest);
    }
  }
  reportedDiagnostics.set(key, { filePath, error: message });
  if (loggedDiagnostics.has(key)) {
    return;
  }
  if (loggedDiagnostics.size >= MAX_DIAGNOSTICS) {
    const oldest = loggedDiagnostics.values().next().value;
    if (oldest !== undefined) {
      loggedDiagnostics.delete(oldest);
    }
  }
  loggedDiagnostics.add(key);
  console.error(`Invalid agent definition '${filePath}: ${message}'`);
}

export function clearAgentDiagnosticsForDirs(dirs: readonly string[]): void {
  for (const [key, entry] of reportedDiagnostics) {
    if (dirs.some((dir) => pathIsInside(dir, entry.filePath))) {
      reportedDiagnostics.delete(key);
    }
  }
}

export function agentDiagnosticsForDir(
  dir: string,
  source: AgentDiscoveryDiagnostic["source"],
): AgentDiscoveryDiagnostic[] {
  return [...reportedDiagnostics.values()]
    .filter((entry) => pathIsInside(dir, entry.filePath))
    .map((entry) => ({ filePath: entry.filePath, error: entry.error, source }));
}

function validateDefinition(frontmatter: Frontmatter): string | undefined {
  const booleans = [
    "allowSubagents",
    "inheritProjectContext",
    "inheritSkills",
    "defaultProgress",
    "interactive",
    "completionGuard",
  ];
  const invalid = booleans.find(
    (field) =>
      frontmatter[field] !== undefined &&
      frontmatter[field] !== "true" &&
      frontmatter[field] !== "false",
  );
  if (invalid !== undefined) {
    return `${invalid} must be true or false`;
  }
  if (
    frontmatter.systemPromptMode !== undefined &&
    frontmatter.systemPromptMode !== "append" &&
    frontmatter.systemPromptMode !== "replace"
  ) {
    return "systemPromptMode must be append or replace";
  }
  if (
    frontmatter.defaultContext !== undefined &&
    frontmatter.defaultContext !== "fresh" &&
    frontmatter.defaultContext !== "fork"
  ) {
    return "defaultContext must be fresh or fork";
  }
  return validateLimits(frontmatter);
}

function validateLimits(frontmatter: Frontmatter): string | undefined {
  for (const [field, minimum] of [
    ["maxSubagentDepth", 0],
    ["maxExecutionTimeMs", 1],
    ["maxTokens", 1],
  ] as const) {
    if (
      frontmatter[field] !== undefined &&
      (!Number.isInteger(Number(frontmatter[field])) || Number(frontmatter[field]) < minimum)
    ) {
      return `${field} must be an integer >= ${minimum}`;
    }
  }
  return undefined;
}

function optionalList(value: string | undefined): string[] | undefined {
  const items = value === undefined ? [] : csvItems(value);
  return items.length > 0 ? items : undefined;
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === "true";
}

function contextFields(
  frontmatter: Frontmatter,
  name: string,
): Pick<
  AgentConfig,
  | "systemPromptMode"
  | "inheritProjectContext"
  | "inheritSkills"
  | "defaultContext"
  | "completionGuard"
> {
  const defaultContext = frontmatter.defaultContext;
  const systemPromptMode = frontmatter.systemPromptMode;
  return {
    systemPromptMode:
      systemPromptMode === "append" || systemPromptMode === "replace"
        ? systemPromptMode
        : defaultSystemPromptMode(name),
    inheritProjectContext:
      optionalBoolean(frontmatter.inheritProjectContext) ?? defaultInheritProjectContext(name),
    inheritSkills: optionalBoolean(frontmatter.inheritSkills) ?? defaultInheritSkills(),
    defaultContext:
      defaultContext === "fresh" || defaultContext === "fork" ? defaultContext : undefined,
    completionGuard: optionalBoolean(frontmatter.completionGuard),
  };
}

function extraFields(frontmatter: Frontmatter): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KNOWN_FIELDS.has(key) && value !== undefined) {
      fields[key] = value;
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function definitionFields(frontmatter: Frontmatter): Partial<AgentConfig> {
  return {
    ...splitToolList(optionalList(frontmatter.tools)),
    allowSubagents: frontmatter.allowSubagents === "true",
    model: frontmatter.model,
    fallbackModels: optionalList(frontmatter.fallbackModels),
    thinking: frontmatter.thinking,
    skills: optionalList(
      frontmatter.skill === undefined || frontmatter.skill.length === 0
        ? frontmatter.skills
        : frontmatter.skill,
    ),
    extensions: frontmatter.extensions === undefined ? undefined : csvItems(frontmatter.extensions),
    output: frontmatter.output,
    defaultReads: optionalList(frontmatter.defaultReads),
    defaultProgress: frontmatter.defaultProgress === "true",
    interactive: frontmatter.interactive === "true",
    maxSubagentDepth:
      frontmatter.maxSubagentDepth === undefined ? 0 : Number(frontmatter.maxSubagentDepth),
    maxExecutionTimeMs:
      frontmatter.maxExecutionTimeMs === undefined
        ? undefined
        : Number(frontmatter.maxExecutionTimeMs),
    maxTokens: frontmatter.maxTokens === undefined ? undefined : Number(frontmatter.maxTokens),
    extraFields: extraFields(frontmatter),
  };
}

function loadDefinition(filePath: string, source: AgentSource): AgentConfig | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    reportDiagnostic(filePath, `cannot read file: ${errorMessage(error)}`);
    return undefined;
  }
  const { frontmatter, body } = parseFrontmatter(content);
  if (
    frontmatter.name === undefined ||
    frontmatter.name.length === 0 ||
    frontmatter.description === undefined ||
    frontmatter.description.length === 0
  ) {
    reportDiagnostic(filePath, "frontmatter must include name and description");
    return undefined;
  }
  const localName = frontmatter.name;
  const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
  if (parsedPackage.error !== undefined) {
    reportDiagnostic(filePath, parsedPackage.error);
    return undefined;
  }
  const error = validateDefinition(frontmatter);
  if (error !== undefined) {
    reportDiagnostic(filePath, error);
    return undefined;
  }
  return {
    ...definitionFields(frontmatter),
    ...contextFields(frontmatter, localName),
    name: buildRuntimeName(localName, parsedPackage.packageName),
    localName,
    packageName: parsedPackage.packageName,
    description: frontmatter.description,
    systemPrompt: body,
    source,
    filePath,
  };
}

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const files = listFilesRecursive(
    dir,
    (name) =>
      name.endsWith(".md") &&
      !name.endsWith(".chain.md") &&
      name !== "SKILL.template.md" &&
      name !== "AGENTS.md",
  );
  const agents: AgentConfig[] = [];
  for (const filePath of files) {
    if (path.relative(dir, filePath).split(path.sep)[0] === "skills") {
      continue;
    }
    const agent = loadDefinition(filePath, source);
    if (agent !== undefined) {
      agents.push(agent);
    }
  }
  return agents;
}
