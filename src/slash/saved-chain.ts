import * as fs from "node:fs";
import * as path from "node:path";
import type { ChainConfig, JsonSchemaObject } from "../shared/types/config.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import { assertJsonSchemaObject } from "../runs/shared/structured-output.ts";
import {
  normalizeSubagentParamsLike,
  type SubagentParamsLike,
} from "../runs/foreground/subagent-executor.ts";

type RuntimeStep = NonNullable<SubagentParamsLike["chain"]>[number];

function loadOutputSchema(
  chain: ReadonlyInput<ChainConfig>,
  agent: string,
  value: unknown,
): JsonSchemaObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const file = path.isAbsolute(value) ? value : path.join(path.dirname(chain.filePath), value);
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    assertJsonSchemaObject(
      parsed,
      `outputSchema for chain '${chain.name}' step '${agent}' (${file})`,
    );
    return parsed;
  }
  assertJsonSchemaObject(value, `outputSchema for chain '${chain.name}' step '${agent}'`);
  return value;
}

function taskWithSchema(
  chain: ReadonlyInput<ChainConfig>,
  task: unknown,
): Readonly<Record<string, unknown>> {
  if (!isRecord(task) || typeof task.agent !== "string") {
    throw new Error(`Chain '${chain.name}' contains a task without an agent.`);
  }
  const { outputSchema: raw, ...rest } = task;
  const outputSchema = loadOutputSchema(chain, task.agent, raw);
  return { ...rest, ...(outputSchema !== undefined ? { outputSchema } : {}) };
}

function dynamicStep(
  chain: ReadonlyInput<ChainConfig>,
  step: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isRecord(step.collect) || typeof step.collect.as !== "string") {
    throw new Error(`Chain '${chain.name}' dynamic collection requires an output name.`);
  }
  const schema = loadOutputSchema(
    chain,
    `${step.collect.as} collection`,
    step.collect.outputSchema,
  );
  return {
    ...step,
    parallel: taskWithSchema(chain, step.parallel),
    collect: { ...step.collect, ...(schema !== undefined ? { outputSchema: schema } : {}) },
  };
}

function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function sequentialStep(
  chain: ReadonlyInput<ChainConfig>,
  step: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof step.agent !== "string") {
    throw new Error(`Chain '${chain.name}' contains a step without an agent.`);
  }
  const outputSchema = loadOutputSchema(chain, step.agent, step.outputSchema);
  const named: Record<string, unknown> = {};
  for (const key of ["task", "phase", "label", "as"] as const) {
    if (nonempty(step[key])) {
      named[key] = step[key];
    }
  }
  return {
    agent: step.agent,
    ...named,
    ...(step.cwd !== undefined ? { cwd: step.cwd } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    output: step.output,
    outputMode: step.outputMode,
    reads: step.reads,
    progress: step.progress,
    skill: step.skill ?? step.skills,
    model: step.model,
    ...(step.acceptance !== undefined ? { acceptance: step.acceptance } : {}),
  };
}

function resolveStep(
  chain: ReadonlyInput<ChainConfig>,
  step: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (isUnknownArray(step.parallel)) {
    return { ...step, parallel: step.parallel.map((task) => taskWithSchema(chain, task)) };
  }
  return "expand" in step && "collect" in step && "parallel" in step
    ? dynamicStep(chain, step)
    : sequentialStep(chain, step);
}

/** Resolve file schemas before the executor's canonical argument decoder owns the runtime shape. */
export function mapSavedChainSteps(chain: ReadonlyInput<ChainConfig>): RuntimeStep[] {
  const steps = chain.steps.map((step) => resolveStep(chain, { ...step }));
  return [...(normalizeSubagentParamsLike({ chain: steps }).chain ?? [])];
}
