import { isRecord, isUnknownArray, recordAt } from "../../shared/unknown.ts";
import type { DynamicParallelStep, ParallelTaskItem } from "../../shared/types/workflow.ts";
import type {
  ReadonlyInput,
  ArtifactPaths,
  ChainOutputMap,
  JsonSchemaObject,
  SingleResult,
} from "../../shared/types.ts";
import { getSingleResultOutput } from "../../shared/utils.ts";
import { validateStructuredOutputValue } from "./structured-output.ts";

import {
  DynamicFanoutError,
  assertJsonPointer,
  resolveJsonPointer,
  scalarToKey,
  normalizeItemKeyForId,
  resolveItemTemplate,
} from "./dynamic-item.ts";
export {
  DynamicFanoutError,
  assertJsonPointer,
  resolveJsonPointer,
  normalizeItemKeyForId,
  resolveItemTemplate,
} from "./dynamic-item.ts";

export interface DynamicFanoutConfig {
  readonly maxItems?: number;
  readonly allowRunnerFields?: boolean;
}

export interface DynamicMaterializedItem {
  readonly index: number;
  readonly key: string;
  readonly idKey: string;
  readonly item: unknown;
}

export interface DynamicCollectedResult {
  key: string;
  index: number;
  item: unknown;
  agent: string;
  exitCode: number | null;
  text: string;
  structured?: unknown;
  error?: string;
  outputPath?: string;
  artifactPaths?: ArtifactPaths;
}

export interface DynamicMaterializedGroup {
  items: DynamicMaterializedItem[];
  parallel: ParallelTaskItem[];
}

const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ITEM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ITEM_REF_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)(?:\.([^{}]+))?\}/g;
const RESERVED_TEMPLATE_NAMES = new Set(["task", "previous", "chain_dir", "outputs"]);
const DYNAMIC_STEP_KEYS = [
  "expand",
  "parallel",
  "collect",
  "concurrency",
  "failFast",
  "phase",
  "label",
  "acceptance",
];
const RUNNER_DYNAMIC_STEP_KEYS = [...DYNAMIC_STEP_KEYS, "effectiveAcceptance", "sessionFiles"];
const DYNAMIC_EXPAND_KEYS = ["from", "item", "key", "maxItems", "onEmpty"];
const DYNAMIC_EXPAND_FROM_KEYS = ["output", "path"];
const DYNAMIC_PARALLEL_KEYS = [
  "agent",
  "task",
  "phase",
  "label",
  "outputSchema",
  "cwd",
  "output",
  "outputMode",
  "reads",
  "progress",
  "skill",
  "model",
  "acceptance",
];
const RUNNER_DYNAMIC_PARALLEL_KEYS = [
  ...DYNAMIC_PARALLEL_KEYS,
  "outputName",
  "structured",
  "inheritProjectContext",
  "inheritSkills",
  "skills",
  "outputPath",
  "outputPathFromAgentDefault",
  "allowSubagents",
  "maxSubagentDepth",
  "structuredOutput",
  "structuredOutputSchema",
  "tools",
  "extensions",
  "mcpDirectTools",
  "completionGuard",
  "systemPrompt",
  "systemPromptMode",
  "thinking",
  "modelCandidates",
  "sessionFile",
  "effectiveAcceptance",
  "maxExecutionTimeMs",
  "maxTokens",
  "launch",
];
const DYNAMIC_COLLECT_KEYS = ["as", "outputSchema"];

export function isSafeOutputName(name: string): boolean {
  return SAFE_OUTPUT_NAME_PATTERN.test(name);
}

function assertOnlyKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!isRecord(value)) {
    throw new DynamicFanoutError(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new DynamicFanoutError(`${label} does not support field '${key}'.`);
    }
  }
}

const VALID_ITEM_REF_PATTERN = new RegExp(ITEM_REF_PATTERN.source);

function validateTemplateReference(
  raw: string,
  reference: string,
  itemName: string,
  label: string,
): void {
  if (reference === itemName || reference.startsWith(`${itemName}.`)) {
    if (
      !VALID_ITEM_REF_PATTERN.test(raw) ||
      reference === `${itemName}.` ||
      reference.includes("..")
    ) {
      throw new DynamicFanoutError(`Invalid item reference '${raw}' in ${label}.`);
    }
    return;
  }
  const name = reference.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
  if (name === itemName) {
    throw new DynamicFanoutError(`Invalid item reference '${raw}' in ${label}.`);
  }
  if (name === undefined || RESERVED_TEMPLATE_NAMES.has(name)) {
    return;
  }
  throw new DynamicFanoutError(`Unsupported template reference '${raw}' in ${label}.`);
}

export function assertNoUnresolvedItemReferences(
  template: string,
  itemName: string,
  label: string,
): void {
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    validateTemplateReference(match[0], match[1], itemName, label);
  }
  if (
    template.includes(`{${itemName}.}`) ||
    new RegExp(`\\{${itemName}(?:\\.|$)[^}]*$`).test(template)
  ) {
    throw new DynamicFanoutError(`Invalid item reference in ${label}.`);
  }
}

