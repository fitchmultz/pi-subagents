import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { serializeChain } from "../../src/agents/chain-serializer.ts";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) {
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent frontmatter defaultContext", () => {
  it("parses defaultContext from discovered agent frontmatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-default-context-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---   \nname: worker
description: Worker
defaultContext: fork
completionGuard: false
allowSubagents: true
maxSubagentDepth: 1
maxExecutionTimeMs: 600000
maxTokens: 50000
inheritProjectContext: false
inheritSkills: false
--- \t

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.ok(worker);
    assert.equal(worker.name, "worker");
    assert.equal(worker.description, "Worker");
    assert.equal(worker.systemPrompt, "Do work");
    assert.equal(worker.defaultContext, "fork");
    assert.equal(worker.completionGuard, false);
    assert.equal(worker.allowSubagents, true);
    assert.equal(worker.maxSubagentDepth, 1);
    assert.equal(worker.maxExecutionTimeMs, 600000);
    assert.equal(worker.maxTokens, 50000);
    assert.equal(worker.inheritProjectContext, false);
    assert.equal(worker.inheritSkills, false);
    assert.equal(worker.extraFields?.completionGuard, undefined);
    assert.equal(worker.extraFields?.allowSubagents, undefined);
    assert.equal(worker.extraFields?.maxExecutionTimeMs, undefined);
    assert.equal(worker.extraFields?.maxTokens, undefined);
  });
});

describe("agent frontmatter prompt assembly defaults", () => {
  it("preserves Pi's prompt, project context, and skills while blocking nested delegation", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-agent-default-prompt-settings-"),
    );
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---
name: worker
description: Worker
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.equal(worker?.systemPromptMode, "append");
    assert.equal(worker.inheritProjectContext, true);
    assert.equal(worker.inheritSkills, true);
    assert.equal(worker.maxSubagentDepth, 0);
  });
});

