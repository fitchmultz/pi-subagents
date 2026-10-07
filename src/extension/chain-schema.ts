import { Type } from "../shared/native-typebox.ts";
import { AcceptanceOverride } from "./acceptance-schema.ts";
import {
  JsonSchemaObject,
  ModelOverride,
  OutputModeOverride,
  OutputOverride,
  ReadsOverride,
  SkillOverride,
  requiredObject,
} from "./schema-overrides.ts";

const ParallelTaskSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    task: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Task template with {task}, {previous}, {chain_dir} variables. Defaults to {previous}.",
      }),
    ),
    phase: Type.Optional(
      Type.String({ description: "Phase/group label for status and graph rendering." }),
    ),
    label: Type.Optional(Type.String({ description: "User-facing label for this parallel task." })),
    as: Type.Optional(
      Type.String({ description: "Safe identifier used as {outputs.name} in later chain steps." }),
    ),
    outputSchema: Type.Optional(JsonSchemaObject),
    cwd: Type.Optional(Type.String()),
    count: Type.Optional(
      Type.Integer({ minimum: 1, description: "Repeat this parallel task N times." }),
    ),
    output: Type.Optional(OutputOverride),
    outputMode: Type.Optional(OutputModeOverride),
    reads: Type.Optional(ReadsOverride),
    progress: Type.Optional(
      Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" }),
    ),
    skill: Type.Optional(SkillOverride),
    model: ModelOverride,
    acceptance: Type.Optional(AcceptanceOverride),
  },
  { additionalProperties: false },
);

const DynamicExpandSchema = Type.Object(
  {
    from: Type.Object(
      {
        output: Type.String({ description: "Prior named structured output to expand from." }),
        path: Type.String({ description: "JSON Pointer into the structured output, e.g. /items." }),
      },
      { additionalProperties: false },
    ),
    item: Type.Optional(
      Type.String({ description: "Template variable name for each item. Defaults to item." }),
    ),
    key: Type.Optional(
      Type.String({ description: "JSON Pointer relative to each item for stable child ids." }),
    ),
    maxItems: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Required fanout bound unless configured globally.",
      }),
    ),
    onEmpty: Type.Optional(
      Type.Enum(["skip", "fail"] as const, {
        type: "string",
        description: "Empty input behavior. Defaults to skip.",
      }),
    ),
  },
  { additionalProperties: false },
);

const DynamicParallelTemplateSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    task: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Task template with {item}, {item.path}, {task}, {previous}, {chain_dir}, {outputs.name} variables.",
      }),
    ),
    phase: Type.Optional(
      Type.String({ description: "Phase/group label for status and graph rendering." }),
    ),
    label: Type.Optional(
      Type.String({ description: "User-facing label; item templates supported." }),
    ),
    outputSchema: Type.Optional(JsonSchemaObject),
    cwd: Type.Optional(Type.String()),
    output: Type.Optional(OutputOverride),
    outputMode: Type.Optional(OutputModeOverride),
    reads: Type.Optional(ReadsOverride),
    progress: Type.Optional(
      Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" }),
    ),
    skill: Type.Optional(SkillOverride),
    model: ModelOverride,
    acceptance: Type.Optional(AcceptanceOverride),
  },
  { additionalProperties: false },
);

const DynamicCollectSchema = Type.Object(
  {
    as: Type.String({ description: "Safe output name for the ordered collected result array." }),
    outputSchema: Type.Optional(JsonSchemaObject),
  },
  { additionalProperties: false },
);