export function hasDynamicFanoutFields(step: unknown): boolean {
  return (
    isRecord(step) &&
    (Object.prototype.hasOwnProperty.call(step, "expand") ||
      Object.prototype.hasOwnProperty.call(step, "collect"))
  );
}

function validateItemLimit(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new DynamicFanoutError(`${label} must be an integer >= 0.`);
  }
}

function validateExpansion(
  step: ReadonlyInput<DynamicParallelStep>,
  prefix: string,
  config: DynamicFanoutConfig,
): void {
  if (!recordAt(step, "expand") || !recordAt(step.expand, "from")) {
    throw new DynamicFanoutError(`${prefix} requires expand.from.`);
  }
  assertOnlyKeys(step.expand, DYNAMIC_EXPAND_KEYS, `${prefix} expand`);
  assertOnlyKeys(step.expand.from, DYNAMIC_EXPAND_FROM_KEYS, `${prefix} expand.from`);
  if (!isSafeOutputName(step.expand.from.output)) {
    throw new DynamicFanoutError(
      `${prefix} has invalid expand.from.output '${step.expand.from.output}'.`,
    );
  }
  assertJsonPointer(step.expand.from.path, `${prefix} expand.from.path`);
  if (step.expand.key !== undefined) {
    assertJsonPointer(step.expand.key, `${prefix} expand.key`);
  }
  const itemName = step.expand.item ?? "item";
  if (!ITEM_NAME_PATTERN.test(itemName)) {
    throw new DynamicFanoutError(`${prefix} has invalid expand.item '${itemName}'.`);
  }
  if (step.expand.maxItems === undefined && config.maxItems === undefined) {
    throw new DynamicFanoutError(
      `${prefix} requires expand.maxItems or config.chain.dynamicFanout.maxItems.`,
    );
  }
  validateItemLimit(step.expand.maxItems, `${prefix} expand.maxItems`);
  validateItemLimit(config.maxItems, "config.chain.dynamicFanout.maxItems");
}

function validateParallelTemplate(
  step: ReadonlyInput<DynamicParallelStep>,
  prefix: string,
  config: DynamicFanoutConfig,
): void {
  if (!recordAt(step, "parallel")) {
    throw new DynamicFanoutError(
      `${prefix} requires a single parallel template object and cannot mix dynamic expand/collect with static parallel arrays.`,
    );
  }
  assertOnlyKeys(
    step.parallel,
    config.allowRunnerFields === true ? RUNNER_DYNAMIC_PARALLEL_KEYS : DYNAMIC_PARALLEL_KEYS,
    `${prefix} parallel`,
  );
  if ("expand" in step.parallel) {
    throw new DynamicFanoutError(`${prefix} does not support nested dynamic fanout.`);
  }
  if (step.parallel.agent.length === 0) {
    throw new DynamicFanoutError(`${prefix} parallel.agent is required.`);
  }
  const itemName = step.expand.item ?? "item";
  for (const [label, template] of [
    ["parallel.task", step.parallel.task],
    ["parallel.label", step.parallel.label],
  ] as const) {
    if (template !== undefined && template.length > 0) {
      assertNoUnresolvedItemReferences(template, itemName, `${prefix} ${label}`);
    }
  }
}

function validateCollection(step: ReadonlyInput<DynamicParallelStep>, prefix: string): void {
  if (!recordAt(step, "collect") || !isSafeOutputName(step.collect.as)) {
    throw new DynamicFanoutError(`${prefix} requires collect.as with a safe output name.`);
  }
  assertOnlyKeys(step.collect, DYNAMIC_COLLECT_KEYS, `${prefix} collect`);
}

export function validateDynamicStepShape(
  step: ReadonlyInput<DynamicParallelStep>,
  stepIndex: number,
  config: DynamicFanoutConfig = {},
): void {
  const prefix = `Dynamic chain step ${stepIndex + 1}`;
  if (Object.hasOwn(step, "acceptance") || Object.hasOwn(step, "effectiveAcceptance")) {
    throw new DynamicFanoutError(
      `Dynamic fanout step ${stepIndex + 1} does not support group-level acceptance; set acceptance on the child template instead.`,
    );
  }
  assertOnlyKeys(
    step,
    config.allowRunnerFields === true ? RUNNER_DYNAMIC_STEP_KEYS : DYNAMIC_STEP_KEYS,
    prefix,
  );
  validateExpansion(step, prefix, config);
  validateParallelTemplate(step, prefix, config);
  validateCollection(step, prefix);
}