describe("packaged agent and chain discovery", () => {
  it("discovers visible nested profiles and diagnoses visible malformed definitions while skipping hidden descendants", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-recursive-agent-discovery-"));
    tempDirs.push(dir);
    const nestedDir = path.join(dir, ".pi", "agents", "code-analysis", "deep");
    const nestedChainDir = path.join(dir, ".pi", "chains", "code-analysis", "deep");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(nestedChainDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedDir, "scout.md"),
      `---
name: scout
description: Nested scout
---

Inspect code
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(nestedChainDir, "review.chain.md"),
      `---
name: review-flow
description: Review flow
---

## scout

Review
`,
      "utf-8",
    );

    const hiddenAgents = path.join(dir, ".pi", "agents", ".pi", "notes");
    const hiddenChains = path.join(dir, ".pi", "chains", ".drafts");
    fs.mkdirSync(hiddenAgents, { recursive: true });
    fs.mkdirSync(hiddenChains, { recursive: true });
    fs.writeFileSync(
      path.join(hiddenAgents, "agent-profile-comparison.md"),
      "A private research note, not an agent.\n",
    );
    fs.writeFileSync(
      path.join(hiddenAgents, "hidden.md"),
      "---\nname: hidden-agent\ndescription: Hidden definition\n---\nDo work\n",
    );
    fs.writeFileSync(
      path.join(hiddenChains, "hidden.chain.md"),
      "---\nname: hidden-chain\ndescription: Hidden flow\n---\n## scout\nReview\n",
    );
    const malformedAgent = path.join(nestedDir, "invalid.md");
    const malformedChain = path.join(nestedChainDir, "invalid.chain.md");
    fs.writeFileSync(malformedAgent, "---\nname: invalid\n---\nMissing description\n");
    fs.writeFileSync(malformedChain, "---\nname: invalid\n---\nNo steps\n");

    const result = discoverAgentsAll(dir);
    assert.ok(
      result.project.find(
        (agent) => agent.name === "scout" && agent.filePath === path.join(nestedDir, "scout.md"),
      ),
    );
    assert.ok(
      result.chains.find(
        (chain) =>
          chain.name === "review-flow" &&
          chain.filePath === path.join(nestedChainDir, "review.chain.md"),
      ),
    );
    assert.equal(
      result.project.some((agent) => agent.filePath.endsWith("review.chain.md")),
      false,
    );
    assert.equal(
      result.project.some((agent) => agent.name === "hidden-agent"),
      false,
    );
    assert.equal(
      result.chains.some((chain) => chain.name === "hidden-chain"),
      false,
    );
    assert.deepEqual(
      result.agentDiagnostics.map((diagnostic) => diagnostic.filePath),
      [malformedAgent],
    );
    assert.deepEqual(
      result.chainDiagnostics.map((diagnostic) => diagnostic.filePath),
      [malformedChain],
    );
    assert.equal(
      fs.readFileSync(path.join(hiddenAgents, "agent-profile-comparison.md"), "utf8"),
      "A private research note, not an agent.\n",
    );
  });

  it("registers packaged agents by runtime name and serializes local name plus package", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-agent-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "scout.md"),
      `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect code
`,
      "utf-8",
    );

    const scout = discoverAgents(dir, "project").agents.find(
      (agent) => agent.name === "code-analysis.scout",
    );
    assert.ok(scout);
    assert.equal(scout.localName, "scout");
    assert.equal(scout.packageName, "code-analysis");
    const serialized = serializeAgent(scout);
    assert.match(serialized, /^name: scout$/m);
    assert.match(serialized, /^package: code-analysis$/m);
    assert.doesNotMatch(serialized, /^name: code-analysis\.scout$/m);
  });

  it("recursively discovers packaged chains by runtime name and preserves package on serialize", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-chain-"));
    tempDirs.push(dir);
    const nestedDir = path.join(dir, ".pi", "chains", "flows");
    fs.mkdirSync(nestedDir, { recursive: true });
    const content = `---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Inspect {task}
`;
    fs.writeFileSync(path.join(nestedDir, "review.chain.md"), content, "utf-8");

    const chain = discoverAgentsAll(dir).chains.find(
      (candidate) => candidate.name === "code-analysis.review-flow",
    );
    assert.ok(chain);
    assert.equal(chain.localName, "review-flow");
    assert.equal(chain.packageName, "code-analysis");
    assert.equal(chain.steps[0]?.agent, "code-analysis.scout");
    const serialized = serializeChain(chain);
    assert.match(serialized, /^name: review-flow$/m);
    assert.match(serialized, /^package: code-analysis$/m);
    assert.match(serialized, /^## code-analysis\.scout$/m);
    assert.doesNotMatch(serialized, /^name: code-analysis\.review-flow$/m);
  });

  it("keeps packaged and un-packaged runtime names distinct while preserving un-packaged precedence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-collisions-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".agents", "scout.md"),
      `---
name: scout
description: Legacy scout
---

Legacy
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "scout.md"),
      `---
name: scout
description: Project scout
---

Project
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "packaged.md"),
      `---
name: scout
package: code-analysis
description: Packaged scout
---

Packaged
`,
      "utf-8",
    );

    const agents = discoverAgents(dir, "project").agents;
    const unqualified = agents.find((agent) => agent.name === "scout");
    const packaged = agents.find((agent) => agent.name === "code-analysis.scout");
    assert.equal(unqualified?.description, "Project scout");
    assert.equal(unqualified.filePath, path.join(dir, ".pi", "agents", "scout.md"));
    assert.equal(unqualified.systemPrompt, "Project");
    assert.equal(packaged?.description, "Packaged scout");
  });

  it("normalizes package frontmatter consistently for agents and chains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-normalize-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    const chainsDir = path.join(dir, ".pi", "chains");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(chainsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "scout.md"),
      `---
name: scout
package: Code Analysis!
description: Fast recon
---

Inspect
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(chainsDir, "review.chain.md"),
      `---
name: review-flow
package: Code Analysis!
description: Review flow
---

## code-analysis.scout

Review
`,
      "utf-8",
    );

    const result = discoverAgentsAll(dir);
    assert.ok(result.project.find((agent) => agent.name === "code-analysis.scout"));
    assert.ok(result.chains.find((chain) => chain.name === "code-analysis.review-flow"));
  });

  it("skips invalid package frontmatter that cannot be normalized", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-invalid-package-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    const chainsDir = path.join(dir, ".pi", "chains");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(chainsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "scout.md"),
      `---
name: scout
package: !!!
description: Fast recon
---

Inspect
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(chainsDir, "review.chain.md"),
      `---
name: review-flow
package: !!!
description: Review flow
---

## scout

Review
`,
      "utf-8",
    );

    const result = discoverAgentsAll(dir);
    assert.equal(
      result.project.some((agent) => agent.filePath.endsWith("scout.md")),
      false,
    );
    assert.equal(
      result.chains.some((chain) => chain.filePath.endsWith("review.chain.md")),
      false,
    );
  });
});

describe("project agent directory discovery", () => {
  it("discovers project agents from both .agents and .pi/agents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-dirs-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".agents", "legacy.md"),
      `---
name: legacy
description: Legacy
---

Legacy prompt
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "canonical.md"),
      `---
name: canonical
description: Canonical
---

Canonical prompt
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    assert.ok(
      result.agents.find(
        (agent) =>
          agent.name === "legacy" && agent.filePath === path.join(dir, ".agents", "legacy.md"),
      ),
    );
    assert.ok(
      result.agents.find(
        (agent) =>
          agent.name === "canonical" &&
          agent.filePath === path.join(dir, ".pi", "agents", "canonical.md"),
      ),
    );
    assert.equal(result.projectAgentsDir, path.join(dir, ".pi", "agents"));
  });

  it("uses the project root for the canonical project agent dir even when only .agents exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-root-"));
    tempDirs.push(dir);
    const nested = path.join(dir, "packages", "app");
    fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    const result = discoverAgentsAll(nested);
    assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
  });

  it("does not treat a bare .pi directory as a project agent root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-bare-pi-root-"));
    tempDirs.push(dir);
    const nested = path.join(dir, "packages", "app");
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    const result = discoverAgentsAll(nested);
    assert.equal(result.projectDir, null);
  });

  it("does not load Agent Skill SKILL.md files as project agents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-skill-not-agent-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".agents", "skills", "helper", "references"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".agents", "skills", "helper", "SKILL.md"),
      `---
