import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeExtensionContext } from "../support/sdk-context.ts";
import {
  handleCreate,
  handleManagementAction,
  handleUpdate,
} from "../../src/agents/agent-management.ts";
import { objectAt } from "./config-workflow-fixtures.ts";
import { json as parseJsonObject, textAt } from "../support/assertions.ts";
import { discoverAgentsAll } from "../../src/agents/agents.ts";

let tempDir = "";

function readText(result: { readonly content: unknown }): string {
  return textAt(result.content);
}

describe("agent management config parsing", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists effective model, effort and ordered fallbacks without inventing unset defaults", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    for (const config of [
      {
        name: "explicit-defaults",
        model: "example/primary",
        thinking: "medium",
        fallbackModels: ["example/backup:high", "other/last"],
      },
      {
        name: "suffix-defaults",
        model: "example/primary:high",
        thinking: "medium",
        fallbackModels: ["example/backup"],
      },
      {
        name: "suffix-inherited-fallback",
        model: "example/primary:high",
        fallbackModels: ["example/backup"],
      },
      { name: "inherited-defaults" },
      { name: "inherited-model", thinking: "high" },
    ]) {
      const created = handleCreate(
        {
          config: {
            ...config,
            scope: "project",
            description: "Discovery fixture",
            defaultContext: "fresh",
          },
        },
        ctx,
      );
      assert.equal(created.isError, false, readText(created));
    }
    const listed = handleManagementAction("list", { agentScope: "project" }, ctx);
    assert.equal(listed.isError, false);
    const text = readText(listed);
    const profile = (name: string) => {
      const entry = text.split("\n- ").find((line) => line.startsWith(`${name} (`));
      assert.ok(entry !== undefined, `Missing profile ${name}`);
      assert.match(entry, /\(project, context: fresh\): Discovery fixture/);
      return entry;
    };
    assert.match(
      profile("explicit-defaults"),
      /Model: example\/primary; Thinking: medium; Fallback models: example\/backup:high \(thinking: high\), other\/last \(thinking: medium\)/,
    );
    assert.match(
      profile("suffix-defaults"),
      /Model: example\/primary:high; Thinking: high; Fallback models: example\/backup \(thinking: medium\)/,
    );
    assert.match(
      profile("suffix-inherited-fallback"),
      /Model: example\/primary:high; Thinking: high; Fallback models: example\/backup \(thinking: high\)/,
    );
    assert.match(
      profile("inherited-defaults"),
      /Model: inherited from parent .*; Thinking: inherited runtime default .*; Fallback models: none configured/,
    );
    assert.match(profile("inherited-model"), /Model: inherited from parent .*; Thinking: high;/);
  });

  it("rejects invalid management config with field-specific diagnostics", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    for (const [config, errors] of [
      [{ name: "typo-agent", description: "test", extra: true }, [/unknown field: extra/]],
      [
        { name: "Scout", package: "!!!", description: "Fast recon", scope: "project" },
        [/config\.package is invalid/],
      ],
      [
        { name: "budget-worker", description: "Bounded worker", scope: "project", maxTokens: 0 },
        [/config\.maxTokens must be an integer >= 1/],
      ],
      [
        {
          name: "test-runner",
          description: "Run tests",
          scope: "project",
          completionGuard: "false",
        },
        [/config\.completionGuard must be a boolean/],
      ],
      [
        {
          name: "Review Flow",
          description: "Review flow",
          scope: "project",
          steps: [{ agent: "reviewer", task: "Review", skill: "code-review" }],
        },
        [/config\.steps\[0\]\.skill is not supported/, /use skills/],
      ],
    ] as const) {
      const result = handleManagementAction("create", { config }, ctx);
      assert.equal(result.isError, true);
      for (const error of errors) {
        assert.match(readText(result), error);
      }
    }
  });
  it("surfaces JSON parse errors for create and update config strings", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    for (const [action, params] of [
      ["create", { config: '{"name":' }],
      ["update", { agent: "reviewer", config: '{"description":' }],
    ] as const) {
      const result = handleManagementAction(action, params, ctx);
      assert.equal(result.isError, true);
      assert.match(readText(result), /config must be valid JSON:/);
    }
  });

  it("refuses to mutate duplicate definitions within one scope", () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    const legacyPath = path.join(tempDir, ".pi", "agent", "agents", "duplicate.md");
    const currentPath = path.join(tempDir, ".agents", "duplicate.md");
    for (const filePath of [legacyPath, currentPath]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        "---\nname: duplicate\ndescription: Duplicate\n---\nBody",
        "utf-8",
      );
    }
    try {
      const result = handleManagementAction(
        "delete",
        { agent: "duplicate", agentScope: "user" },
        {
          cwd: tempDir,
          modelRegistry: makeExtensionContext(tempDir).modelRegistry,
          isProjectTrusted: () => true,
        },
      );
      assert.equal(result.isError, true);
      assert.match(readText(result), /multiple definitions in scope 'user'/);
      assert.equal(fs.existsSync(legacyPath), true);
      assert.equal(fs.existsSync(currentPath), true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
  });

  it("refuses to mutate duplicate project agent and chain definitions", () => {
    fs.mkdirSync(path.join(tempDir, ".git"));
    const legacyAgent = path.join(tempDir, ".agents", "duplicate.md");
    const currentAgent = path.join(tempDir, ".pi", "agents", "duplicate.md");
    for (const filePath of [legacyAgent, currentAgent]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        "---\nname: duplicate\ndescription: Duplicate\n---\nBody",
        "utf-8",
      );
    }
    const chainMarkdown = path.join(tempDir, ".pi", "chains", "duplicate.chain.md");
    const chainJson = path.join(tempDir, ".pi", "chains", "duplicate.chain.json");
    fs.mkdirSync(path.dirname(chainMarkdown), { recursive: true });
    fs.writeFileSync(
      chainMarkdown,
      "---\nname: duplicate-chain\ndescription: Duplicate\n---\n\n## worker\n\none\n",
      "utf-8",
    );
    fs.writeFileSync(
      chainJson,
      JSON.stringify({
        name: "duplicate-chain",
        description: "Duplicate",
        chain: [{ agent: "worker", task: "two" }],
      }),
      "utf-8",
    );
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };

    const agentResult = handleManagementAction(
      "delete",
      { agent: "duplicate", agentScope: "project" },
      ctx,
    );
    const chainResult = handleManagementAction(
      "delete",
      { chainName: "duplicate-chain", agentScope: "project" },
      ctx,
    );
    assert.equal(agentResult.isError, true);
    assert.match(readText(agentResult), /multiple definitions in scope 'project'/);
    assert.equal(chainResult.isError, true);
    assert.match(readText(chainResult), /multiple definitions in scope 'project'/);
    for (const filePath of [legacyAgent, currentAgent, chainMarkdown, chainJson]) {
      assert.equal(fs.existsSync(filePath), true);
    }
  });

  it("creates, gets, updates, and deletes a packaged agent by runtime name", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    const created = handleCreate(
      {
        config: {
          name: "Scout",
          package: "Code Analysis",
          description: "Fast recon",
          scope: "project",
          systemPrompt: "Inspect",
        },
      },
      ctx,
    );

    assert.equal(created.isError, false);
    assert.match(readText(created), /Created agent 'code-analysis.scout'/);
    const filePath = path.join(tempDir, ".pi", "agents", "code-analysis.scout.md");
    let content = fs.readFileSync(filePath, "utf-8");
    assert.match(content, /^name: scout$/m);
    assert.match(content, /^package: code-analysis$/m);
    assert.doesNotMatch(content, /^name: code-analysis\.scout$/m);

    const got = handleManagementAction("get", { agent: "code-analysis.scout" }, ctx);
    assert.equal(got.isError, false);
    assert.match(readText(got), /Agent: code-analysis\.scout/);
    assert.match(readText(got), /Local name: scout/);
    assert.match(readText(got), /Package: code-analysis/);

    const updated = handleUpdate(
      { agent: "code-analysis.scout", config: { package: "documentation" } },
      ctx,
    );
    assert.equal(updated.isError, false);
    assert.match(readText(updated), /code-analysis\.scout' to 'documentation\.scout'/);
    assert.equal(fs.existsSync(filePath), false);
    const updatedPath = path.join(tempDir, ".pi", "agents", "documentation.scout.md");
    content = fs.readFileSync(updatedPath, "utf-8");
    assert.match(content, /^name: scout$/m);
    assert.match(content, /^package: documentation$/m);

    const deleted = handleManagementAction("delete", { agent: "documentation.scout" }, ctx);
    assert.equal(deleted.isError, false);
    assert.equal(fs.existsSync(updatedPath), false);
  });

  it("creates and updates packaged chains while preserving packaged step names", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "agents", "code-analysis.scout.md"),
      `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`,
      "utf-8",
    );

    const created = handleCreate(
      {
        config: {
          name: "Review Flow",
          package: "Code Analysis",
          description: "Review flow",
          scope: "project",
          steps: [{ agent: "code-analysis.scout", task: "Inspect" }],
        },
      },
      ctx,
    );
    assert.equal(created.isError, false);
    assert.match(readText(created), /Created chain 'code-analysis.review-flow'/);
    const filePath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.md");
    let content = fs.readFileSync(filePath, "utf-8");
    assert.match(content, /^name: review-flow$/m);
    assert.match(content, /^package: code-analysis$/m);
    assert.match(content, /^## code-analysis\.scout$/m);

    const updated = handleUpdate(
      { chainName: "code-analysis.review-flow", config: { package: false } },
      ctx,
    );
    assert.equal(updated.isError, false);
    const updatedPath = path.join(tempDir, ".pi", "chains", "review-flow.chain.md");
    assert.equal(fs.existsSync(filePath), false);
    content = fs.readFileSync(updatedPath, "utf-8");
    assert.match(content, /^name: review-flow$/m);
    assert.doesNotMatch(content, /^package:/m);
  });

  it("creates saved chains with plural step skills", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    const result = handleCreate(
      {
        config: {
          name: "Review Flow",
          description: "Review flow",
          scope: "project",
          steps: [{ agent: "reviewer", task: "Review", skills: ["code-review", "security"] }],
        },
      },
      ctx,
    );

    assert.equal(result.isError, false);
    const filePath = path.join(tempDir, ".pi", "chains", "review-flow.chain.md");
    const content = fs.readFileSync(filePath, "utf-8");
    assert.match(content, /^skills: code-review, security$/m);
    assert.doesNotMatch(content, /^skill:/m);

    const got = handleManagementAction("get", { chainName: "review-flow" }, ctx);
    assert.equal(got.isError, false);
    assert.match(readText(got), /Skills: code-review, security/);
  });

  it("preserves task headings through managed chain creation and updates", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    const task =
      'Review this change.\n\n## Requirements\nDo not modify any files.\n\n```md\n## "Example"\\path\n```\n\u2028## Line separator\u2029## Paragraph separator\n';
    const steps = [
      { agent: "worker", task, outputSchema: "./schemas/review.json", skills: ["review"] },
      { agent: "reviewer", task: "" },
    ];
    const created = handleCreate(
      {
        config: {
          name: "heading-repro",
          description: "Heading round trip",
          scope: "project",
          steps,
        },
      },
      ctx,
    );
    assert.equal(created.isError, false);
    const load = () =>
      discoverAgentsAll(tempDir, { projectTrusted: true }, "project").chains.find(
        (chain) => chain.name === "heading-repro",
      );
    assert.deepEqual(load()?.steps, steps);

    const updatedSteps = [
      { ...steps[0], task: `${task}\n\n## Report\nReturn findings.` },
      steps[1],
    ];
    const updated = handleUpdate(
      { chainName: "heading-repro", config: { steps: updatedSteps } },
      ctx,
    );
    assert.equal(updated.isError, false);
    assert.deepEqual(load()?.steps, updatedSteps);
  });

  it("creates agents with explicit completion guard settings", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    for (const completionGuard of [false, true]) {
      const result = handleCreate(
        {
          config: {
            name: "test-runner",
            description: "Run tests",
            scope: "project",
            tools: "read, grep, bash, ls",
            completionGuard,
          },
        },
        ctx,
      );
      assert.equal(result.isError, false);
      const filePath = path.join(tempDir, ".pi", "agents", "test-runner.md");
      const content = fs.readFileSync(filePath, "utf-8");
      assert.match(content, new RegExp(`^completionGuard: ${completionGuard}$`, "m"));
      const got = handleManagementAction("get", { agent: "test-runner" }, ctx);
      assert.equal(got.isError, false);
      assert.match(readText(got), new RegExp(`Completion guard: ${completionGuard}`));
      fs.unlinkSync(filePath);
    }
  });
  it("creates agents with resource limits", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    const result = handleCreate(
      {
        config: {
          name: "budget-worker",
          description: "Bounded worker",
          scope: "project",
          maxExecutionTimeMs: 600000,
          maxTokens: 50000,
          allowSubagents: true,
          maxSubagentDepth: 1,
          systemPromptMode: "replace",
        },
      },
      ctx,
    );

    assert.equal(result.isError, false);
    const filePath = path.join(tempDir, ".pi", "agents", "budget-worker.md");
    const content = fs.readFileSync(filePath, "utf-8");
    assert.match(content, /^maxExecutionTimeMs: 600000$/m);
    assert.match(content, /^maxTokens: 50000$/m);
    assert.match(content, /^allowSubagents: true$/m);
    assert.match(content, /^maxSubagentDepth: 1$/m);
    assert.match(content, /^systemPromptMode: replace$/m);

    const got = handleManagementAction("get", { agent: "budget-worker" }, ctx);
    assert.equal(got.isError, false);
    assert.match(readText(got), /Max execution time: 600000ms/);
    assert.match(readText(got), /Max tokens: 50000/);
  });

  it("updates JSON chain descriptions without rewriting them as markdown", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
    fs.mkdirSync(path.dirname(chainPath), { recursive: true });
    fs.writeFileSync(
      chainPath,
      JSON.stringify({
        name: "dynamic-review",
        description: "Review dynamic targets",
        chain: [
          {
            agent: "scout",
            task: "Return targets",
            as: "targets",
            outputSchema: { type: "object" },
          },
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
      }),
      "utf-8",
    );

    const loaded = discoverAgentsAll(tempDir, { projectTrusted: true }, "project").chains.find(
      (chain) => chain.name === "dynamic-review",
    );
    assert.equal(loaded?.name, "dynamic-review");
    assert.equal(loaded.steps.length, 2);
    assert.deepEqual(loaded.steps[1]?.collect, { as: "reviews" });
    assert.deepEqual(loaded.steps[0]?.outputSchema, { type: "object" });
    const updated = handleUpdate(
      { chainName: "dynamic-review", config: { description: "Updated dynamic review" } },
      ctx,
    );

    assert.equal(updated.isError, false);
    const content = fs.readFileSync(chainPath, "utf-8");
    assert.doesNotMatch(content, /^---/);
    const parsed = parseJsonObject(content);
    assert.equal(parsed.description, "Updated dynamic review");
    assert.deepEqual(objectAt(parsed, "chain", 0).outputSchema, { type: "object" });
    assert.equal(objectAt(parsed, "chain", 1, "collect").as, "reviews");
  });

  it("serializes managed JSON chain skills in the runtime format", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    const chainPath = path.join(tempDir, ".pi", "chains", "review-flow.chain.json");
    fs.mkdirSync(path.dirname(chainPath), { recursive: true });
    fs.writeFileSync(
      chainPath,
      JSON.stringify({
        name: "review-flow",
        description: "Review targets",
        chain: [{ agent: "scout", task: "Review", skill: ["review"] }],
      }),
      "utf-8",
    );

    const updated = handleUpdate(
      {
        chainName: "review-flow",
        config: {
          steps: [{ agent: "scout", task: "Review again", skills: ["review", "verification"] }],
        },
      },
      ctx,
    );

    assert.equal(updated.isError, false, readText(updated));
    const parsed = parseJsonObject(fs.readFileSync(chainPath, "utf-8"));
    assert.deepEqual(objectAt(parsed, "chain", 0).skill, ["review", "verification"]);
    assert.equal(objectAt(parsed, "chain", 0).skills, undefined);
    const got = handleManagementAction("get", { chainName: "review-flow" }, ctx);
    assert.equal(got.isError, false, readText(got));
    assert.match(readText(got), /Skills: review, verification/);
  });

  it("renames and repackages JSON chains while preserving JSON format and extension", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
    fs.mkdirSync(path.dirname(chainPath), { recursive: true });
    fs.writeFileSync(
      chainPath,
      JSON.stringify({
        name: "dynamic-review",
        description: "Review dynamic targets",
        chain: [{ agent: "scout", task: "Return targets" }],
      }),
      "utf-8",
    );

    const updated = handleUpdate(
      { chainName: "dynamic-review", config: { name: "Review Flow", package: "Code Analysis" } },
      ctx,
    );

    assert.equal(updated.isError, false);
    const updatedPath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.json");
    assert.equal(fs.existsSync(chainPath), false);
    const content = fs.readFileSync(updatedPath, "utf-8");
    assert.doesNotMatch(content, /^---/);
    const parsed = parseJsonObject(content);
    assert.equal(parsed.name, "review-flow");
    assert.equal(parsed.package, "code-analysis");
    assert.equal(objectAt(parsed, "chain", 0).agent, "scout");
  });

  it("gets dynamic JSON chain details and lists invalid chain diagnostics", () => {
    const ctx = {
      cwd: tempDir,
      modelRegistry: makeExtensionContext(tempDir).modelRegistry,
      isProjectTrusted: () => true,
    };
    fs.mkdirSync(path.join(tempDir, ".pi", "chains"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json"),
      JSON.stringify({
        name: "dynamic-review",
        description: "Review dynamic targets",
        chain: [
          {
            agent: "scout",
            task: "Return targets",
            as: "targets",
            outputSchema: { type: "object" },
          },
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
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(tempDir, ".pi", "chains", "broken.chain.json"), "{", "utf-8");

    const got = handleManagementAction("get", { chainName: "dynamic-review" }, ctx);
    assert.equal(got.isError, false);
    assert.match(readText(got), /Dynamic fanout -> reviews/);
    assert.match(readText(got), /Expand: targets\/items/);
    assert.match(readText(got), /Agent: reviewer/);

    const listed = handleManagementAction("list", {}, ctx);
    assert.equal(listed.isError, false);
    assert.match(readText(listed), /Discovery diagnostics:/);
    assert.match(readText(listed), /broken\.chain\.json/);
    assert.match(readText(listed), /Invalid JSON chain/);
  });

  it("creates a custom delegate agent with native prompt defaults", () => {
    const result = handleCreate(
      { config: { name: "delegate", description: "Delegate helper", scope: "project" } },
      {
        cwd: tempDir,
        modelRegistry: makeExtensionContext(tempDir).modelRegistry,
        isProjectTrusted: () => true,
      },
    );

    assert.equal(result.isError, false);
    const filePath = path.join(tempDir, ".pi", "agents", "delegate.md");
    const content = fs.readFileSync(filePath, "utf-8");
    assert.match(content, /systemPromptMode: append/);
    assert.match(content, /inheritProjectContext: true/);
    assert.match(content, /inheritSkills: true/);
    assert.match(content, /maxSubagentDepth: 0/);
  });
});