export function resolveDynamicFanoutItems(
  step: ReadonlyInput<DynamicParallelStep>,
  outputs: ReadonlyInput<ChainOutputMap>,
  stepIndex: number,
  config: DynamicFanoutConfig = {},
): DynamicMaterializedItem[] {
  validateDynamicStepShape(step, stepIndex, config);
  const sourceName = step.expand.from.output;
  const source = outputs[sourceName];
  if (!Object.hasOwn(outputs, sourceName)) {
    throw new DynamicFanoutError(
      `Dynamic chain step ${stepIndex + 1} references unknown output '${sourceName}'.`,
    );
  }
  if (source.structured === undefined) {
    throw new DynamicFanoutError(
      `Dynamic chain step ${stepIndex + 1} requires structured output '${sourceName}'.`,
    );
  }
  const value = resolveJsonPointer(
    source.structured,
    step.expand.from.path,
    `Dynamic chain step ${stepIndex + 1} expand.from.path`,
  );
  if (!isUnknownArray(value)) {
    throw new DynamicFanoutError(
      `Dynamic chain step ${stepIndex + 1} expand.from.path must resolve to an array.`,
    );
  }
  const maxItems = step.expand.maxItems ?? config.maxItems;
  if (maxItems === undefined) {
    throw new DynamicFanoutError(
      `Dynamic chain step ${stepIndex + 1} requires an effective maxItems.`,
    );
  }
  if (value.length > maxItems) {
    throw new DynamicFanoutError(
      `Dynamic chain step ${stepIndex + 1} resolved ${value.length} items, exceeding maxItems ${maxItems}.`,
    );
  }
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  return value.map((item: unknown, index) => {
    const key =
      step.expand.key === undefined
        ? String(index)
        : scalarToKey(
            resolveJsonPointer(
              item,
              step.expand.key,
              `Dynamic chain step ${stepIndex + 1} expand.key`,
            ),
            `Dynamic chain step ${stepIndex + 1} expand.key`,
          );
    if (seen.has(key)) {
      throw new DynamicFanoutError(
        `Dynamic chain step ${stepIndex + 1} produced duplicate item key '${key}'.`,
      );
    }
    seen.add(key);
    const idKey = normalizeItemKeyForId(key);
    if (seenIds.has(idKey)) {
      throw new DynamicFanoutError(
        `Dynamic chain step ${stepIndex + 1} produced colliding item id '${idKey}'.`,
      );
    }
    seenIds.add(idKey);
    return { index, key, idKey, item };
  });
}

export function materializeDynamicParallelStep(
  step: ReadonlyInput<DynamicParallelStep>,
  outputs: ReadonlyInput<ChainOutputMap>,
  stepIndex: number,
  config: DynamicFanoutConfig = {},
): DynamicMaterializedGroup {
  const items = resolveDynamicFanoutItems(step, outputs, stepIndex, config);
  if (items.length === 0) {
    if ((step.expand.onEmpty ?? "skip") === "fail") {
      throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} source array is empty.`);
    }
    return { items, parallel: [] };
  }
  const itemName = step.expand.item ?? "item";
  const parallel = items.map((entry) => {
    const task = resolveItemTemplate(step.parallel.task ?? "{previous}", itemName, entry.item);
    const label =
      (step.parallel.label ?? "").length > 0
        ? resolveItemTemplate(step.parallel.label ?? "", itemName, entry.item)
        : undefined;
    return {
      ...step.parallel,
      task,
      ...(label !== undefined ? { label } : {}),
    };
  });
  return { items, parallel };
}

type CollectionChild = ReadonlyInput<
  Pick<
    SingleResult,
    "agent" | "error" | "structuredOutput" | "artifactPaths" | "savedOutputPath" | "messages"
  > & { exitCode: number | null; output?: string; finalOutput?: string }
>;

function collectionText(result: CollectionChild): string {
  return typeof result.output === "string" ? result.output : getSingleResultOutput(result);
}

function collectionMetadata(result: CollectionChild): Partial<DynamicCollectedResult> {
  return {
    ...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
    ...((result.error ?? "").length > 0 ? { error: result.error } : {}),
    ...((result.savedOutputPath ?? "").length > 0 ? { outputPath: result.savedOutputPath } : {}),
    ...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
  };
}

export function collectDynamicResults(
  step: ReadonlyInput<DynamicParallelStep>,
  items: readonly DynamicMaterializedItem[],
  results: readonly CollectionChild[],
): DynamicCollectedResult[] {
  return items.map((entry, index) => {
    const result = Object.hasOwn(results, index) ? results[index] : undefined;
    return {
      key: entry.key,
      index: entry.index,
      item: entry.item,
      agent: result?.agent ?? step.parallel.agent,
      exitCode: result?.exitCode ?? null,
      text: result ? collectionText(result) : "",
      ...(result ? collectionMetadata(result) : {}),
    };
  });
}

export function validateDynamicCollection(
  schema: ReadonlyInput<JsonSchemaObject> | undefined,
  value: readonly ReadonlyInput<DynamicCollectedResult>[],
): void {
  if (!schema) {
    return;
  }
  const validation = validateStructuredOutputValue(schema, value);
  if (validation.status === "invalid") {
    throw new DynamicFanoutError(`Collected output validation failed: ${validation.message}`);
  }
}
