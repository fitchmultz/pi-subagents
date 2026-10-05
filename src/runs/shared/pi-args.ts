import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpDirectToolNames } from "./mcp-direct-tool-allowlist.ts";
import {
  childRouteEnv,
  SUBAGENT_EAGER_TOOL_ENV,
  SUBAGENT_INHERITED_EXTENSIONS_JSON_ENV,
} from "./child-route-env.ts";
export * from "./child-route-env.ts";
import type { BuildPiArgsInput, BuildPiArgsResult } from "./pi-launch-input.ts";
import { isUnknownArray } from "../../shared/unknown.ts";
import { isObject, nonempty } from "./child-json.ts";
import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import { piSessionLaunch } from "./pi-session-launch.ts";
import type { ChildProjectTrustPolicy, ReadonlyInput } from "../../shared/types.ts";
import { loadConfig } from "../../extension/config.ts";
// Managed macOS environments can SIGKILL Node when one argv entry reaches ~930 UTF-8 bytes.
// Measure the full entry (including the `Task: ` prefix), not just the task body.
const TASK_ARG_LIMIT_BYTES = 900;
// Resolve sibling extensions in both layouts: TypeScript sources (tests, jiti) and compiled dist output.
const MODULE_EXTENSION = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `subagent-prompt-runtime${MODULE_EXTENSION}`,
);
const FANOUT_CHILD_EXTENSION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "extension",
  `fanout-child${MODULE_EXTENSION}`,
);

export function applyThinkingSuffix(
  model: string | undefined,
  thinking: string | undefined,
): string | undefined {
  if (!nonempty(model) || !nonempty(thinking)) {
    return model;
  }
  if (nonempty(splitKnownThinkingSuffix(model).thinkingSuffix)) {
    return model;
  }
  return `${model}:${thinking}`;
}

export function normalizeChildProjectTrustPolicy(input: unknown): ChildProjectTrustPolicy {
  if (input === "approve" || input === "no-approve" || input === "inherit") {
    return input;
  }
  if (isObject(input) && "childRuns" in input) {
    return normalizeChildProjectTrustPolicy(input.childRuns);
  }
  return input === undefined ? "inherit" : "no-approve";
}

export function resolveConfiguredChildProjectTrustPolicy(
  input: unknown,
  argv: readonly string[] = process.argv,
): ChildProjectTrustPolicy {
  const inherited = findInheritedProjectTrustFlag(argv);
  const configured = isObject(input) ? input.childRuns : input;
  const explicitInherit = configured === "inherit";
  if (explicitInherit) {
    return inherited ?? "inherit";
  }
  if (inherited === "no-approve") {
    return "no-approve";
  }
  if (input === undefined || (isObject(input) && !("childRuns" in input))) {
    return "approve";
  }
  const normalized = normalizeChildProjectTrustPolicy(input);
  return normalized === "inherit" ? "approve" : normalized;
}

function findInheritedProjectTrustFlag(
  argv: readonly string[],
): "approve" | "no-approve" | undefined {
  let inherited: "approve" | "no-approve" | undefined;
  for (const arg of argv) {
    if (arg === "--approve" || arg === "-a") {
      inherited = "approve";
    }
    if (arg === "--no-approve" || arg === "-na") {
      inherited = "no-approve";
    }
  }
  return inherited;
}

export function resolveChildProjectTrustArgs(
  policy: ChildProjectTrustPolicy = "inherit",
  argv: readonly string[] = process.argv,
): string[] {
  const inherited = findInheritedProjectTrustFlag(argv);
  if (policy === "approve") {
    return inherited === "no-approve" ? ["--no-approve"] : ["--approve"];
  }
  if (policy === "no-approve") {
    return ["--no-approve"];
  }

  if (inherited === undefined) {
    return [];
  }
  return [`--${inherited}`];
}

