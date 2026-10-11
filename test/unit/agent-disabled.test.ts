import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeExtensionContext } from "../support/sdk-context.ts";
import { textAt } from "../support/assertions.ts";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { handleList, handleManagementAction } from "../../src/agents/agent-management.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readText(result: { readonly content: unknown }): string {
  return textAt(result.content);
}

function writeAgent(filePath: string, name: string, description: string, model: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\nmodel: ${model}\n---\n\n${description} prompt.\n`,
    "utf-8",
  );
}

describe("builtin agent disabling", () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-home-"));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-project-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
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
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it("filters a per-agent disabled builtin from runtime discovery while keeping it in discoverAgentsAll", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        agentOverrides: {
          reviewer: { disabled: true },
        },
      },
    });

    const runtimeReviewer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "reviewer",
    );
    assert.equal(runtimeReviewer, undefined);

    const allReviewer = discoverAgentsAll(tempProject).builtin.find(
      (agent) => agent.name === "reviewer",
    );
    assert.ok(allReviewer);
    assert.equal(allReviewer.disabled, true);
  });

  it("surfaces malformed disabled overrides instead of silently ignoring them", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentOverrides: {
          reviewer: { disabled: "true" },
        },
      },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("reviewer") &&
        error.message.includes("disabled"),
    );
  });

  it("an explicit user override opts a builtin out of user-scope bulk disable", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        disableBuiltins: true,
        agentOverrides: {
          reviewer: { model: "openai/gpt-5.4" },
        },
      },
    });

    const reviewer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "reviewer",
    );
    assert.ok(reviewer);
    assert.equal(reviewer.disabled, undefined);
    assert.equal(reviewer.model, "openai/gpt-5.4");
  });

  it("project disableBuiltins false re-enables builtins hidden by user bulk disable", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { disableBuiltins: true },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { disableBuiltins: false },
    });

    assert.ok(
      discoverAgents(tempProject, "both").agents.some((agent) => agent.source === "builtin"),
    );
  });

  it("project bulk disable beats user per-agent re-enable overrides", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        disableBuiltins: true,
        agentOverrides: {
          reviewer: { disabled: false, model: "openai/gpt-5.4" },
        },
      },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { disableBuiltins: true },
    });

    const reviewer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "reviewer",
    );
    assert.equal(reviewer, undefined);

    const allReviewer = discoverAgentsAll(tempProject).builtin.find(
      (agent) => agent.name === "reviewer",
    );
    assert.ok(allReviewer);
    assert.equal(allReviewer.disabled, true);
  });

  it("surfaces malformed disableBuiltins values instead of silently ignoring them", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: { disableBuiltins: "true" },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("disableBuiltins"),
    );
  });

  it("hides disabled builtins from agent-facing management list output", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { disableBuiltins: true },
    });
    const agentsDir = path.join(tempProject, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "helper.md"),
      "---\nname: helper\ndescription: Helper\n---\n\nHelp.\n",
      "utf-8",
    );
    const disabledBuiltins = discoverAgentsAll(tempProject).builtin;
    assert.ok(disabledBuiltins.every((agent) => agent.disabled === true));
    const disabledBuiltinNames = disabledBuiltins.map((agent) => agent.name);
    assert.equal(
      discoverAgents(tempProject, "both").agents.filter((agent) => agent.source === "builtin")
        .length,
      0,
    );
    assert.ok(disabledBuiltinNames.length > 0);

    const text = readText(
      handleList(
        {},
        {
          cwd: tempProject,
          modelRegistry: makeExtensionContext(tempProject).modelRegistry,
          isProjectTrusted: () => true,
        },
      ),
    );

    assert.match(text, /Executable agents \(grouped by role\):/);
    assert.match(text, /^- helper \(project\): Helper$/m);
    assert.doesNotMatch(text, /Disabled builtins:/);
    for (const name of disabledBuiltinNames) {
      assert.doesNotMatch(text, new RegExp(`^- ${name} \\(builtin`, "m"));
    }
  });

  it("management list shows effective agents instead of duplicate shadowed builtins", () => {
    writeAgent(
      path.join(tempHome, ".pi", "agent", "agents", "reviewer.md"),
      "reviewer",
      "User reviewer override",
      "openai/gpt-user",
    );

    const text = readText(
      handleList(
        {},
        {
          cwd: tempProject,
          modelRegistry: makeExtensionContext(tempProject).modelRegistry,
          isProjectTrusted: () => true,
        },
      ),
    );

    assert.match(text, /^- reviewer \(user\): User reviewer override$/m);
    assert.doesNotMatch(text, /^- reviewer \(builtin/m);
    assert.equal((text.match(/^- reviewer /gm) ?? []).length, 1);
  });

  it("management get returns the effective override instead of every same-named agent", () => {
    writeAgent(
      path.join(tempHome, ".pi", "agent", "agents", "reviewer.md"),
      "reviewer",
      "User reviewer override",
      "openai/gpt-user",
    );
    writeAgent(
      path.join(tempProject, ".pi", "agents", "reviewer.md"),
      "reviewer",
      "Project reviewer override",
      "openai/gpt-project",
    );

    writeAgent(
      path.join(tempHome, ".pi", "agent", "agents", "user-only.md"),
      "user-only",
      "User only",
      "openai/gpt-user",
    );
    writeAgent(
      path.join(tempProject, ".pi", "agents", "project-only.md"),
      "project-only",
      "Project only",
      "openai/gpt-project",
    );
    const discovered = discoverAgents(tempProject, "both").agents;
    assert.deepEqual(
      discovered
        .filter((agent) => agent.name === "user-only" || agent.name === "project-only")
        .map((agent) => [agent.name, agent.source])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ["project-only", "project"],
        ["user-only", "user"],
      ],
    );
    const reviewers = discovered.filter((agent) => agent.name === "reviewer");
    assert.equal(reviewers.length, 1);
    assert.equal(reviewers[0]?.source, "project");
    assert.equal(reviewers[0]?.systemPrompt, "Project reviewer override prompt.");
    const userReviewers = discoverAgents(tempProject, "user").agents.filter(
      (agent) => agent.name === "reviewer",
    );
    assert.equal(userReviewers.length, 1);
    assert.equal(userReviewers[0]?.source, "user");
    assert.equal(userReviewers[0]?.systemPrompt, "User reviewer override prompt.");
    const text = readText(
      handleManagementAction(
        "get",
        { action: "get", agent: "reviewer" },
        {
          cwd: tempProject,
          modelRegistry: makeExtensionContext(tempProject).modelRegistry,
          isProjectTrusted: () => true,
        },
      ),
    );

    assert.match(text, /^Agent: reviewer \(project\)$/m);
    assert.match(text, /Model: openai\/gpt-project/);
    assert.doesNotMatch(text, /Agent: reviewer \(builtin\)/);
    assert.doesNotMatch(text, /Model: openai\/gpt-user/);
  });

  it("management get can still inspect a specific shadowing scope", () => {
    writeAgent(
      path.join(tempHome, ".pi", "agent", "agents", "reviewer.md"),
      "reviewer",
      "User reviewer override",
      "openai/gpt-user",
    );
    writeAgent(
      path.join(tempProject, ".pi", "agents", "reviewer.md"),
      "reviewer",
      "Project reviewer override",
      "openai/gpt-project",
    );

    const text = readText(
      handleManagementAction(
        "get",
        { action: "get", agent: "reviewer", agentScope: "user" },
        {
          cwd: tempProject,
          modelRegistry: makeExtensionContext(tempProject).modelRegistry,
          isProjectTrusted: () => true,
        },
      ),
    );

    assert.match(text, /^Agent: reviewer \(user\)$/m);
    assert.match(text, /Model: openai\/gpt-user/);
    assert.doesNotMatch(text, /Agent: reviewer \(project\)/);
  });
});
