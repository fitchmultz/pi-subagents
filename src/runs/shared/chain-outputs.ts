import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../../shared/settings.ts";
import type { ReadonlyInput, ChainOutputMap, ChainOutputMapEntry } from "../../shared/types.ts";
import {
  DynamicFanoutError,
  hasDynamicFanoutFields,
  isSafeOutputName,
  resolveItemTemplate,
  type DynamicFanoutConfig,
  validateDynamicStepShape,
} from "./dynamic-fanout.ts";

const OUTPUT_REF_PATTERN = /\{outputs\.([^}]*)\}/g;

export class ChainOutputValidationError extends Error {}

function outputNamesForStep(step: ReadonlyInput<ChainStep>): string[] {
  if (isParallelStep(step)) {
    return step.parallel.map((task) => task.as).filter((name): name is string => Boolean(name));
  }
  if (isDynamicParallelStep(step)) {
    return [step.collect.as];
  }
  const name = step.as;
  return name !== undefined && name.length > 0 ? [name] : [];
}

function taskTemplatesForStep(step: ReadonlyInput<ChainStep>): string[] {
  if (isParallelStep(step)) {
    return step.parallel.map((task) => task.task ?? "{previous}");
  }
  if (isDynamicParallelStep(step)) {
    return [step.parallel.task ?? "{previous}", step.parallel.label ?? ""].filter(Boolean);
  }
  return [step.task ?? "{previous}"];
}

function validateDynamicSource(
  step: ReadonlyInput<ChainStep>,
  stepIndex: number,
  available: readonly string[],
  config: DynamicFanoutConfig,
): void {
  if (!hasDynamicFanoutFields(step)) {
    return;
  }
  if (!isDynamicParallelStep(step)) {
    throw new ChainOutputValidationError(
      `Dynamic chain step ${stepIndex + 1} requires expand, a single parallel template object, and collect; dynamic expand/collect cannot be mixed with static parallel arrays.`,
    );
  }
  try {
    validateDynamicStepShape(step, stepIndex, config);
  } catch (error) {
    if (error instanceof DynamicFanoutError) {
      throw new ChainOutputValidationError(error.message, { cause: error });
    }
    throw error;
  }
  if (!available.includes(step.expand.from.output)) {
    throw new ChainOutputValidationError(
      `Dynamic chain step ${stepIndex + 1} references unknown output '${step.expand.from.output}'. Named outputs are only available after producing step/group completes.`,
    );
  }
}

function validateTemplateBindings(
  templates: readonly string[],
  available: readonly string[],
  stepIndex: number,
): void {
  for (const template of templates) {
    for (const match of template.matchAll(OUTPUT_REF_PATTERN)) {
      const rawReference = match[0];
      const name = match[1];
      if (!isSafeOutputName(name)) {
        throw new ChainOutputValidationError(
          `Invalid chain output reference '${rawReference}' at step ${stepIndex + 1}. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`,
        );
      }
      if (!available.includes(name)) {
        throw new ChainOutputValidationError(
          `Unknown chain output reference '${rawReference}' at step ${stepIndex + 1}. Named outputs are only available after producing step/group completes.`,
        );
      }
    }
  }
}

export function validateChainOutputBindings(
  steps: readonly ReadonlyInput<ChainStep>[],
  dynamicFanoutConfig: DynamicFanoutConfig = {},
): void {
  const available: string[] = [];
  const seen = new Set<string>();
  for (const [stepIndex, step] of steps.entries()) {
    validateDynamicSource(step, stepIndex, available, dynamicFanoutConfig);
    for (const name of outputNamesForStep(step)) {
      if (!isSafeOutputName(name)) {
        throw new ChainOutputValidationError(
          `Invalid chain output name '${name}' at step ${stepIndex + 1}. Use /^[A-Za-z_][A-Za-z0-9_]*$/.`,
        );
      }
      if (seen.has(name)) {
        throw new ChainOutputValidationError(
          `Duplicate chain output name '${name}'. Each as name must be unique.`,
        );
      }
      seen.add(name);
    }
    validateTemplateBindings(taskTemplatesForStep(step), available, stepIndex);
    for (const name of outputNamesForStep(step)) {
      available.push(name);
    }
  }
}

export function resolveOutputReferences(
  template: string,
  outputs: ReadonlyInput<ChainOutputMap>,
): string {
  return template.replace(OUTPUT_REF_PATTERN, (rawReference, name: string) => {
    if (!isSafeOutputName(name)) {
      throw new ChainOutputValidationError(
        `Invalid chain output reference '${rawReference}'. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`,
      );
    }
    const entry: ChainOutputMapEntry | undefined = Object.hasOwn(outputs, name)
      ? outputs[name]
      : undefined;
    if (!entry) {
      throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}'.`);
    }
    return entry.text;
  });
}

interface TaskValues {
  readonly originalTask?: string;
  readonly previousOutput?: string;
  readonly chainDir?: string;
  readonly outputs?: ReadonlyInput<ChainOutputMap>;
  readonly item?: { readonly name: string; readonly value: unknown };
}

function isItemPlaceholder(raw: string, name: string): boolean {
  return raw === `{${name}}` || raw.startsWith(`{${name}.`);
}

function renderReference(raw: string, reference: string | undefined, values: TaskValues): string {
  if (values.item && isItemPlaceholder(raw, values.item.name)) {
    return resolveItemTemplate(raw, values.item.name, values.item.value);
  }
  if (reference === "task") {
    return values.originalTask ?? "";
  }
  if (reference === "chain_dir") {
    return values.chainDir ?? "";
  }
  if (reference !== undefined && reference.startsWith("outputs.")) {
    return resolveOutputReferences(raw, values.outputs ?? {});
  }
  return raw;
}

export function renderChainTask(
  template: string,
  values: TaskValues,
  placeholder = "{previous}",
): string {
  const pattern = new RegExp(
    `${placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|\\{([^{}]*)\\}`,
    "g",
  );
  const previousOutput = values.previousOutput ?? "";
  const usedPrevious = [...template.matchAll(pattern)].some(
    ([raw]) => raw === placeholder && !(values.item && isItemPlaceholder(raw, values.item.name)),
  );
  const task = template.replace(pattern, (raw: string, reference: string | undefined) => {
    // Item placeholders retain precedence if a caller customizes the previous-output placeholder.
    if (values.item && isItemPlaceholder(raw, values.item.name)) {
      return renderReference(raw, reference, values);
    }
    if (raw === placeholder) {
      return previousOutput;
    }
    return renderReference(raw, reference, values);
  });
  return !usedPrevious && previousOutput.trim().length > 0
    ? `${task}\n\n---\nPrevious step output:\n${previousOutput.trim()}`
    : task;
}

export function outputEntryFromResult(
  result: { readonly agent: string; readonly output: string; readonly structuredOutput?: unknown },
  stepIndex: number,
): ChainOutputMapEntry {
  return {
    text:
      result.structuredOutput !== undefined
        ? JSON.stringify(result.structuredOutput)
        : result.output,
    ...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
    agent: result.agent,
    stepIndex,
  };
}