name: helper-skill
description: Skill, not an agent
---

Skill instructions
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".agents", "skills", "helper", "references", "notes.md"),
      `---
name: helper-reference
description: Reference doc, not an agent
---

Reference notes
`,
      "utf-8",
    );

    fs.writeFileSync(
      path.join(dir, ".agents", "worker.md"),
      "---\nname: worker\ndescription: Worker\n---\nDo work\n",
    );
    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.equal(worker?.source, "project");
    assert.equal(worker.filePath, path.join(dir, ".agents", "worker.md"));
    assert.equal(
      result.agents.some((agent) => agent.name === "helper-skill"),
      false,
    );
    assert.equal(
      result.agents.some((agent) => agent.name === "helper-reference"),
      false,
    );
  });

  it("discovers project chains from .pi/chains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-dirs-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".pi", "chains", "flows"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "ignored.chain.md"),
      `---
name: ignored-chain
description: Ignored chain
---

## scout

Ignore
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "chains", "flows", "canonical.chain.md"),
      `---
name: canonical-chain
description: Canonical chain
---

## worker

Inspect canonical
`,
      "utf-8",
    );

    const result = discoverAgentsAll(dir);
    assert.equal(
      result.chains.some((chain) => chain.name === "ignored-chain"),
      false,
    );
    assert.ok(
      result.chains.find(
        (chain) =>
          chain.name === "canonical-chain" &&
          chain.filePath === path.join(dir, ".pi", "chains", "flows", "canonical.chain.md"),
      ),
    );
    assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
    assert.equal(result.projectChainDir, path.join(dir, ".pi", "chains"));
  });

  it("retains project and user chain source records on name collisions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-collision-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-user-chain-home-"));
    tempDirs.push(dir, home);
    const oldHome = process.env.HOME;
    const oldUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const userChainsDir = path.join(home, ".pi", "agent", "chains");
      fs.mkdirSync(userChainsDir, { recursive: true });
      fs.mkdirSync(path.join(dir, ".pi", "chains"), { recursive: true });
      fs.writeFileSync(
        path.join(userChainsDir, "shared.chain.md"),
        `---
name: shared-chain
description: User chain
---

## scout

Inspect user
`,
        "utf-8",
      );
      fs.writeFileSync(
        path.join(dir, ".pi", "chains", "shared.chain.md"),
        `---
name: shared-chain
description: Project chain
---

## worker

Inspect project
`,
        "utf-8",
      );

      const sharedChains = discoverAgentsAll(dir).chains.filter(
        (chain) => chain.name === "shared-chain",
      );
      assert.equal(sharedChains.length, 2);
      assert.deepEqual(
        sharedChains.map((chain) => chain.source),
        ["user", "project"],
      );
      const user = sharedChains.find((chain) => chain.source === "user");
      assert.equal(user?.filePath, path.join(userChainsDir, "shared.chain.md"));
      assert.equal(user.description, "User chain");
      assert.equal(user.steps[0]?.agent, "scout");
      assert.equal(user.steps[0]?.task, "Inspect user");
      const shared = sharedChains.find((chain) => chain.source === "project");
      assert.ok(shared);
      assert.equal(shared.filePath, path.join(dir, ".pi", "chains", "shared.chain.md"));
      assert.equal(shared.description, "Project chain");
      assert.equal(shared.steps[0]?.agent, "worker");
      assert.equal(shared.steps[0]?.task, "Inspect project");
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      if (oldUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = oldUserProfile;
      }
    }
  });
});
