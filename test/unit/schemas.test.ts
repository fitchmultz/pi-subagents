import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as schemas from "../../src/extension/schemas.ts";
import { Compile as CompileSchema } from "typebox/compile";
import { objectAt as schemaAt } from "./config-workflow-fixtures.ts";

import { isRecord as isSchemaNode, isUnknownArray } from "../../src/shared/unknown.ts";

type JsonSchemaNode = Readonly<Record<string, unknown>>;

function anyOfBranches(schema: JsonSchemaNode): JsonSchemaNode[] {
  const anyOf = schema.anyOf;
  if (!isUnknownArray(anyOf)) {
    return [];
  }
  return anyOf.filter(isSchemaNode);
}

function hasAnyOfType(schema: JsonSchemaNode, type: string): boolean {
  return anyOfBranches(schema).some((branch) => branch.type === type);
}

function hasAnyOfArrayWithStringItems(schema: JsonSchemaNode): boolean {
  return anyOfBranches(schema).some((branch) => {
    if (branch.type !== "array") {
      return false;
    }
    const items = branch.items;
    return isSchemaNode(items) && items.type === "string";
  });
}

function isUntypedRequiredSchema(value: unknown): boolean {
  if (!isSchemaNode(value)) {
    return false;
  }
  return Object.hasOwn(value, "required") && value.type !== "object";
}

const { SubagentParams } = schemas;

function descriptionOf(schema: JsonSchemaNode): string {
  assert.ok(typeof schema.description === "string");
  return schema.description;
}

function* schemaNodes(): Generator<{ readonly path: string; readonly value: JsonSchemaNode }> {
  const stack: Array<{ path: string; value: unknown }> = Object.entries(schemas).map(
    ([name, value]) => ({ path: name, value }),
  );
  while (stack.length > 0) {
    const current = stack.pop();
    assert.ok(current);
    if (isUnknownArray(current.value)) {
      current.value.forEach((value, index) => {
        stack.push({ path: `${current.path}[${index}]`, value });
      });
    } else if (isSchemaNode(current.value)) {
      yield { path: current.path, value: current.value };
      for (const [key, value] of Object.entries(current.value)) {
        stack.push({ path: `${current.path}.${key}`, value });
      }
    }
  }
}