function inheritedRuntimeExtensionPaths(env: Readonly<NodeJS.ProcessEnv> = process.env): string[] {
  const raw = env[SUBAGENT_INHERITED_EXTENSIONS_JSON_ENV]?.trim();
  if (!nonempty(raw)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isUnknownArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function isExtensionTool(tool: string): boolean {
  return tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js");
}
function builtinLoadout(
  input: ReadonlyInput<BuildPiArgsInput>,
  declared: readonly string[],
  fanoutAuthorized: boolean,
  compact: boolean,
): string[] {
  const builtin = [...declared];
  if (builtin.length === 0) {
    return builtin;
  }
  if (fanoutAuthorized) {
    const additions = compact
      ? ["subagent", "delegate", "agent_runs", "load_subagent"]
      : ["subagent"];
    builtin.push(...additions.filter((tool) => !builtin.includes(tool)));
  }
  if (input.structuredOutput && !builtin.includes("structured_output")) {
    builtin.push("structured_output");
  }
  if (input.mcpDirectTools !== undefined && input.mcpDirectTools.length > 0) {
    builtin.push(...resolveMcpDirectToolNames(input.mcpDirectTools, input.cwd));
  }
  return builtin;
}
function buildToolLoadout(input: ReadonlyInput<BuildPiArgsInput>): {
  args: string[];
  toolExtensionPaths: string[];
  fanoutAuthorized: boolean;
  eager: boolean;
} {
  const declared = input.tools?.filter((tool) => !isExtensionTool(tool)) ?? [];
  const fanoutAuthorized = input.allowSubagents === true || declared.includes("subagent");
  const compact = fanoutAuthorized && loadConfig().compactChildTools !== false;
  const tools = builtinLoadout(input, declared, fanoutAuthorized, compact);
  return {
    args: tools.length > 0 ? ["--tools", tools.join(",")] : [],
    toolExtensionPaths: input.tools?.filter(isExtensionTool) ?? [],
    fanoutAuthorized,
    // Preserve explicit advanced tools, never inherit them into another profile.
    eager: declared.includes("subagent"),
  };
}

function buildExtensionArgs(
  input: ReadonlyInput<BuildPiArgsInput>,
  fanoutAuthorized: boolean,
  toolExtensionPaths: readonly string[],
): string[] {
  const args: string[] = [];
  const runtimeExtensions = fanoutAuthorized
    ? [
        PROMPT_RUNTIME_EXTENSION_PATH,
        FANOUT_CHILD_EXTENSION_PATH,
        ...inheritedRuntimeExtensionPaths(),
      ]
    : [PROMPT_RUNTIME_EXTENSION_PATH, ...inheritedRuntimeExtensionPaths()];
  if (input.extensions !== undefined) {
    args.push("--no-extensions");
    for (const extPath of new Set([
      ...runtimeExtensions,
      ...toolExtensionPaths,
      ...input.extensions,
    ])) {
      args.push("--extension", extPath);
    }
  } else {
    for (const extPath of new Set([...runtimeExtensions, ...toolExtensionPaths])) {
      args.push("--extension", extPath);
    }
  }

  return args;
}

function buildPromptArgs(input: ReadonlyInput<BuildPiArgsInput>): {
  args: string[];
  tempDir?: string;
} {
  const args: string[] = [];
  if (!input.inheritSkills) {
    args.push("--no-skills");
  }
  if (!input.inheritProjectContext) {
    args.push("--no-context-files");
  }

  let tempDir: string | undefined;
  if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const promptPath = path.join(tempDir, "system.md");
    fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
    args.push(
      input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      promptPath,
    );
  }

  const taskArg = `Task: ${input.task}`;
  if (Buffer.byteLength(taskArg) > TASK_ARG_LIMIT_BYTES) {
    if (!nonempty(tempDir)) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    }
    const taskFilePath = path.join(tempDir, "task.md");
    fs.writeFileSync(taskFilePath, taskArg, { mode: 0o600 });
    args.push(`@${taskFilePath}`);
  } else {
    args.push(taskArg);
  }

  return { args, tempDir };
}

export function buildPiArgs(input: ReadonlyInput<BuildPiArgsInput>): BuildPiArgsResult {
  const args = [...input.baseArgs, ...resolveChildProjectTrustArgs(input.projectTrust)];
  const session = piSessionLaunch(input);
  args.push(...session.args);
  const modelArg = applyThinkingSuffix(input.model, input.thinking);
  if (nonempty(modelArg)) {
    args.push("--model", modelArg);
  }
  const tools = buildToolLoadout(input);
  args.push(
    ...tools.args,
    ...buildExtensionArgs(input, tools.fanoutAuthorized, tools.toolExtensionPaths),
  );
  const prompt = buildPromptArgs(input);
  args.push(...prompt.args);
  return {
    args,
    env: {
      ...session.env,
      [SUBAGENT_EAGER_TOOL_ENV]: tools.eager ? "1" : undefined,
      ...childRouteEnv(input, tools.fanoutAuthorized),
    },
    tempDir: prompt.tempDir,
  };
}

export function cleanupTempDir(tempDir: string | null | undefined): void {
  if (!nonempty(tempDir)) {
    return;
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best effort.
  }
}
