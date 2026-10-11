import type { ChainConfig, ChainStepConfig } from "../shared/types/config.ts";
import type { ChainStep } from "../shared/types/workflow.ts";
import { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import { isConfigObject, errorMessage, type ConfigObject } from "./config-values.ts";
import {
  validateChainOutputBindings,
  ChainOutputValidationError,
} from "../runs/shared/chain-outputs.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";
import { Check, Errors } from "../shared/native-typebox.ts";
import { ChainItemSchema } from "../extension/schemas.ts";
import {
  DynamicFanoutError,
  hasDynamicFanoutFields,
  validateDynamicStepShape,
} from "../runs/shared/dynamic-fanout.ts";

const STEP_KEYS = new Set([
  "agent",
  "task",
  "phase",
  "label",
  "as",
  "outputSchema",
  "cwd",
  "output",
  "outputMode",
  "reads",
  "progress",
  "skill",
  "model",
  "acceptance",
  "parallel",
  "expand",
  "collect",
  "concurrency",
  "failFast",
  "worktree",
]);
const TASK_KEYS = new Set([
  "agent",
  "task",
  "phase",
  "label",
  "as",
  "outputSchema",
  "cwd",
  "count",
  "output",
  "outputMode",
  "reads",
  "progress",
  "skill",
  "model",
  "acceptance",
]);
function parseRoot(
  content: string,
  filePath: string,
): ConfigObject & {
  readonly name: string;
  readonly description: string;
  readonly chain: readonly unknown[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON chain '${filePath}': ${errorMessage(error)}`, { cause: error });
  }
  if (!isConfigObject(parsed)) {
    throw new Error(`JSON chain '${filePath}' must contain an object root.`);
  }
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    throw new Error(`JSON chain '${filePath}' must include string name.`);
  }
  if (typeof parsed.description !== "string" || parsed.description.trim().length === 0) {
    throw new Error(`JSON chain '${filePath}' must include string description.`);
  }
  if (!Array.isArray(parsed.chain) || parsed.chain.length === 0) {
    throw new Error(`JSON chain '${filePath}' must include a non-empty array chain.`);
  }
  return { ...parsed, name: parsed.name, description: parsed.description, chain: parsed.chain };
}
function unknownFields(input: ConfigObject, keys: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
}
function validateTask(task: unknown, label: string): void {
  if (!isConfigObject(task) || typeof task.agent !== "string" || task.agent.trim().length === 0) {
    throw new Error(`${label} must include a non-empty agent.`);
  }
  unknownFields(task, [...TASK_KEYS], label);
}
function validateParallel(step: ConfigObject, label: string): void {
  const parallel = step.parallel;
  if (parallel === undefined) {
    if (typeof step.agent !== "string" || step.agent.trim().length === 0) {
      throw new Error(`${label} must include a non-empty agent.`);
    }
    return;
  }
  if (step.agent !== undefined) {
    throw new Error(`${label} cannot set both agent and parallel.`);
  }
  if (Array.isArray(parallel)) {
    if (parallel.length === 0) {
      throw new Error(`${label} parallel must not be empty.`);
    }
    parallel.forEach((task: unknown, index) => {
      validateTask(task, `${label} parallel task ${index + 1}`);
    });
    return;
  }
  validateDynamicTemplate(step, label);
}
function validateDynamicTemplate(step: ConfigObject, label: string): void {
  const parallel = step.parallel;
  if (!isConfigObject(parallel)) {
    throw new Error(`${label} parallel must be an array or object.`);
  }
  if (typeof parallel.agent !== "string" || parallel.agent.trim().length === 0) {
    throw new Error(`${label} dynamic template must include a non-empty agent.`);
  }
  if (
    step.expand === null ||
    typeof step.expand !== "object" ||
    step.collect === null ||
    typeof step.collect !== "object"
  ) {
    throw new Error(`${label} dynamic fanout requires expand and collect objects.`);
  }
}
function validateAcceptance(value: unknown, label: string, filePath: string): void {
  const errors = validateAcceptanceInput(value, label);
  if (errors.length > 0) {
    throw new Error(`Invalid JSON chain '${filePath}': ${errors.join(" ")}`);
  }
}
function validateStepAcceptance(step: ConfigObject, index: number, filePath: string): void {
  const parallel = step.parallel;
  const group = Array.isArray(parallel) || isConfigObject(parallel);
  if (group && Object.hasOwn(step, "acceptance")) {
    const kind = Array.isArray(parallel) ? "static parallel" : "dynamic fanout";
    const target = Array.isArray(parallel) ? "each parallel task" : "the dynamic template";
    throw new Error(
      `Invalid JSON chain '${filePath}': step ${index + 1} acceptance is not supported on ${kind} groups; set acceptance on ${target}.`,
    );
  }
  validateAcceptance(step.acceptance, `step ${index + 1} acceptance`, filePath);
  if (Array.isArray(parallel)) {
    parallel.forEach((task: unknown, taskIndex) => {
      if (isConfigObject(task)) {
        validateAcceptance(
          task.acceptance,
          `step ${index + 1} parallel task ${taskIndex + 1} acceptance`,
          filePath,
        );
      }
    });
  } else if (isConfigObject(parallel)) {
    validateAcceptance(
      parallel.acceptance,
      `step ${index + 1} dynamic template acceptance`,
      filePath,
    );
  }
}
function validateStep(step: unknown, index: number, filePath: string): ConfigObject {
  const label = `JSON chain '${filePath}' step ${index + 1}`;
  if (!isConfigObject(step)) {
    throw new Error(`${label} must be an object.`);
  }
  unknownFields(step, [...STEP_KEYS], label);
  validateParallel(step, label);
  if (
    step.concurrency !== undefined &&
    (typeof step.concurrency !== "number" ||
      !Number.isInteger(step.concurrency) ||
      step.concurrency < 1)
  ) {
    throw new Error(`${label} concurrency must be an integer >= 1.`);
  }
  validateStepAcceptance(step, index, filePath);
  return step;
}

function isRuntimeStep(value: unknown): value is ChainStep {
  // The native schema owns complete runtime field validation, including its structural union.
  return Check(ChainItemSchema, value);
}

function validateDynamicRecord(value: ConfigObject, index: number, filePath: string): void {
  if (!hasDynamicFanoutFields(value)) {
    return;
  }
  try {
    validateDynamicStepShape(value, index, { maxItems: Number.MAX_SAFE_INTEGER });
  } catch (error) {
    if (error instanceof DynamicFanoutError) {
      throw new Error(`Invalid JSON chain '${filePath}': ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function checkedStep(value: ConfigObject, index: number, filePath: string): ChainStep {
  if (
    (value.expand !== undefined || value.collect !== undefined) &&
    Array.isArray(value.parallel)
  ) {
    throw new Error(
      `Invalid JSON chain '${filePath}': Dynamic chain step ${index + 1} requires expand, a single parallel template object, and collect; dynamic expand/collect cannot be mixed with static parallel arrays.`,
    );
  }
  validateDynamicRecord(value, index, filePath);
  if (!isRuntimeStep(value)) {
    const diagnostic = [...Errors(ChainItemSchema, value)].at(0)?.message;
    throw new Error(
      `JSON chain '${filePath}' step ${index + 1} is invalid${diagnostic === undefined ? "" : `: ${diagnostic}`}.`,
    );
  }
  return value;
}
function outputBindings(steps: readonly ChainStep[], filePath: string): void {
  try {
    validateChainOutputBindings([...steps], { maxItems: Number.MAX_SAFE_INTEGER });
  } catch (error) {
    if (error instanceof ChainOutputValidationError) {
      throw new Error(`Invalid JSON chain '${filePath}': ${error.message}`, { cause: error });
    }
    throw error;
  }
}
function normalizeStep(step: ChainStep): ChainStepConfig {
  if (!("skill" in step)) {
    return step;
  }
  const { skill, ...normalized } = step;
  return { ...normalized, skills: typeof skill === "string" ? [skill] : skill };
}
export function parseJsonChain(
  content: string,
  source: "user" | "project",
  filePath: string,
): ChainConfig {
  const input = parseRoot(content, filePath);
  const records = input.chain.map((step, index) => validateStep(step, index, filePath));
  const steps = records.map((step, index) => checkedStep(step, index, filePath));
  outputBindings(steps, filePath);
  const parsedPackage = parsePackageName(
    typeof input.package === "string" ? input.package : undefined,
    `Chain '${input.name}' package`,
  );
  if (parsedPackage.error !== undefined) {
    throw new Error(parsedPackage.error);
  }
  const extraFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      key !== "name" &&
      key !== "package" &&
      key !== "description" &&
      key !== "chain" &&
      typeof value === "string"
    ) {
      extraFields[key] = value;
    }
  }
  return {
    name: buildRuntimeName(input.name.trim(), parsedPackage.packageName),
    localName: input.name.trim(),
    packageName: parsedPackage.packageName,
    description: input.description.trim(),
    source,
    filePath,
    steps: steps.map(normalizeStep),
    extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
  };
}
export function serializeJsonChain(config: ChainConfig): string {
  const chain = config.steps.map((step) => {
    const { skills, ...serialized } = step;
    return skills === undefined ? serialized : { ...serialized, skill: skills };
  });
  const extra = Object.fromEntries(
    Object.entries(config.extraFields ?? {}).filter(
      ([key]) => key !== "name" && key !== "description" && key !== "package" && key !== "chain",
    ),
  );
  const root = {
    name: frontmatterNameForConfig(config),
    description: config.description,
    chain,
    ...(config.packageName !== undefined && config.packageName.length > 0
      ? { package: config.packageName }
      : {}),
    ...extra,
  };
  return `${JSON.stringify(root, null, 2)}\n`;
}
