import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import agents from "../../src/agent/index.ts";
import { launchSchema } from "../../src/agent/contracts.ts";
import {
  DEFAULT_OVERSEER_WORKER,
  OVERSEER_ENTRY_TYPE,
  splitWorkerSpec,
} from "../../src/agent/overseer.ts";
import {
  checkToolCallScope,
  formatContractSection,
  isPathAllowedByScope,
  normalizeDelegationContract,
} from "../../src/agent/overseer-scope.ts";
import { prepareLaunch } from "../../src/agent/launch.ts";
import { read } from "../../src/agent/storage.ts";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";

interface BranchEntry {
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
}

async function createHarness(
  t: TestContext,
  sessionId: string,
  settings: Record<string, unknown> = {},
) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getPiAgentDir(),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [agents],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.at(0);
  assert.ok(extension !== undefined);

  let branch: BranchEntry[] = [];
  loaded.runtime.appendEntry = (customType: string, data: unknown) => {
    branch = [...branch, { type: "custom", customType, data }];
  };
  loaded.runtime.getSettings = () => settings;
  const notices: Array<{ message: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const ctx = {
    mode: "interactive",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: (message: string, level: string) => {
        notices.push({ message, level });
      },
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
      theme: {
        fg: (_color: string, text: string) => text,
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => path.join(getPiAgentDir(), `${sessionId}.jsonl`),
      getBranch: () => branch,
      appendCustomEntry: (customType: string, data: unknown) => {
        branch = [...branch, { type: "custom", customType, data }];
      },
    },
  };

  const emit = async (name: string, event: Record<string, unknown>) => {
    await Promise.all(
      (extension.handlers.get(name) ?? []).map((handler) => handler({ type: name, ...event }, ctx)),
    );
  };

  let open = false;
  t.after(async () => {
    if (open) {
      await emit("session_shutdown", { reason: "quit", disposition: "release" });
    }
  });

  return {
    extension,
    ctx,
    notices,
    statuses,
    getBranch: () => branch,
    setBranch: (next: BranchEntry[]) => {
      branch = next;
    },
    start: () => {
      open = true;
      return emit("session_start", { reason: "startup" });
    },
    tree: () => emit("session_tree", {}),
    beforeAgentStart: async () => {
      const sections: Record<string, string> = {};
      await emit("before_agent_start", { systemPromptOptions: { sections } });
      return sections;
    },
    runCommand: async (name: string, args = "") => {
      const cmd = extension.commands.get(name);
      assert.ok(cmd !== undefined, `missing command /${name}`);
      await Reflect.apply(cmd.handler, cmd, [args, ctx]);
    },
  };
}

nodeTest(
  "overseer mode stays inert when off and persists branch-scoped toggle, worker, and judge state",
  async (t) => {
    const harness = await createHarness(t, "overseer-branch");
    await harness.start();

    assert.equal(harness.statuses.get("overseer"), undefined);
    assert.deepEqual(await harness.beforeAgentStart(), {});

    // Bare `/overseer` toggles overseer mode on with footer `overseer` and worker `inherit`.
    await harness.runCommand("overseer", "");
    assert.equal(harness.statuses.get("overseer"), "overseer");
    const activeSections = await harness.beforeAgentStart();
    assert.match(activeSections.overseer ?? "", /Overseer mode is active/u);

    const savedOnBranch = [...harness.getBranch()];
    assert.equal(savedOnBranch.at(-1)?.customType, OVERSEER_ENTRY_TYPE);

    // Bare `/overseer` again toggles off; `/overseer on` re-enables.
    await harness.runCommand("overseer", "");
    assert.equal(harness.statuses.get("overseer"), undefined);
    await harness.runCommand("overseer", "on");
    assert.equal(harness.statuses.get("overseer"), "overseer");

    await harness.runCommand("overseer-worker", "openai/gpt-6-sol:medium");
    // Footer stays a clean `overseer` label even when a custom worker is set.
    assert.equal(harness.statuses.get("overseer"), "overseer");
    assert.deepEqual(harness.getBranch().at(-1)?.data, {
      version: 1,
      enabled: true,
      worker: "openai/gpt-6-sol:medium",
      judge: "auto",
    });
    await harness.runCommand("overseer-worker", "inherit");
    assert.equal(harness.statuses.get("overseer"), "overseer");
    assert.deepEqual(harness.getBranch().at(-1)?.data, {
      version: 1,
      enabled: true,
      worker: "inherit",
      judge: "auto",
    });
    assert.deepEqual(harness.notices.at(-1), {
      message: "Overseer worker set to inherit",
      level: "info",
    });
    await harness.runCommand("overseer-judge", "google/gemini-decision-1");

    // Rewinding the session tree to before /overseer on restores the off state.
    harness.setBranch([]);
    await harness.tree();
    assert.equal(harness.statuses.get("overseer"), undefined);
    assert.deepEqual(await harness.beforeAgentStart(), {});

    // Returning to the saved branch restores the enabled overseer state.
    harness.setBranch(savedOnBranch);
    await harness.tree();
    assert.equal(harness.statuses.get("overseer"), "overseer");

    // Settings `subagents.overseer.worker: "INHERIT"` normalizes to `inherit` and splitWorkerSpec omits defaultModel/defaultThinking.
    const configured = await createHarness(t, "overseer-settings", {
      subagents: { overseer: { enabled: true, worker: "INHERIT" } },
    });
    await configured.start();
    await configured.runCommand("overseer-worker", "status");
    assert.deepEqual(configured.notices.at(-1), {
      message: "Overseer worker: inherit",
      level: "info",
    });
    assert.deepEqual(splitWorkerSpec("INHERIT"), {});
  },
);