// Flattened so chain steps do not need an object-shape anyOf/oneOf union.
export const ChainItemSchema = Type.Object(
  {
    agent: Type.Optional(Type.String({ minLength: 1, description: "Sequential step agent name" })),
    task: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Task template: {task}=original request, {previous}=prior step response, {chain_dir}=shared folder, {outputs.name}=prior named output. Required for first step; defaults to '{previous}'.",
      }),
    ),
    phase: Type.Optional(
      Type.String({ description: "Phase/group label for status and graph rendering." }),
    ),
    label: Type.Optional(Type.String({ description: "User-facing label for this chain step." })),
    as: Type.Optional(
      Type.String({ description: "Safe identifier used as {outputs.name} in later chain steps." }),
    ),
    outputSchema: Type.Optional(JsonSchemaObject),
    cwd: Type.Optional(Type.String()),
    output: Type.Optional(OutputOverride),
    outputMode: Type.Optional(OutputModeOverride),
    reads: Type.Optional(ReadsOverride),
    progress: Type.Optional(
      Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" }),
    ),
    skill: Type.Optional(SkillOverride),
    model: ModelOverride,
    acceptance: Type.Optional(AcceptanceOverride),
    parallel: Type.Optional(
      Type.Unsafe({
        anyOf: [
          Type.Array(ParallelTaskSchema, { minItems: 1, description: "Tasks to run in parallel" }),
          DynamicParallelTemplateSchema,
        ],
        description:
          "Static parallel tasks array, or a single dynamic fanout child template when expand/collect are present.",
      }),
    ),
    expand: Type.Optional(DynamicExpandSchema),
    collect: Type.Optional(DynamicCollectSchema),
    concurrency: Type.Optional(
      Type.Integer({ minimum: 1, description: "Max concurrent tasks (default: 4)" }),
    ),
    failFast: Type.Optional(
      Type.Boolean({ description: "Stop on first failure (default: false)" }),
    ),
    worktree: Type.Optional(
      Type.Boolean({ description: "Create isolated git worktrees for each parallel task." }),
    ),
  },
  {
    description:
      "Chain step: {agent, task?} sequential, {parallel: [...]} concurrent, or {expand, parallel: {...}, collect} dynamic fanout.",
    additionalProperties: false,
    allOf: [
      { anyOf: [requiredObject("agent"), requiredObject("parallel")] },
      {
        not: {
          anyOf: [
            requiredObject("agent", "parallel"),
            { ...requiredObject("expand"), properties: { parallel: { type: "array", items: {} } } },
          ],
        },
      },
      {
        if: requiredObject("expand"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          ...requiredObject("parallel", "collect"),
          properties: { parallel: { type: "object" } },
        },
      },
      {
        if: requiredObject("collect"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          ...requiredObject("expand", "parallel"),
          properties: { parallel: { type: "object" } },
        },
      },
      {
        if: { ...requiredObject("parallel"), properties: { parallel: { type: "object" } } },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("expand", "collect"),
      },
      {
        if: requiredObject("agent"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          not: {
            anyOf: [
              requiredObject("concurrency"),
              requiredObject("failFast"),
              requiredObject("worktree"),
            ],
          },
        },
      },
      {
        if: {
          ...requiredObject("parallel"),
          properties: { parallel: { type: "array", items: {} } },
        },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          not: {
            anyOf: [
              requiredObject("task"),
              requiredObject("phase"),
              requiredObject("label"),
              requiredObject("as"),
              requiredObject("outputSchema"),
              requiredObject("output"),
              requiredObject("outputMode"),
              requiredObject("reads"),
              requiredObject("progress"),
              requiredObject("skill"),
              requiredObject("model"),
              requiredObject("acceptance"),
              requiredObject("expand"),
              requiredObject("collect"),
            ],
          },
        },
      },
      {
        if: { ...requiredObject("parallel"), properties: { parallel: { type: "object" } } },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: {
          not: {
            anyOf: [
              requiredObject("task"),
              requiredObject("as"),
              requiredObject("outputSchema"),
              requiredObject("cwd"),
              requiredObject("output"),
              requiredObject("outputMode"),
              requiredObject("reads"),
              requiredObject("progress"),
              requiredObject("skill"),
              requiredObject("model"),
              requiredObject("acceptance"),
              requiredObject("worktree"),
            ],
          },
        },
      },
    ],
  },
);
