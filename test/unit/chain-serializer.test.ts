import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { objectAt } from "./config-workflow-fixtures.ts";
import { parseChain, parseJsonChain, serializeChain } from "../../src/agents/chain-serializer.ts";

describe("chain serializer", () => {
  it("rejects invalid or ambiguous encoded tasks", () => {
    for (const [body, error] of [
      ["task-json: 123", /must be a JSON string/],
      ['task-json: "unterminated', SyntaxError],
      ['task-json: "one"\ntask-json: "two"', /Duplicate task-json/],
      ['task-json: "one"\n\nAnother task', /cannot combine task-json with task prose/],
    ] as const) {
      assert.throws(
        () =>
          parseChain(
            `---\nname: invalid\ndescription: Invalid\n---\n\n## worker\n${body}\n`,
            "project",
            "/tmp/invalid.chain.md",
          ),
        error,
      );
    }
  });

  it("round-trips phase, label, as, and path-based outputSchema", () => {
    const parsed = parseChain(
      `---
name: review-chain
description: Review chain
---

## reviewer
output: report.md
outputMode: file-only
phase: Review
label: correctness pass
as: correctnessFindings
outputSchema: ./schemas/finding.schema.json

Review the diff
`,
      "project",
      "/tmp/review-chain.md",
    );

    assert.equal(parsed.steps[0]?.outputMode, "file-only");
    assert.equal(parsed.steps[0]?.phase, "Review");
    assert.equal(parsed.steps[0]?.label, "correctness pass");
    assert.equal(parsed.steps[0]?.as, "correctnessFindings");
    assert.equal(parsed.steps[0]?.outputSchema, "./schemas/finding.schema.json");
    const serialized = serializeChain(parsed);
    assert.match(serialized, /outputMode: file-only/);
    assert.match(serialized, /phase: Review/);
    assert.match(serialized, /label: correctness pass/);
    assert.match(serialized, /as: correctnessFindings/);
    assert.match(serialized, /outputSchema: \.\/schemas\/finding\.schema\.json/);
  });

  it("rejects inline outputSchema values in markdown chains", () => {
    assert.throws(
      () =>
        parseChain(
          `---
name: review-chain
description: Review chain
---

## reviewer
outputSchema: {"type":"object"}

Review the diff
`,
          "project",
          "/tmp/review-chain.md",
        ),
      /Inline outputSchema values are not supported/,
    );
  });

  it("rejects invalid dynamic JSON chains with useful diagnostics", () => {
    assert.throws(
      () =>
        parseJsonChain(
          JSON.stringify({
            name: "bad-dynamic-review",
            description: "Bad dynamic targets",
            chain: [
              {
                agent: "scout",
                task: "Return targets",
                as: "targets",
                outputSchema: { type: "object" },
              },
              {
                expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
                parallel: [{ agent: "reviewer", task: "Review" }],
                collect: { as: "reviews" },
              },
            ],
          }),
          "project",
          "/tmp/bad-dynamic-review.chain.json",
        ),
      /static parallel arrays/,
    );
    assert.throws(
      () =>
        parseJsonChain(
          JSON.stringify({ name: "bad", description: "Bad", chain: [1] }),
          "project",
          "/tmp/bad.chain.json",
        ),
      /step 1 must be an object/,
    );
  });

  it("rejects invalid JSON chain field types", () => {
    const parse = (failFast: unknown) =>
      parseJsonChain(
        JSON.stringify({
          name: "bad-types",
          description: "Bad types",
          chain: [{ parallel: [{ agent: "worker" }], failFast }],
        }),
        "project",
        "/tmp/bad-types.chain.json",
      );
    assert.equal(parse(false).steps[0]?.failFast, false);
    assert.throws(() => parse("false"), /must be boolean/);
  });
  it("keeps colon-prefixed prose in hand-written markdown step tasks", () => {
    const parsed = parseChain(
      `---
name: prose-chain
description: Prose chain
---

## worker
Goal: ship it
http://example.test/context

Continue here
`,
      "project",
      "/tmp/prose.chain.md",
    );
    assert.equal(
      parsed.steps[0]?.task,
      "Goal: ship it\nhttp://example.test/context\nContinue here",
    );
  });

  it("parses and validates acceptance in JSON chains", () => {
    const parsed = parseJsonChain(
      JSON.stringify({
        name: "accepted-chain",
        description: "Chain with acceptance gates",
        chain: [
          {
            agent: "worker",
            task: "Fix bug",
            acceptance: { criteria: ["Patch bug"], evidence: ["changed-files", "commands-run"] },
          },
          {
            parallel: [
              {
                agent: "reviewer",
                task: "Review",
                acceptance: { criteria: ["Return concrete findings"] },
              },
            ],
          },
        ],
      }),
      "project",
      "/tmp/accepted-chain.chain.json",
    );

    assert.deepEqual((parsed.steps[0] as { acceptance?: unknown }).acceptance, {
      criteria: ["Patch bug"],
      evidence: ["changed-files", "commands-run"],
    });
    assert.deepEqual(objectAt(parsed.steps[1], "parallel", 0).acceptance, {
      criteria: ["Return concrete findings"],
    });
    assert.throws(
      () =>
        parseJsonChain(
          JSON.stringify({
            name: "bad-acceptance",
            description: "Bad acceptance",
            chain: [{ agent: "worker", acceptance: { level: "none" } }],
          }),
          "project",
          "/tmp/bad-acceptance.chain.json",
        ),
      /step 1 acceptance\.level is no longer supported/,
    );
    assert.throws(
      () =>
        parseJsonChain(
          JSON.stringify({
            name: "bad-criterion",
            description: "Bad criterion",
            chain: [{ agent: "worker", acceptance: { criteria: [{ must: "Patch" }] } }],
          }),
          "project",
          "/tmp/bad-criterion.chain.json",
        ),
      /step 1 acceptance\.criteria\[0\]\.id is required/,
    );
    assert.throws(
      () =>
        parseJsonChain(
          JSON.stringify({
            name: "bad-key",
            description: "Bad key",
            chain: [
              { agent: "worker", acceptance: { criteria: ["Patch"], maxFinalizationTurn: 2 } },
            ],
          }),
          "project",
          "/tmp/bad-key.chain.json",
        ),
      /step 1 acceptance\.maxFinalizationTurn is not supported/,
    );
    assert.throws(
      () =>
        parseJsonChain(
          JSON.stringify({
            name: "group-acceptance",
            description: "Group acceptance",
            chain: [{ parallel: [{ agent: "worker" }], acceptance: { criteria: ["Group done"] } }],
          }),
          "project",
          "/tmp/group-acceptance.chain.json",
        ),
      /static parallel groups/,
    );
    assert.throws(
      () =>
        parseJsonChain(
          JSON.stringify({
            name: "dynamic-group-acceptance",
            description: "Dynamic group acceptance",
            chain: [
              {
                expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
                parallel: { agent: "worker" },
                collect: { as: "done" },
                acceptance: { criteria: ["Group done"] },
              },
            ],
          }),
          "project",
          "/tmp/dynamic-group-acceptance.chain.json",
        ),
      /dynamic fanout groups/,
    );
  });
});
