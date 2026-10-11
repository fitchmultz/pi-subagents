import "../support/isolated-home.ts";
/**
 * Tests for chain template resolution and variable substitution.
 *
 * These test the pure logic of how {task}, {previous}, and {chain_dir}
 * variables get resolved in chain steps.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeSkillInput } from "../../src/agents/skills.ts";
import {
  buildChainInstructions,
  type ResolvedStepBehavior,
  createChainDir,
  resolveChainTemplates,
  resolveParallelBehaviors,
  resolveStepBehavior,
  suppressProgressForReadOnlyTask,
  taskDisallowsFileUpdates,
} from "../../src/shared/settings.ts";
import { createTempDir, removeTempDir, makeAgent } from "../support/helpers.ts";

describe("resolveChainTemplates", () => {
  it("mixed sequential + parallel", () => {
    assert.deepEqual(
      resolveChainTemplates([
        { agent: "scout", task: "Analyze {task}" },
        { parallel: [{ agent: "rev-a", task: "Deep review A" }, { agent: "rev-b" }] },
        { agent: "writer" },
        { agent: "worker" },
        { agent: "b", task: "Custom task for B" },
      ]),
      [
        "Analyze {task}",
        ["Deep review A", "{previous}"],
        "{previous}",
        "{previous}",
        "Custom task for B",
      ],
    );
    assert.deepEqual(
      resolveChainTemplates([
        {
          parallel: [
            { agent: "a", task: "Review auth" },
            { agent: "b", task: "Review data" },
          ],
        },
      ]),
      [["Review auth", "Review data"]],
    );
  });
});

describe("normalizeSkillInput", () => {
  it("returns undefined for omitted or default skill input", () => {
    for (const input of [undefined, true]) {
      assert.equal(normalizeSkillInput(input), undefined);
    }
  });

  it("returns false for false (disable)", () => {
    assert.equal(normalizeSkillInput(false), false);
  });

  it("normalizes skill names from strings and arrays", () => {
    for (const [input, expected] of [
      ["web-search,pdf", ["web-search", "pdf"]],
      [
        ["a", "b"],
        ["a", "b"],
      ],
      [
        ["a", "b", "a"],
        ["a", "b"],
      ],
      [" a , b ", ["a", "b"]],
      [",a,,b,", ["a", "b"]],
    ] as const) {
      assert.deepEqual(normalizeSkillInput(input), expected);
    }
  });
});

describe("resolveStepBehavior", () => {
  it("returns agent defaults when no overrides", () => {
    // Uses agentConfig.output, .defaultReads, .defaultProgress
    const config = {
      ...makeAgent("test", { inheritProjectContext: true, inheritSkills: true }),
      name: "test",
      output: "report.md",
      defaultProgress: true,
      defaultReads: ["input.md"],
    };
    const behavior = resolveStepBehavior(config, {});
    assert.equal(behavior.output, "report.md");
    assert.equal(behavior.progress, true);
    assert.deepEqual(behavior.reads, ["input.md"]);
  });

  it("step overrides take precedence", () => {
    const config = {
      ...makeAgent("test", { inheritProjectContext: true, inheritSkills: true }),
      name: "test",
      output: "report.md",
    };
    const behavior = resolveStepBehavior(config, { output: "custom.md" });
    assert.equal(behavior.output, "custom.md");
  });

  it("defaults outputMode to inline unless a step overrides it", () => {
    const inlineBehavior = resolveStepBehavior(
      {
        ...makeAgent("test", { inheritProjectContext: true, inheritSkills: true }),
        name: "test",
        output: "report.md",
      },
      {},
    );
    assert.equal(inlineBehavior.outputMode, "inline");

    const stepOverrideBehavior = resolveStepBehavior(
      {
        ...makeAgent("test", { inheritProjectContext: true, inheritSkills: true }),
        name: "test",
        output: "report.md",
      },
      { outputMode: "file-only" },
    );
    assert.equal(stepOverrideBehavior.outputMode, "file-only");
  });

  it("false disables output", () => {
    const config = {
      ...makeAgent("test", { inheritProjectContext: true, inheritSkills: true }),
      name: "test",
      output: "report.md",
    };
    for (const output of [false, "false"] as const) {
      assert.equal(resolveStepBehavior(config, { output }).output, false);
    }
  });

  it("defaults to false when agent has no config", () => {
    const config = {
      ...makeAgent("test", { inheritProjectContext: true, inheritSkills: true }),
      name: "test",
    };
    const behavior = resolveStepBehavior(config, {});
    assert.equal(behavior.output, false);
    assert.equal(behavior.reads, false);
    assert.equal(behavior.progress, false);
  });

  it("lets top-level skill: false disable agent and step skills", () => {
    assert.equal(
      resolveStepBehavior(
        {
          ...makeAgent("test", { inheritProjectContext: true, inheritSkills: true }),
          name: "test",
          skills: ["agent-skill"],
        },
        {},
        false,
      ).skills,
      false,
    );
    assert.equal(
      resolveStepBehavior(
        {
          ...makeAgent("test", { inheritProjectContext: true, inheritSkills: true }),
          name: "test",
        },
        { skills: ["step-skill"] },
        false,
      ).skills,
      false,
    );
  });
});

describe("resolveParallelBehaviors", () => {
  it("string false agent default disables output in chain parallel tasks", () => {
    const behaviors = resolveParallelBehaviors(
      [{ agent: "reviewer", task: "Review" }],
      [
        {
          ...makeAgent("reviewer", { inheritProjectContext: true, inheritSkills: true }),
          name: "reviewer",
          output: "false",
        },
      ],
      0,
    );

    assert.equal(behaviors[0]?.output, false);
  });
});

describe("read-only progress suppression", () => {
  it("suppresses progress for review-only or no-edit tasks", () => {
    const behavior: ResolvedStepBehavior = {
      reads: false,
      output: false,
      outputMode: "inline",
      progress: true,
      skills: false,
    };

    assert.equal(taskDisallowsFileUpdates("Review-only. Do not edit files."), true);
    assert.equal(taskDisallowsFileUpdates("Implement read-only mode for config files."), false);
    assert.equal(taskDisallowsFileUpdates("This task is not read-only; edit files."), false);
    assert.equal(
      suppressProgressForReadOnlyTask(behavior, "Review-only. Do not edit files.").progress,
      false,
    );
    assert.equal(
      suppressProgressForReadOnlyTask(behavior, "{task}", "Review-only. Do not edit files.")
        .progress,
      false,
    );
    assert.equal(
      suppressProgressForReadOnlyTask(behavior, "Implement the approved fix.").progress,
      true,
    );
  });
});

describe("buildChainInstructions", () => {
  it("adds progress instructions in suffix for first progress step", () => {
    const behavior: ResolvedStepBehavior = {
      reads: false,
      output: false,
      outputMode: "inline",
      progress: true,
      skills: false,
    };
    const dir = createTempDir("chain-test-");
    try {
      const { suffix } = buildChainInstructions(behavior, dir, true);
      assert.ok(suffix.includes("progress.md"), `should reference progress.md: ${suffix}`);
      assert.equal(
        suffix,
        `\n\n---\nCreate and maintain progress at: ${path.join(dir, "progress.md")}`,
      );
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("createChainDir", () => {
  it("creates directory with runId", () => {
    const dir = createChainDir("test-run-123");
    try {
      assert.ok(fs.existsSync(dir));
      assert.ok(dir.includes("test-run-123"));
    } finally {
      removeTempDir(dir);
    }
  });
});
