import { isRecord } from "./async-value.ts";

function invalid(source: string, message: string): never {
  throw new Error(`Invalid async status '${source}': ${message}.`);
}

function optionalFields(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  source: string,
  kind: "string" | "number",
): void {
  for (const field of fields) {
    const value = record[field];
    if (value === undefined) {
      continue;
    }
    const valid =
      kind === "string"
        ? typeof value === "string"
        : typeof value === "number" && Number.isFinite(value);
    if (!valid) {
      invalid(source, `${field} must be ${kind === "string" ? "a string" : "a finite number"}`);
    }
  }
}

function tokenUsage(value: unknown, field: string, source: string): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    invalid(source, `${field} must be an object`);
  }
  if (
    ![value.input, value.output, value.total].every(
      (part) => typeof part === "number" && Number.isFinite(part),
    )
  ) {
    invalid(source, `${field} must contain finite input, output, and total numbers`);
  }
}

function validRecentTool(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.tool === "string" &&
    typeof value.args === "string" &&
    typeof value.endMs === "number" &&
    Number.isFinite(value.endMs)
  );
}

function validateStepCollections(
  step: Readonly<Record<string, unknown>>,
  index: number,
  source: string,
): void {
  for (const field of ["recentOutput", "skills", "attemptedModels"]) {
    const items: unknown = step[field];
    if (
      items !== undefined &&
      (!Array.isArray(items) || !items.every((item: unknown) => typeof item === "string"))
    ) {
      invalid(source, `steps[${index}].${field} must be an array of strings`);
    }
  }
  if (
    step.recentTools !== undefined &&
    (!Array.isArray(step.recentTools) || !step.recentTools.every(validRecentTool))
  ) {
    invalid(source, `steps[${index}].recentTools is invalid`);
  }
  if (step.children !== undefined && !Array.isArray(step.children)) {
    invalid(source, `steps[${index}].children must be an array`);
  }
  tokenUsage(step.tokens, `steps[${index}].tokens`, source);
}

function validateStep(value: unknown, index: number, source: string): void {
  if (!isRecord(value)) {
    invalid(source, `steps[${index}] must be an object`);
  }
  const stepSource = `${source} (steps[${index}])`;
  optionalFields(
    value,
    [
      "agent",
      "phase",
      "label",
      "outputName",
      "sessionFile",
      "currentTool",
      "currentToolArgs",
      "currentPath",
      "model",
      "thinking",
      "error",
    ],
    stepSource,
    "string",
  );
  optionalFields(
    value,
    [
      "lastActivityAt",
      "currentToolStartedAt",
      "turnCount",
      "toolCount",
      "startedAt",
      "endedAt",
      "durationMs",
    ],
    stepSource,
    "number",
  );
  if (typeof value.agent !== "string") {
    invalid(source, `steps[${index}].agent must be a string`);
  }
  const states: readonly unknown[] = [
    "pending",
    "running",
    "complete",
    "completed",
    "failed",
    "blocked",
    "paused",
    "timed-out",
  ];
  if (!states.includes(value.status)) {
    invalid(source, `steps[${index}].status is invalid`);
  }
  if (value.activityState !== undefined && value.activityState !== "needs_attention") {
    invalid(source, `steps[${index}].activityState is invalid`);
  }
  if (value.structured !== undefined && typeof value.structured !== "boolean") {
    invalid(source, `steps[${index}].structured must be a boolean`);
  }
  validateStepCollections(value, index, source);
}

function validateProgress(
  record: Readonly<Record<string, unknown>>,
  steps: readonly unknown[],
  source: string,
): void {
  const current = record.currentStep;
  if (
    current !== undefined &&
    (typeof current !== "number" ||
      !Number.isSafeInteger(current) ||
      current < 0 ||
      current >= steps.length)
  ) {
    invalid(source, "currentStep must index a persisted step");
  }
  const count = record.chainStepCount;
  if (
    count !== undefined &&
    (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)
  ) {
    invalid(source, "chainStepCount must be a positive safe integer");
  }
}

/** Validate persisted shape before projecting display state, including optional legacy fields. */
function statusSteps(value: Readonly<Record<string, unknown>>, source: string): readonly unknown[] {
  if (value.steps !== undefined && !Array.isArray(value.steps)) {
    invalid(source, "steps must be an array");
  }
  return Array.isArray(value.steps) ? value.steps : [];
}

export function validateStatusForSummary(value: unknown, source: string): void {
  if (!isRecord(value)) {
    invalid(source, "status must be an object");
  }
  optionalFields(
    value,
    [
      "runId",
      "sessionId",
      "currentTool",
      "currentPath",
      "cwd",
      "sessionDir",
      "outputFile",
      "sessionFile",
    ],
    source,
    "string",
  );
  optionalFields(
    value,
    [
      "lastActivityAt",
      "currentToolStartedAt",
      "turnCount",
      "toolCount",
      "startedAt",
      "endedAt",
      "lastUpdate",
      "pid",
      "currentStep",
      "chainStepCount",
    ],
    source,
    "number",
  );
  if (typeof value.runId !== "string") {
    invalid(source, "runId must be a string");
  }
  if (typeof value.startedAt !== "number") {
    invalid(source, "startedAt must be a number");
  }
  const modes: readonly unknown[] = ["single", "parallel", "chain"];
  const states: readonly unknown[] = [
    "queued",
    "running",
    "complete",
    "failed",
    "blocked",
    "paused",
  ];
  if (!modes.includes(value.mode)) {
    invalid(source, "mode is invalid");
  }
  if (!states.includes(value.state)) {
    invalid(source, "state is invalid");
  }
  if (value.activityState !== undefined && value.activityState !== "needs_attention") {
    invalid(source, "activityState is invalid");
  }
  tokenUsage(value.totalTokens, "totalTokens", source);
  const steps = statusSteps(value, source);
  validateProgress(value, steps, source);
  steps.forEach((step, index) => validateStep(step, index, source));
}
