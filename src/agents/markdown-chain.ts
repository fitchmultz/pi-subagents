import type { Writable } from "type-fest";
import type { ChainConfig, ChainStepConfig } from "../shared/types/config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import { csvItems } from "./config-values.ts";

type StepPatch = Partial<Writable<ChainStepConfig>>;
function outputMode(value: string, agent: string): "inline" | "file-only" {
  if (value !== "inline" && value !== "file-only") {
    throw new Error(`Invalid outputMode '${value}' for step '${agent}'.`);
  }
  return value;
}
function progress(value: string, agent: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error(`Invalid progress '${value}' for step '${agent}'; use true or false.`);
  }
  return value === "true";
}
function outputSchema(value: string): StepPatch {
  if (value.startsWith("{") || value.startsWith("[")) {
    throw new Error(
      "Inline outputSchema values are not supported in .chain.md files; use a schema file path.",
    );
  }
  return value.length === 0 ? {} : { outputSchema: value };
}
function listValue(value: string): string[] | false {
  if (value === "false") {
    return false;
  }
  const items = csvItems(value);
  return items.length > 0 ? items : false;
}
function outputValue(value: string): StepPatch {
  if (value === "false") {
    return { output: false };
  }
  return value.length > 0 ? { output: value } : {};
}
function metadata(key: string, value: string, agent: string): StepPatch | null {
  switch (key) {
    case "output":
      return outputValue(value);
    case "phase":
      return value.length > 0 ? { phase: value } : {};
    case "label":
      return value.length > 0 ? { label: value } : {};
    case "as":
      return value.length > 0 ? { as: value } : {};
    case "model":
      return value.length > 0 ? { model: value } : {};
    case "outputschema":
      return outputSchema(value);
    case "outputmode":
      return { outputMode: outputMode(value, agent) };
    case "reads":
      return { reads: listValue(value) };
    case "skills":
      return { skills: listValue(value) };
    case "progress":
      return { progress: progress(value, agent) };
    default:
      return null;
  }
}
function encodedTask(raw: string, agent: string, previous: string | undefined): string {
  if (previous !== undefined) {
    throw new Error(`Duplicate task-json for step '${agent}'.`);
  }
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "string") {
    throw new Error(`task-json for step '${agent}' must be a JSON string.`);
  }
  return value;
}
function parseStepHeaderLines(
  lines: readonly string[],
  agent: string,
): { patch: StepPatch; leading: string[]; taskJson?: string } {
  const leading: string[] = [];
  const patch: StepPatch = {};
  let taskJson: string | undefined;
  for (const line of lines) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match === null) {
      leading.push(line);
      continue;
    }
    const key = (match.at(1) ?? "").trim().toLowerCase();
    const value = (match.at(2) ?? "").trim();
    if (key === "task-json") {
      taskJson = encodedTask(value, agent, taskJson);
      continue;
    }
    const field = metadata(key, value, agent);
    if (field === null) {
      leading.push(line);
    } else {
      Object.assign(patch, field);
    }
  }
  return { patch, leading, taskJson };
}
function parseStepBody(agent: string, body: string): ChainStepConfig {
  const lines = body.split("\n");
  const blankIndex = lines.findIndex((line) => line.trim() === "");
  const configLines = blankIndex === -1 ? lines : lines.slice(0, blankIndex);
  const proseLines = blankIndex === -1 ? [] : lines.slice(blankIndex + 1);
  const { patch, leading, taskJson } = parseStepHeaderLines(configLines, agent);
  const prose = [...leading, ...proseLines].join("\n").trim();
  if (taskJson !== undefined && prose.length > 0) {
    throw new Error(`Step '${agent}' cannot combine task-json with task prose.`);
  }
  return { agent, ...patch, task: taskJson ?? prose };
}
function markdownSteps(body: string): ChainStepConfig[] {
  const matches = [...body.matchAll(/^##\s+(.+)[^\S\n]*$/gm)];
  return matches.map((match, index) => {
    const agent = (match.at(1) ?? "").trim();
    const end = match.index + match[0].length;
    const start = end + (body[end] === "\n" ? 1 : 0);
    return parseStepBody(
      agent,
      body.slice(start, matches.at(index + 1)?.index ?? body.length).trimEnd(),
    );
  });
}
function chainExtraFields(
  frontmatter: Readonly<Partial<Record<string, string>>>,
): Record<string, string> | undefined {
  const extraFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key !== "name" && key !== "package" && key !== "description" && value !== undefined) {
      extraFields[key] = value;
    }
  }
  return Object.keys(extraFields).length > 0 ? extraFields : undefined;
}

export function parseChain(
  content: string,
  source: "user" | "project",
  filePath: string,
): ChainConfig {
  const { frontmatter, body } = parseFrontmatter(content);
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (
    name === undefined ||
    name.length === 0 ||
    description === undefined ||
    description.length === 0
  ) {
    throw new Error("Chain frontmatter must include name and description");
  }
  const steps = markdownSteps(body);
  if (steps.length === 0) {
    throw new Error("Chain must include at least one ## agent step.");
  }
  const parsedPackage = parsePackageName(frontmatter.package, `Chain '${name}' package`);
  if (parsedPackage.error !== undefined) {
    throw new Error(parsedPackage.error);
  }
  return {
    name: buildRuntimeName(name, parsedPackage.packageName),
    localName: name,
    packageName: parsedPackage.packageName,
    description,
    source,
    filePath,
    steps,
    extraFields: chainExtraFields(frontmatter),
  };
}
function stringLine(field: string, value: string | undefined): string[] {
  return value !== undefined && value.length > 0 ? [`${field}: ${value}`] : [];
}
function listLine(field: string, value: readonly string[] | false | undefined): string[] {
  if (value === false) {
    return [`${field}: false`];
  }
  return value !== undefined && value.length > 0 ? [`${field}: ${value.join(", ")}`] : [];
}
function stepOutputLines(step: ChainStepConfig): string[] {
  return [
    ...(step.output === false ? ["output: false"] : stringLine("output", step.output)),
    ...stringLine("phase", step.phase),
    ...stringLine("label", step.label),
    ...stringLine("as", step.as),
    ...(step.outputSchema === undefined
      ? []
      : stringLine(
          "outputSchema",
          typeof step.outputSchema === "string"
            ? step.outputSchema
            : Object.prototype.toString.call(step.outputSchema),
        )),
    ...stringLine("outputMode", step.outputMode),
    ...listLine("reads", step.reads),
    ...stringLine("model", step.model),
    ...listLine("skills", step.skills),
    ...(step.progress === undefined ? [] : [`progress: ${step.progress ? "true" : "false"}`]),
  ];
}
function taskLines(task: string): string[] {
  if (!/^##\s+/m.test(task)) {
    return ["", task];
  }
  // Preserve separators verbatim inside encoded prose, not as Markdown headers.
  const encoded = JSON.stringify(task)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return [`task-json: ${encoded}`];
}
export function serializeChain(config: ChainConfig): string {
  const lines = [
    "---",
    `name: ${frontmatterNameForConfig(config)}`,
    ...stringLine("package", config.packageName),
    `description: ${config.description}`,
    ...Object.entries(config.extraFields ?? {}).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
  ];
  for (const [index, step] of config.steps.entries()) {
    lines.push(
      `## ${step.agent ?? "undefined"}`,
      ...stepOutputLines(step),
      ...taskLines(step.task ?? ""),
    );
    if (index < config.steps.length - 1) {
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