nodeTest(
  "normalizeDelegationContract enforces verification on mutating scopes and allows scope: []",
  () => {
    const readOnly = normalizeDelegationContract({ scope: [] });
    assert.deepEqual(readOnly, { scope: [] });

    assert.throws(
      () => normalizeDelegationContract({ scope: ["src/agent"] }),
      /requires at least one verification check/u,
    );
    assert.throws(
      () => normalizeDelegationContract({ scope: ["../escape"], verification: ["npm test"] }),
      /without '\.\.' traversal/u,
    );

    const normalized = normalizeDelegationContract({
      scope: ["./src/agent/", "test/unit/overseer-contract.test.ts"],
      verification: [" npm run test:unit "],
      baseBranch: " main ",
      requiredPrimitives: [" DatabaseSync.createTagStore() "],
      nonGoals: [" Do not add custom statement caches "],
    });
    assert.deepEqual(normalized, {
      scope: ["src/agent", "test/unit/overseer-contract.test.ts"],
      verification: ["npm run test:unit"],
      baseBranch: "main",
      requiredPrimitives: ["DatabaseSync.createTagStore()"],
      nonGoals: ["Do not add custom statement caches"],
    });
    assert.match(formatContractSection(normalized), /DatabaseSync\.createTagStore\(\)/u);
  },
);