describe("SubagentParams schema", () => {
  it("includes context field for fresh/fork execution mode", () => {
    const contextSchema = schemaAt(SubagentParams, "properties", "context");
    assert.notEqual(contextSchema, undefined, "context schema should exist");
    assert.equal(contextSchema.type, "string");
    assert.deepEqual(contextSchema.enum, ["fresh", "fork"]);
    const description = descriptionOf(contextSchema);
    assert.match(description, /fresh/);
    assert.match(description, /fork/);
    assert.match(description, /defaultContext/);
  });

  it("includes count and concurrency on top-level parallel mode", () => {
    const taskSchema = schemaAt(SubagentParams, "properties", "tasks", "items", "properties");
    const taskCountSchema = schemaAt(taskSchema, "count");
    assert.notEqual(taskCountSchema, undefined, "tasks[].count schema should exist");
    assert.equal(taskCountSchema.minimum, 1);
    assert.match(descriptionOf(taskCountSchema), /repeat/i);
    const outputSchema = schemaAt(taskSchema, "output");
    assert.equal(outputSchema.type, undefined);
    assert.equal(hasAnyOfType(outputSchema, "string"), true);
    assert.equal(hasAnyOfType(outputSchema, "boolean"), true);
    const readsSchema = schemaAt(taskSchema, "reads");
    assert.equal(readsSchema.type, undefined);
    assert.equal(hasAnyOfArrayWithStringItems(readsSchema), true);
    assert.equal(hasAnyOfType(readsSchema, "boolean"), true);
    assert.equal(schemaAt(taskSchema, "progress").type, "boolean");

    const concurrencySchema = schemaAt(SubagentParams, "properties", "concurrency");
    assert.notEqual(concurrencySchema, undefined, "concurrency schema should exist");
    assert.equal(concurrencySchema.minimum, 1);
    assert.match(descriptionOf(concurrencySchema), /parallel/i);
  });

  it("includes foreground run timeout aliases", () => {
    const timeoutSchema = schemaAt(SubagentParams, "properties", "timeoutMs");
    assert.notEqual(timeoutSchema, undefined, "timeoutMs schema should exist");
    assert.equal(timeoutSchema.minimum, 1);
    assert.match(descriptionOf(timeoutSchema), /foreground/i);
    assert.match(descriptionOf(timeoutSchema), /soft-interrupted/i);
    assert.match(descriptionOf(timeoutSchema), /async is omitted.*foreground/i);
    assert.match(descriptionOf(timeoutSchema), /explicit async.*reject/i);
    assert.match(descriptionOf(timeoutSchema), /reviewer/i);
    assert.match(descriptionOf(timeoutSchema), /planner\/researcher/i);
    assert.match(descriptionOf(timeoutSchema), /run-history/i);

    const maxRuntimeSchema = schemaAt(SubagentParams, "properties", "maxRuntimeMs");
    assert.notEqual(maxRuntimeSchema, undefined, "maxRuntimeMs schema should exist");
    assert.equal(maxRuntimeSchema.minimum, 1);
    assert.match(descriptionOf(maxRuntimeSchema), /alias/i);
  });

  it("includes top-level progress for single runs", () => {
    assert.equal(schemaAt(SubagentParams, "properties", "progress").type, "boolean");
  });

  it("includes final output truncation limits", () => {
    const maxOutputSchema = schemaAt(SubagentParams, "properties", "maxOutput");
    assert.notEqual(maxOutputSchema, undefined, "maxOutput schema should exist");
    assert.equal(maxOutputSchema.type, "object");
    assert.equal(maxOutputSchema.additionalProperties, false);
    assert.equal(schemaAt(maxOutputSchema, "properties", "bytes").minimum, 1);
    assert.equal(schemaAt(maxOutputSchema, "properties", "lines").minimum, 1);
    assert.match(descriptionOf(maxOutputSchema), /truncation/i);
    assert.match(descriptionOf(schemaAt(maxOutputSchema, "properties", "bytes")), /bytes/i);
    assert.match(descriptionOf(schemaAt(maxOutputSchema, "properties", "lines")), /lines/i);
  });

  it("uses an enum for management and control actions", () => {
    const actionSchema = schemaAt(SubagentParams, "properties", "action");
    assert.notEqual(actionSchema, undefined, "action schema should exist");
    assert.equal(actionSchema.type, "string");
    assert.deepEqual(actionSchema.enum, [
      "list",
      "get",
      "create",
      "update",
      "delete",
      "status",
      "history",
      "search",
      "interrupt",
      "extend",
      "resume",
      "nudge",
      "questions",
      "answer",
      "review",
      "doctor",
    ]);
    const description = descriptionOf(actionSchema);
    assert.match(description, /Management\/control action/);
    assert.match(description, /Omit for execution mode/);
    assert.doesNotMatch(description, /orchestration\./);
  });

  it("includes subagent control fields", () => {
    const idSchema = schemaAt(SubagentParams, "properties", "id");
    assert.notEqual(idSchema, undefined, "id schema should exist");
    assert.equal(idSchema.type, "string");
    assert.match(descriptionOf(idSchema), /status/i);
    assert.match(descriptionOf(idSchema), /interrupt/i);

    const runIdSchema = schemaAt(SubagentParams, "properties", "runId");
    assert.notEqual(runIdSchema, undefined, "runId schema should exist");
    assert.equal(runIdSchema.type, "string");
    assert.match(descriptionOf(runIdSchema), /interrupt/i);

    const dirSchema = schemaAt(SubagentParams, "properties", "dir");
    assert.notEqual(dirSchema, undefined, "dir schema should exist");
    assert.equal(dirSchema.type, "string");
    assert.match(descriptionOf(dirSchema), /status/i);

    const controlSchema = schemaAt(SubagentParams, "properties", "control");
    assert.notEqual(controlSchema, undefined, "control schema should exist");
    assert.equal(schemaAt(controlSchema, "properties", "needsAttentionAfterMs").minimum, 1);
    assert.equal(
      schemaAt(controlSchema, "properties", "failedToolAttemptsBeforeAttention").minimum,
      1,
    );
    assert.deepEqual(schemaAt(controlSchema, "properties", "notifyOn", "items").enum, [
      "needs_attention",
    ]);
    assert.deepEqual(schemaAt(controlSchema, "properties", "notifyChannels", "items").enum, [
      "event",
      "async",
      "intercom",
    ]);
  });

  it("does not emit description-only schema nodes", () => {
    const descriptionOnlyPaths: string[] = [];
    for (const { path: nodePath, value: node } of schemaNodes()) {
      if (
        Object.hasOwn(node, "description") &&
        !Object.hasOwn(node, "type") &&
        !Object.hasOwn(node, "anyOf")
      ) {
        descriptionOnlyPaths.push(nodePath);
      }
    }
    assert.deepEqual(descriptionOnlyPaths, []);
  });

  it("does not emit array-typed schema nodes without items", () => {
    const missingItemsPaths: string[] = [];
    for (const { path: nodePath, value: node } of schemaNodes()) {
      if (node.type === "array" && !Object.hasOwn(node, "items")) {
        missingItemsPaths.push(nodePath);
      }
    }
    assert.deepEqual(missingItemsPaths, []);
  });

  it("uses provider-compatible composed object schemas", () => {
    const untypedRequiredPaths: string[] = [];
    const repeatedNotPaths: string[] = [];
    for (const { path: nodePath, value: node } of schemaNodes()) {
      if (isUntypedRequiredSchema(node)) {
        untypedRequiredPaths.push(nodePath);
      }
      const allOf = node.allOf;
      if (
        isUnknownArray(allOf) &&
        allOf.filter((entry) => isSchemaNode(entry) && Object.hasOwn(entry, "not")).length > 1
      ) {
        repeatedNotPaths.push(`${nodePath}.allOf`);
      }
    }
    assert.deepEqual(untypedRequiredPaths, []);
    assert.deepEqual(repeatedNotPaths, []);
  });

  it("does not emit provider-rejected union schema shapes", () => {
    const rejectedPaths: string[] = [];
    for (const { path: nodePath, value: node } of schemaNodes()) {
      if (Array.isArray(node.type)) {
        rejectedPaths.push(`${nodePath}.type`);
      }
      if (Object.hasOwn(node, "anyOf") && Object.hasOwn(node, "type")) {
        rejectedPaths.push(`${nodePath}.type+anyOf`);
      }
    }
    assert.deepEqual(rejectedPaths, []);
  });

  it("uses provider-friendly anyOf unions for flexible fields and chain items", () => {
    const skillSchema = schemaAt(SubagentParams, "properties", "skill");
    assert.notEqual(skillSchema, undefined, "skill schema should exist");
    assert.equal(skillSchema.type, undefined);
    assert.equal(hasAnyOfArrayWithStringItems(skillSchema), true);
    assert.equal(hasAnyOfType(skillSchema, "boolean"), true);
    assert.equal(hasAnyOfType(skillSchema, "string"), true);

    const outputSchema = schemaAt(SubagentParams, "properties", "output");
    assert.notEqual(outputSchema, undefined, "output schema should exist");
    assert.equal(outputSchema.type, undefined);
    assert.equal(hasAnyOfType(outputSchema, "string"), true);
    assert.equal(hasAnyOfType(outputSchema, "boolean"), true);

    const configSchema = schemaAt(SubagentParams, "properties", "config");
    assert.notEqual(configSchema, undefined, "config schema should exist");
    assert.equal(configSchema.type, undefined);
    assert.equal(
      anyOfBranches(configSchema).some(
        (branch) => branch.type === "object" && branch.additionalProperties === true,
      ),
      true,
    );
    assert.equal(hasAnyOfType(configSchema, "string"), true);
    assert.match(descriptionOf(configSchema), /skills\?/);
    assert.doesNotMatch(descriptionOf(configSchema), /skill\?/);

    const chainItem = schemaAt(SubagentParams, "properties", "chain", "items");
    assert.notEqual(chainItem, undefined, "chain item schema should exist");
    assert.equal(chainItem.type, "object");
    assert.equal(chainItem.anyOf, undefined);
    assert.equal(chainItem.oneOf, undefined);
    assert.equal(schemaAt(chainItem, "properties", "agent").type, "string");
    assert.equal(schemaAt(chainItem, "properties", "phase").type, "string");
    assert.equal(schemaAt(chainItem, "properties", "label").type, "string");
    assert.equal(schemaAt(chainItem, "properties", "as").type, "string");
    assert.equal(schemaAt(chainItem, "properties", "outputSchema").type, "object");
    assert.equal(schemaAt(chainItem, "properties", "parallel").type, undefined);
    const parallelBranches = anyOfBranches(schemaAt(chainItem, "properties", "parallel"));
    const staticParallelBranch = parallelBranches.find((branch) => branch.type === "array");
    const dynamicParallelBranch = parallelBranches.find((branch) => branch.type === "object");
    assert.ok(staticParallelBranch, "parallel should support static task arrays");
    assert.ok(dynamicParallelBranch, "parallel should support a dynamic task template object");
    const chainParallelTask = schemaAt(staticParallelBranch, "items", "properties");
    assert.equal(schemaAt(chainParallelTask, "agent").type, "string");
    assert.equal(schemaAt(chainParallelTask, "phase").type, "string");
    assert.equal(schemaAt(chainParallelTask, "label").type, "string");
    assert.equal(schemaAt(chainParallelTask, "as").type, "string");
    assert.equal(schemaAt(chainParallelTask, "outputSchema").type, "object");
    const chainParallelOutputSchema = schemaAt(chainParallelTask, "output");
    assert.equal(chainParallelOutputSchema.type, undefined);
    assert.equal(hasAnyOfType(chainParallelOutputSchema, "string"), true);
    assert.equal(hasAnyOfType(chainParallelOutputSchema, "boolean"), true);
    const chainParallelReadsSchema = schemaAt(chainParallelTask, "reads");
    assert.equal(chainParallelReadsSchema.type, undefined);
    assert.equal(hasAnyOfArrayWithStringItems(chainParallelReadsSchema), true);
    assert.equal(hasAnyOfType(chainParallelReadsSchema, "boolean"), true);
    assert.equal(schemaAt(chainItem, "properties", "expand").type, "object");
    assert.equal(schemaAt(chainItem, "properties", "collect").type, "object");
    const chainParallelSkillSchema = schemaAt(chainParallelTask, "skill");
    assert.equal(chainParallelSkillSchema.type, undefined);
    assert.equal(hasAnyOfArrayWithStringItems(chainParallelSkillSchema), true);
    assert.equal(hasAnyOfType(chainParallelSkillSchema, "boolean"), true);
    assert.equal(hasAnyOfType(chainParallelSkillSchema, "string"), true);
    const chainOutputSchema = schemaAt(chainItem, "properties", "output");
    assert.equal(chainOutputSchema.type, undefined);
    assert.equal(hasAnyOfType(chainOutputSchema, "string"), true);
    assert.equal(hasAnyOfType(chainOutputSchema, "boolean"), true);
    const chainReadsSchema = schemaAt(chainItem, "properties", "reads");
    assert.equal(chainReadsSchema.type, undefined);
    assert.equal(hasAnyOfArrayWithStringItems(chainReadsSchema), true);
    assert.equal(hasAnyOfType(chainReadsSchema, "boolean"), true);
  });

  it("aligns parent review, paging, and explicit continuation overrides in local compact and legacy validation", () => {
    const compact = CompileSchema(schemas.AgentRunsValidationParams);
    const legacy = CompileSchema(schemas.SubagentParams);
    for (const schema of [compact, legacy]) {
      assert.equal(schema.Check({ action: "review", id: "run", decision: "accepted" }), true);
      assert.equal(
        schema.Check({
          action: "review",
          id: "run",
          decision: "needs_changes",
          message: "Edge case remains",
        }),
        true,
      );
      assert.equal(schema.Check({ action: "review", id: "run" }), false);
      assert.equal(schema.Check({ action: "review", decision: "accepted" }), false);
    }
    assert.equal(compact.Check({ action: "list", offset: 20, limit: 20 }), true);
    assert.equal(legacy.Check({ action: "status", offset: 20, limit: 20 }), true);
    assert.equal(compact.Check({ action: "list", limit: 0 }), false);
    assert.equal(
      legacy.Check({ action: "review", id: "run", decision: "accepted", limit: 20 }),
      false,
    );
    assert.equal(
      compact.Check({
        action: "continue",
        id: "run",
        message: "Continue",
        model: "openai/gpt-6-astra:high",
        cwd: "/repo",
      }),
      true,
    );
    assert.equal(
      legacy.Check({
        action: "resume",
        id: "run",
        message: "Continue",
        model: "openai/gpt-6-astra:high",
        output: false,
      }),
      true,
    );
  });

  it("rejects public wait actions while retaining explicit foreground continuation and answers", () => {
    for (const [name, continuation] of [
      ["AgentRunsParams", "continue"],
      ["SubagentParams", "resume"],
    ]) {
      const validator = CompileSchema(schemaAt(schemas, name));
      assert.equal(
        validator.Check({ action: "wait", id: "run" }),
        false,
        `${name} must reject wait`,
      );
      assert.equal(validator.Check({ action: "wait", id: "run", index: 0 }), false);
      assert.equal(
        validator.Check({ action: continuation, id: "run", message: "Continue", async: false }),
        true,
      );
      assert.equal(
        validator.Check({
          action: "answer",
          id: "run",
          questionId: "question",
          message: "Proceed",
          async: false,
        }),
        true,
      );
    }
  });

  it("validates representative flexible field values with TypeBox compiler", () => {
    assert.notEqual(SubagentParams, undefined, "SubagentParams schema should exist");
    assert.notEqual(CompileSchema, undefined, "TypeBox compiler should exist");
    const validator = CompileSchema(SubagentParams);
    const validValues = [
      { agent: "worker", skill: "review" },
      { agent: "worker", skill: false },
      { tasks: [{ agent: "reviewer", task: "check this", reads: false }] },
      { tasks: [{ agent: "reviewer", task: "check this", skill: "review" }] },
      { tasks: [{ agent: "reviewer", task: "check this", skill: false }] },
      {
        tasks: [
          {
            agent: "reviewer",
            task: "check this",
            output: "review.md",
            reads: ["input.md"],
            progress: true,
          },
        ],
      },
      { chain: [{ agent: "reviewer", reads: false }] },
      {
        chain: [
          {
            agent: "reviewer",
            phase: "Review",
            label: "Correctness",
            as: "findings",
            outputSchema: { type: "object" },
          },
        ],
      },
      { chain: [{ agent: "reviewer", skill: "review" }] },
      { chain: [{ agent: "reviewer", skill: false }] },
      { chain: [{ parallel: [{ agent: "reviewer", reads: false, skill: false }] }] },
      {
        chain: [
          {
            parallel: [
              {
                agent: "reviewer",
                phase: "Review",
                label: "Security",
                as: "security",
                outputSchema: { type: "object" },
              },
            ],
          },
        ],
      },
      {
        chain: [
          {
            parallel: [
              { agent: "reviewer", output: "review.md", reads: ["input.md"], skill: "review" },
            ],
          },
        ],
      },
      {
        chain: [
          {
            expand: {
              from: { output: "targets", path: "/items" },
              item: "target",
              key: "/path",
              maxItems: 4,
            },
            parallel: {
              agent: "reviewer",
              task: "Review {target.path}",
              outputSchema: { type: "object" },
            },
            collect: { as: "reviews" },
          },
        ],
      },
      {
        agent: "worker",
        task: "Fix",
        acceptance: {
          criteria: ["Patch the bug"],
          evidence: ["changed-files"],
          maxFinalizationTurns: 2,
        },
      },
      {
        agent: "worker",
        task: "Fix",
        acceptance: { verify: [{ id: "unit", command: "npm test" }] },
      },
      { agent: "worker", task: "Fix", acceptance: {} },
      {
        action: "resume",
        id: "run-123",
        message: "Continue",
        acceptance: { criteria: ["Finish the task"] },
      },
      { config: { name: "reviewer", description: "Review things" } },
      { config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
      { agent: "scout", task: "Summarize", maxOutput: { bytes: 8192 } },
      { agent: "scout", task: "Summarize", maxOutput: { lines: 1000 } },
      { agent: "scout", task: "Summarize", maxOutput: { bytes: 8192, lines: 1000 } },
    ];
    const invalidValues = [
      { skill: 123 },
      { agent: "", task: "work" },
      { agent: "worker", task: "work", extra: true },
      { tasks: [] },
      { agent: "worker", task: "" },
      { agent: "worker", task: "work", worktree: true },
      { chain: [{ agent: "worker", task: "work" }], worktree: true },
      { chain: [{ parallel: [{ agent: "worker", task: "work" }], output: "ignored.md" }] },
      { chain: [{ agent: "worker", task: "work", concurrency: 2 }] },
      {
        chain: [
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
            parallel: { agent: "reviewer" },
            collect: { as: "reviews" },
            worktree: true,
          },
        ],
      },
      { concurrency: 1.5 },
      { agent: "worker", tasks: [{ agent: "reviewer", task: "review" }] },
      { skill: [123] },
      { output: 123 },
      { tasks: [{ agent: "reviewer", task: "check this", reads: "input.md" }] },
      { chain: [{ parallel: [{ agent: "reviewer", output: 123 }] }] },
      { chain: [{ parallel: [{ agent: "reviewer", reads: "input.md" }] }] },
      { chain: [{ parallel: [{ agent: "reviewer", skill: 123 }] }] },
      { chain: [{ agent: "reviewer", outputSchema: "schema.json" }] },
      { chain: [{ parallel: [{ agent: "reviewer", outputSchema: "schema.json" }] }] },
      {
        chain: [
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
            parallel: [{ agent: "reviewer" }],
            collect: { as: "reviews" },
          },
        ],
      },
      {
        chain: [
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
            parallel: { agent: "reviewer" },
          },
        ],
      },
      { chain: [{ parallel: { agent: "reviewer" } }] },
      {
        chain: [
          {
            expand: {
              from: { output: "targets", path: "/items" },
              maxItems: 4,
              expression: "items",
            },
            parallel: { agent: "reviewer" },
            collect: { as: "reviews" },
          },
        ],
      },
      {
        chain: [
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
            parallel: { agent: "reviewer", as: "child" },
            collect: { as: "reviews" },
          },
        ],
      },
      {
        chain: [
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
            parallel: { agent: "reviewer" },
            collect: { as: "reviews" },
            when: "later",
          },
        ],
      },
      { agent: "worker", task: "Fix", acceptance: true },
      { agent: "worker", task: "Fix", acceptance: "checked" },
      { agent: "worker", task: "Fix", acceptance: false },
      { agent: "worker", task: "Fix", acceptance: { level: "checked" } },
      { agent: "worker", task: "Fix", acceptance: { criteria: [""] } },
      { agent: "worker", task: "Fix", acceptance: { criteria: [{ id: "", must: "Patch" }] } },
      { agent: "worker", task: "Fix", acceptance: { verify: [{ id: "unit", command: "" }] } },
      { agent: "worker", task: "Fix", acceptance: { stopRules: [""] } },
      { agent: "worker", task: "Fix", acceptance: { criteria: ["Patch"], review: true } },
      {
        agent: "worker",
        task: "Fix",
        acceptance: { criteria: ["Patch"], review: { agent: "reviewer", required: true } },
      },
      { action: "interrupt", id: "run-123", acceptance: { criteria: ["Ignored"] } },
      { config: [] },
      { config: null },
      { agent: "scout", task: "Summarize", maxOutput: { bytes: 0 } },
      { agent: "scout", task: "Summarize", maxOutput: { lines: 0 } },
      { agent: "scout", task: "Summarize", maxOutput: { bytes: 8192, chars: 2000 } },
    ];

    for (const value of validValues) {
      assert.doesNotThrow(
        () => validator.Check(value),
        `validator should not throw for ${JSON.stringify(value)}`,
      );
      assert.equal(
        validator.Check(value),
        true,
        `${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
      );
    }
    for (const value of invalidValues) {
      assert.equal(validator.Check(value), false, `${JSON.stringify(value)} should not validate`);
    }
  });
});