nodeTest(
  "checkToolCallScope blocks scope: [] edits, out-of-scope paths, and symlink escapes",
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-scope-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
    const cwd = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(cwd, "src", "agent"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "configs"), { recursive: true });
    fs.mkdirSync(path.join(outside, "dir"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, "src", "agent", "escaped"));
    fs.symlinkSync(path.join(outside, "dir"), path.join(cwd, "src", "agent", "b"));
    fs.symlinkSync("b/../escaped.ts", path.join(cwd, "src", "agent", "a"));
    fs.symlinkSync(
      path.join(outside, "missing-secret.ts"),
      path.join(cwd, "src", "agent", "dangling-escape.ts"),
    );
    fs.writeFileSync(path.join(cwd, "configs", "eslint.json"), "{}\n");
    fs.symlinkSync(path.join("configs", "eslint.json"), path.join(cwd, ".eslintrc.json"));

    assert.equal(isPathAllowedByScope(cwd, "src/agent/index.ts", []), false);
    assert.equal(isPathAllowedByScope(cwd, "src/agent/index.ts", ["src/agent"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/agent-extra/index.ts", ["src/agent"]), false);
    assert.equal(isPathAllowedByScope(cwd, "../outside.ts", ["*"]), false);
    assert.equal(isPathAllowedByScope(cwd, "src/agent/escaped/secret.ts", ["src/agent"]), false);
    // Dangling symlinks pointing outside cwd are resolved through readlink and blocked.
    assert.equal(
      isPathAllowedByScope(cwd, "src/agent/dangling-escape.ts", ["src/agent"], "write"),
      false,
    );
    assert.equal(isPathAllowedByScope(cwd, "src/agent/dangling-escape.ts", ["*"], "write"), false);
    // Symlink targets containing intermediate symlink + '..' (a -> b/../escaped.ts) are blocked.
    assert.equal(isPathAllowedByScope(cwd, "src/agent/a", ["src/agent"], "write"), false);
    assert.equal(isPathAllowedByScope(cwd, "src/agent/a", ["*"], "write"), false);
    // Batch edit tools follow symlinks before '..' (src/agent/b/../secrets.txt -> outside/secrets.txt).
    assert.match(
      checkToolCallScope(cwd, ["src/agent"], "write_files", {
        files: [{ path: "src/agent/b/../secrets.txt" }],
      }) ?? "",
      /blocks editing/u,
    );
    assert.match(
      checkToolCallScope(cwd, ["*"], "apply_patch", {
        input: "*** Begin Patch\n*** Add File: src/agent/b/../patched.txt\n*** End Patch",
      }) ?? "",
      /blocks editing/u,
    );
    // In-cwd symlinked scope entries match both the symlink path and its canonical target.
    assert.equal(isPathAllowedByScope(cwd, ".eslintrc.json", [".eslintrc.json"], "edit"), true);
    // Pi native edit/write @, ~, and file:// path forms cannot escape cwd.
    assert.equal(isPathAllowedByScope(cwd, "@../outside/x.ts", ["*"], "write"), false);
    assert.equal(isPathAllowedByScope(cwd, "~/outside.ts", ["*"], "write"), false);
    assert.equal(
      isPathAllowedByScope(cwd, `file://${path.join(outside, "x.ts")}`, ["*"], "edit"),
      false,
    );
    assert.equal(isPathAllowedByScope(cwd, "@src/agent/index.ts", ["src/agent"], "edit"), true);

    assert.match(
      checkToolCallScope(cwd, [], "edit", { path: "src/agent/index.ts" }) ?? "",
      /disables file-edit tools/u,
    );
    assert.equal(
      checkToolCallScope(cwd, ["src/agent"], "write_files", {
        files: [{ path: "src/agent/overseer.ts" }],
      }),
      undefined,
    );
    assert.match(
      checkToolCallScope(cwd, ["src/agent"], "apply_patch", {
        input:
          "*** Begin Patch\n*** Update File: src/agent/overseer.ts\n*** Add File: README.md\n*** End Patch",
      }) ?? "",
      /blocks editing README\.md/u,
    );
  },
);

nodeTest(
  "prepareLaunch resolves overseer default worker with thinking suffix and persists contract",
  async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-launch-"));
    t.after(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const makeModel = (id: string, name: string): Model<Api> => ({
      id,
      name,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
    const hydrogen = makeModel("gemini-4-hydrogen", "Gemini 4 Hydrogen");
    const carbon = makeModel("gemini-4-carbon", "Gemini 4 Carbon");
    const models = [hydrogen, carbon];
    const parentSession = SessionManager.create(tempDir, tempDir);
    const context = {
      cwd: tempDir,
      isProjectTrusted: () => true,
      model: carbon,
      modelRegistry: {
        find: (provider: string, id: string) =>
          models.find((entry) => entry.provider === provider && entry.id === id),
        getAll: () => models,
      },
      sessionManager: parentSession,
    };
    const contract = normalizeDelegationContract({
      scope: ["src/db.ts"],
      verification: ["npm test"],
      requiredPrimitives: ["DatabaseSync.createTagStore()"],
    });
    fs.mkdirSync(path.join(tempDir, "src"));
    const base = path.join(tempDir, "runs");
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    // Default worker (`inherit`) keeps normal delegate model and thinking inheritance.
    const inherited = await prepareLaunch({
      input: { prompt: "Implement tag store query" },
      context,
      base,
      owner: "parent-session",
      agentDir: getPiAgentDir(),
      thinking: "medium",
      executionCwd: tempDir,
      ...splitWorkerSpec(DEFAULT_OVERSEER_WORKER),
      contract,
      overseer: { enabled: true, judge: "auto" },
    });
    assert.equal(inherited.provider, "google");
    assert.equal(inherited.model, "gemini-4-carbon");
    assert.equal(inherited.thinking, "medium");
    assert.deepEqual(inherited.overseer, { enabled: true, judge: "auto" });
    assert.deepEqual(inherited.contract?.scope, ["src/db.ts"]);
    assert.deepEqual(
      read(path.join(base, inherited.id, "launch.json"), launchSchema)?.contract,
      contract,
    );

    // Configuring an explicit overseer worker (`provider/model:thinking`) overrides omitted model/thinking.
    const launch = await prepareLaunch({
      input: { prompt: "Implement tag store query on worker" },
      context,
      base,
      owner: "parent-session",
      agentDir: getPiAgentDir(),
      thinking: "medium",
      executionCwd: tempDir,
      ...splitWorkerSpec("google/gemini-4-hydrogen:xhigh"),
      contract,
      overseer: { enabled: true, judge: "auto" },
    });
    assert.equal(launch.provider, "google");
    assert.equal(launch.model, "gemini-4-hydrogen");
    assert.equal(launch.thinking, "xhigh");

    // Explicit per-call thinking overrides a configured worker's :xhigh suffix without conflict.
    const overridden = await prepareLaunch({
      input: { prompt: "Quick tweak", thinking: "low" },
      context,
      base,
      owner: "parent-session",
      agentDir: getPiAgentDir(),
      thinking: "medium",
      executionCwd: tempDir,
      ...splitWorkerSpec("google/gemini-4-hydrogen:xhigh"),
      contract,
      overseer: { enabled: true, judge: "auto" },
    });
    assert.equal(overridden.model, "gemini-4-hydrogen");
    assert.equal(overridden.thinking, "low");
  },
);
