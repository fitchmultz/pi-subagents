import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { validateToolArguments, type Api, type Model } from "@earendil-works/pi-ai";
import agents from "../../src/agent/index.ts";
import {
  commandSchema,
  escalationResolutionSchema,
  launchSchema,
  overseerLiveStateSchema,
  type Launch,
} from "../../src/agent/contracts.ts";
import { childRuntime } from "../../src/agent/child-runtime.ts";
import { loadSDK, packageRoot } from "../../src/agent/host.ts";
import {
  activeOverseer,
  DEFAULT_OVERSEER_MODEL,
  OVERSEER_ENTRY_TYPE,
  OVERSEER_STATE_FILE,
  splitModelSpec,
} from "../../src/agent/overseer.ts";
import {
  activeContract,
  prepareContractAmendment,
  readContractAmendments,
  recordContractAmendment,
  successorContractOptions,
} from "../../src/agent/overseer-contract.ts";
import {
  checkToolCallScope,
  formatContractSection,
  isPathAllowedByScope,
  normalizeDelegationContract,
  validateDelegationScope,
} from "../../src/agent/overseer-scope.ts";
import { prepareLaunch } from "../../src/agent/launch.ts";
import { ownIdentity } from "../../src/agent/process.ts";
import { readReview } from "../../src/agent/overseer-review.ts";
import { harnessExcludePaths } from "../../src/agent/overseer-sentinel.ts";
import {
  ownerDirectory,
  read,
  runDirectory,
  scratchDirectory,
  successor,
  write,
} from "../../src/agent/storage.ts";
import { renderInspection } from "../../src/agent/view.ts";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";
import { loadConfig } from "../../src/pi-intercom/config.ts";
import { IntercomOutbound } from "../../src/pi-intercom/outbound.ts";
import { ReplyTracker } from "../../src/pi-intercom/reply-tracker.ts";
import { nativePeerId } from "../../src/pi-intercom/session-targets.ts";
import { validateIntercomArguments } from "../../src/pi-intercom/tool-arguments.ts";
import type { IntercomTransport } from "../../src/pi-intercom/transport.ts";
import {
  AMEND_CHILD_CONTRACT,
  type ChildContractAmendmentResult,
  type ChildContractTarget,
  type ContractAmendmentInput,
} from "../../src/shared/child-contract.ts";
import { isRecord } from "../../src/shared/unknown.ts";

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
  let capturedPi: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getPiAgentDir(),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      agents,
      (pi) => {
        capturedPi = pi;
      },
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.at(0);
  assert.ok(extension !== undefined);
  assert.ok(capturedPi !== undefined);

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
    pi: capturedPi,
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
    callTool: async (name: string, params: Record<string, unknown>): Promise<unknown> => {
      const tool = extension.tools.get(name);
      assert.ok(tool !== undefined, `missing tool ${name}`);
      const execute = tool.definition.execute.bind(tool.definition);
      return Reflect.apply(execute, tool.definition, ["call-1", params, undefined, undefined, ctx]);
    },
  };
}

nodeTest(
  "overseer mode stays inert when off and persists branch-scoped toggle, model, and judge state",
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

    await harness.runCommand("overseer-model", "openai/gpt-6-sol:medium");
    // Footer stays a clean `overseer` label even when a custom model is set.
    assert.equal(harness.statuses.get("overseer"), "overseer");
    assert.deepEqual(harness.getBranch().at(-1)?.data, {
      version: 1,
      enabled: true,
      model: "openai/gpt-6-sol:medium",
      judge: "auto",
    });
    await harness.runCommand("overseer-model", "inherit");
    assert.equal(harness.statuses.get("overseer"), "overseer");
    assert.deepEqual(harness.getBranch().at(-1)?.data, {
      version: 1,
      enabled: true,
      model: "inherit",
      judge: "auto",
    });
    assert.deepEqual(harness.notices.at(-1), {
      message: "Overseer model set to inherit",
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

    // Settings `subagents.overseer.model: "INHERIT"` normalizes to `inherit` and splitModelSpec omits defaultModel/defaultThinking.
    const configured = await createHarness(t, "overseer-settings", {
      subagents: { overseer: { enabled: true, model: "INHERIT" } },
    });
    await configured.start();
    await configured.runCommand("overseer-model", "status");
    assert.deepEqual(configured.notices.at(-1), {
      message: "Overseer model: inherit",
      level: "info",
    });
    assert.deepEqual(splitModelSpec("INHERIT"), {});

    // Historical branch entries with `worker` still replay cleanly onto `model`.
    configured.setBranch([
      {
        type: "custom",
        customType: OVERSEER_ENTRY_TYPE,
        data: { version: 1, enabled: true, worker: "openai/gpt-6-sol:low", judge: "auto" },
      },
    ]);
    await configured.tree();
    await configured.runCommand("overseer-model", "status");
    assert.deepEqual(configured.notices.at(-1), {
      message: "Overseer model: openai/gpt-6-sol:low",
      level: "info",
    });

    // Legacy `subagents.overseer.worker` settings continue to load onto `model` on upgrade.
    const legacySettings = await createHarness(t, "overseer-legacy-settings", {
      subagents: { overseer: { enabled: true, worker: "openai/gpt-6-sol:medium" } },
    });
    await legacySettings.start();
    await legacySettings.runCommand("overseer-model", "status");
    assert.deepEqual(legacySettings.notices.at(-1), {
      message: "Overseer model: openai/gpt-6-sol:medium",
      level: "info",
    });
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
      checkToolCallScope({ cwd, scope: ["src/agent"] }, "write_files", {
        files: [{ path: "src/agent/b/../secrets.txt" }],
      }) ?? "",
      /blocks editing/u,
    );
    assert.match(
      checkToolCallScope({ cwd, scope: ["*"] }, "apply_patch", {
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
      checkToolCallScope({ cwd, scope: [] }, "edit", { path: "src/agent/index.ts" }) ?? "",
      /disables file-edit tools/u,
    );
    assert.equal(
      checkToolCallScope({ cwd, scope: ["src/agent"] }, "write_files", {
        files: [{ path: "src/agent/overseer.ts" }],
      }),
      undefined,
    );
    assert.match(
      checkToolCallScope({ cwd, scope: ["src/agent"] }, "apply_patch", {
        input:
          "*** Begin Patch\n*** Update File: src/agent/overseer.ts\n*** Add File: README.md\n*** End Patch",
      }) ?? "",
      /blocks editing README\.md/u,
    );
  },
);

nodeTest(
  "prepareLaunch resolves overseer default model with thinking suffix and persists contract",
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
      ...splitModelSpec(DEFAULT_OVERSEER_MODEL),
      contract,
      overseer: { enabled: true, judge: "auto" },
    });
    assert.equal(inherited.provider, "google");
    assert.equal(inherited.model, "gemini-4-carbon");
    assert.equal(inherited.thinking, "medium");
    assert.deepEqual(inherited.overseer, { enabled: true, judge: "auto" });
    assert.deepEqual(inherited.contract?.scope, ["src/db.ts"]);
    assert.equal(inherited.scratchDir, path.join(base, inherited.id, "scratch"));
    assert.equal(fs.statSync(inherited.scratchDir).isDirectory(), true);
    assert.deepEqual(
      read(path.join(base, inherited.id, "launch.json"), launchSchema)?.contract,
      contract,
    );
    assert.equal(
      read(path.join(base, inherited.id, "launch.json"), launchSchema)?.scratchDir,
      inherited.scratchDir,
    );
    assert.match(
      renderInspection(base, inherited).content[0]?.text ?? "",
      new RegExp(
        `Scratch directory: ${inherited.scratchDir.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
        "u",
      ),
    );

    // Successor continuations inherit the exact same per-conversation scratchDir.
    const continued = successor(base, inherited, "Continue implementation");
    assert.ok(continued !== undefined);
    assert.equal(continued.rootId, inherited.rootId);
    assert.equal(continued.scratchDir, inherited.scratchDir);

    // Launches without a contract do not allocate a scratch directory.
    const unconstrained = await prepareLaunch({
      input: { prompt: "Unconstrained run" },
      context,
      base,
      owner: "parent-session",
      agentDir: getPiAgentDir(),
      thinking: "medium",
      executionCwd: tempDir,
    });
    assert.equal(unconstrained.scratchDir, undefined);
    assert.equal(fs.existsSync(path.join(base, unconstrained.id, "scratch")), false);

    // Configuring an explicit overseer model (`provider/model:thinking`) overrides omitted model/thinking.
    const launch = await prepareLaunch({
      input: { prompt: "Implement tag store query" },
      context,
      base,
      owner: "parent-session",
      agentDir: getPiAgentDir(),
      thinking: "medium",
      executionCwd: tempDir,
      ...splitModelSpec("google/gemini-4-hydrogen:xhigh"),
      contract,
      overseer: { enabled: true, judge: "auto" },
    });
    assert.equal(launch.provider, "google");
    assert.equal(launch.model, "gemini-4-hydrogen");
    assert.equal(launch.thinking, "xhigh");

    // Explicit per-call thinking overrides a configured model's :xhigh suffix without conflict.
    const overridden = await prepareLaunch({
      input: { prompt: "Quick tweak", thinking: "low" },
      context,
      base,
      owner: "parent-session",
      agentDir: getPiAgentDir(),
      thinking: "medium",
      executionCwd: tempDir,
      ...splitModelSpec("google/gemini-4-hydrogen:xhigh"),
      contract,
      overseer: { enabled: true, judge: "auto" },
    });
    assert.equal(overridden.model, "gemini-4-hydrogen");
    assert.equal(overridden.thinking, "low");

    // Invalid glob static prefix fails fast before creating a run directory.
    const runsBefore = fs.readdirSync(base).sort();
    await assert.rejects(
      prepareLaunch({
        input: { prompt: "Typo glob" },
        context,
        base,
        owner: "parent-session",
        agentDir: getPiAgentDir(),
        thinking: "medium",
        executionCwd: tempDir,
        contract: normalizeDelegationContract({
          scope: ["nonexistent/**"],
          verification: ["npm test"],
        }),
        overseer: { enabled: true, judge: "auto" },
      }),
      /needs an existing directory "nonexistent"/u,
    );
    assert.deepEqual(fs.readdirSync(base).sort(), runsBefore);
  },
);

nodeTest(
  "contract.scope supports POSIX globs, validates static prefixes fail-fast, and blocks escapes",
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-glob-scope-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
    const cwd = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(cwd, "src", "agent"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "test", "unit", "deep"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "packages", "api", "src"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "existing.ts"), "export const ok = true;\n");
    fs.symlinkSync(outside, path.join(cwd, "src", "agent", "escaped"));
    fs.symlinkSync(
      path.join(outside, "missing.ts"),
      path.join(cwd, "src", "agent", "dangling-escape.ts"),
    );
    fs.symlinkSync("src", path.join(cwd, "link-src"));

    // Normalization handles POSIX globs, leading ./, trailing /, and backslashes.
    const normalized = normalizeDelegationContract({
      scope: [
        "./src/**/",
        "test\\**\\*.test.ts",
        "packages/*/src/**",
        "{src,test}/**",
        "*.ts",
        "src/agent/?.ts",
      ],
      verification: ["npm test"],
    });
    assert.deepEqual(normalized.scope, [
      "src/**",
      "test/**/*.test.ts",
      "packages/*/src/**",
      "{src,test}/**",
      "*.ts",
      "src/agent/?.ts",
    ]);

    // Traversal and absolute paths in globs (including brace expressions) fail fast.
    for (const invalid of [
      "../**",
      "./../**",
      "src/../**",
      "src/agent/../../**",
      "{src,../outside}/**",
      "{../outside,src}/**",
    ]) {
      assert.throws(
        () => normalizeDelegationContract({ scope: [invalid], verification: ["npm test"] }),
        /without '\.\.' traversal/u,
        `expected traversal rejection for ${invalid}`,
      );
    }
    for (const invalid of ["", "   ", "./", "/etc/**", "{/etc,src}/**", "{src,/etc}/**"]) {
      assert.throws(
        () => normalizeDelegationContract({ scope: [invalid], verification: ["npm test"] }),
        /relative paths or globs/u,
        `expected relative-path rejection for ${JSON.stringify(invalid)}`,
      );
    }

    // Valid globs pass launch-time static prefix validation.
    validateDelegationScope(cwd, [
      "src/**",
      "test/**/*.test.ts",
      "packages/*/src/**",
      "{src,test}/**",
      "*.ts",
      "src/agent/?.ts",
      "link-src/**",
    ]);

    // Nonexistent static prefixes, file prefixes, and escaping symlink prefixes fail fast.
    assert.throws(
      () => validateDelegationScope(cwd, ["nonexistent/**"]),
      /needs an existing directory "nonexistent"/u,
    );
    assert.throws(
      () => validateDelegationScope(cwd, ["src/nonexistent/**"]),
      /needs an existing directory "src\/nonexistent"/u,
    );
    assert.throws(
      () => validateDelegationScope(cwd, ["src/existing.ts/**"]),
      /needs an existing directory "src\/existing\.ts"/u,
    );
    assert.throws(
      () => validateDelegationScope(cwd, ["src/agent/escaped/**"]),
      /does not resolve inside cwd/u,
    );

    // dir/** matches direct children and nested descendants, not sibling prefixes or other dirs.
    assert.equal(isPathAllowedByScope(cwd, "src/file.ts", ["src/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/sub/file.ts", ["src/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/a/b/c.ts", ["src/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src-extra/file.ts", ["src/**"]), false);
    assert.equal(isPathAllowedByScope(cwd, "README.md", ["src/**"]), false);

    // test/**/*.test.ts matches root and nested test files, not non-test files.
    assert.equal(isPathAllowedByScope(cwd, "test/root.test.ts", ["test/**/*.test.ts"]), true);
    assert.equal(isPathAllowedByScope(cwd, "test/unit/foo.test.ts", ["test/**/*.test.ts"]), true);
    assert.equal(
      isPathAllowedByScope(cwd, "test/unit/deep/bar.test.ts", ["test/**/*.test.ts"]),
      true,
    );
    assert.equal(isPathAllowedByScope(cwd, "test/unit/helper.ts", ["test/**/*.test.ts"]), false);

    // packages/*/src/**, *.ts, {src,test}/**, and ? match as POSIX globs.
    assert.equal(
      isPathAllowedByScope(cwd, "packages/api/src/index.ts", ["packages/*/src/**"]),
      true,
    );
    assert.equal(
      isPathAllowedByScope(cwd, "packages/api/src/sub/index.ts", ["packages/*/src/**"]),
      true,
    );
    assert.equal(
      isPathAllowedByScope(cwd, "packages/api/test/index.ts", ["packages/*/src/**"]),
      false,
    );
    assert.equal(
      isPathAllowedByScope(cwd, "packages/a/b/src/index.ts", ["packages/*/src/**"]),
      false,
    );
    assert.equal(isPathAllowedByScope(cwd, "index.ts", ["*.ts"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/index.ts", ["*.ts"]), false);
    assert.equal(isPathAllowedByScope(cwd, "src/a.ts", ["{src,test}/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "test/unit/b.ts", ["{src,test}/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "docs/guide.md", ["{src,test}/**"]), false);
    assert.equal(isPathAllowedByScope(cwd, "src/a.ts", ["src/?.ts"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/ab.ts", ["src/?.ts"]), false);
    // Non-existent literal dynamic-route paths with brackets stay literal without widening.
    assert.doesNotThrow(() => validateDelegationScope(cwd, ["[id].ts", "src/app/[slug]/page.tsx"]));
    assert.equal(isPathAllowedByScope(cwd, "[id].ts", ["[id].ts"]), true);
    assert.equal(isPathAllowedByScope(cwd, "i.ts", ["[id].ts"]), false);
    assert.equal(isPathAllowedByScope(cwd, "src/[slug].ts", ["src/[slug].ts"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/s.ts", ["src/[slug].ts"]), false);
    assert.equal(
      isPathAllowedByScope(cwd, "src/app/[slug]/page.tsx", ["src/app/[slug]/page.tsx"]),
      true,
    );
    assert.equal(
      isPathAllowedByScope(cwd, "src/app/s/page.tsx", ["src/app/[slug]/page.tsx"]),
      false,
    );
    assert.equal(
      checkToolCallScope({ cwd, scope: ["src/app/[slug]/page.tsx"] }, "write", {
        path: "src/app/[slug]/page.tsx",
      }),
      undefined,
    );
    assert.equal(
      isPathAllowedByScope(cwd, "src/app/[slug]/page.tsx", ["src/*/[slug]/page.tsx"]),
      true,
    );
    assert.equal(isPathAllowedByScope(cwd, "src/app/s/page.tsx", ["src/*/[slug]/page.tsx"]), false);
    assert.throws(
      () => validateDelegationScope(cwd, ["src/app/[new-slug]/**"]),
      /needs an existing directory "src\/app\/\[new-slug\]"/u,
    );

    // Wildcard globs match dotfiles just like literal prefixes without widening non-dot prefixes.
    assert.equal(isPathAllowedByScope(cwd, "src/.env.example", ["src/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/.gitignore", ["src/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/sub/.hidden/b.ts", ["src/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, ".github/workflows/ci.yml", ["**"]), true);
    assert.equal(isPathAllowedByScope(cwd, ".github/workflows/ci.yml", [".github/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/.a.ts", ["src/a*"]), false);
    assert.equal(isPathAllowedByScope(cwd, "src/.env.example", ["src/.env*"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/env.example", ["src/.env*"]), false);

    // Existing dynamic-route directories/files with brackets stay literal (no glob widening, `[id]/**` works).
    fs.mkdirSync(path.join(cwd, "src", "app", "[id]"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "src", "app", "[...slug]"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "app", "[id]", "page.tsx"), "");
    fs.writeFileSync(path.join(cwd, "src", "app", "[...slug]", "page.tsx"), "");
    assert.doesNotThrow(() => validateDelegationScope(cwd, ["src/app/[id]/page.tsx"]));
    assert.doesNotThrow(() => validateDelegationScope(cwd, ["src/app/[id]/**"]));
    assert.equal(
      isPathAllowedByScope(cwd, "src/app/[id]/page.tsx", ["src/app/[id]/page.tsx"]),
      true,
    );
    assert.equal(isPathAllowedByScope(cwd, "src/app/i/page.tsx", ["src/app/[id]/page.tsx"]), false);
    assert.equal(isPathAllowedByScope(cwd, "src/app/d/page.tsx", ["src/app/[id]/page.tsx"]), false);
    assert.equal(
      isPathAllowedByScope(cwd, "src/app/s/page.tsx", ["src/app/[...slug]/page.tsx"]),
      false,
    );
    assert.equal(isPathAllowedByScope(cwd, "src/app/[id]/page.tsx", ["src/app/[id]/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/app/[id]/nested/b.tsx", ["src/app/[id]/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/app/i/page.tsx", ["src/app/[id]/**"]), false);

    // In-cwd symlink prefix works; symlink escapes outside cwd stay blocked under globs.
    assert.equal(isPathAllowedByScope(cwd, "link-src/agent/index.ts", ["link-src/**"]), true);
    assert.equal(isPathAllowedByScope(cwd, "src/agent/escaped/secret.ts", ["src/**"]), false);
    assert.equal(
      isPathAllowedByScope(cwd, "src/agent/dangling-escape.ts", ["src/**"], "write"),
      false,
    );
    assert.equal(isPathAllowedByScope(cwd, "../outside/secret.ts", ["**"]), false);
    assert.equal(
      checkToolCallScope({ cwd, scope: ["src/**", "test/**/*.test.ts"] }, "apply_patch", {
        input:
          "*** Begin Patch\n*** Update File: src/agent/overseer.ts\n*** Add File: test/unit/new.test.ts\n*** End Patch",
      }),
      undefined,
    );
    assert.match(
      checkToolCallScope({ cwd, scope: ["src/**", "test/**/*.test.ts"] }, "apply_patch", {
        input:
          "*** Begin Patch\n*** Update File: src/agent/overseer.ts\n*** Add File: test/unit/helper.ts\n*** End Patch",
      }) ?? "",
      /blocks editing test\/unit\/helper\.ts/u,
    );
  },
);

nodeTest(
  "per-run scratch directory allows edit tools inside scratchDir while blocking escapes and keeping repo scope strict",
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-scratch-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
    const cwd = path.join(root, "worktree");
    const runDir = path.join(root, "runs", "run-1");
    const scratchDir = path.join(runDir, "scratch");
    const siblingDir = path.join(runDir, "scratch-evil");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(cwd, "README.md"), "repo readme\n");
    fs.symlinkSync(outside, path.join(scratchDir, "escaped"));
    fs.symlinkSync(path.join(cwd, "README.md"), path.join(scratchDir, "readme-link.md"));
    fs.symlinkSync(
      path.join(outside, "dangling.txt"),
      path.join(scratchDir, "dangling-escape.txt"),
    );

    const scope = ["src/**"];
    const mutatingCtx = { cwd, scope, scratchDir };
    const readOnlyCtx = { cwd, scope: [] as const, scratchDir };

    // All edit tools succeed inside scratchDir (direct and nested) for both mutating and scope: [] runs.
    for (const ctx of [mutatingCtx, readOnlyCtx]) {
      assert.equal(
        checkToolCallScope(ctx, "write", { path: path.join(scratchDir, "probe.mjs") }),
        undefined,
      );
      assert.equal(
        checkToolCallScope(ctx, "edit", { path: path.join(scratchDir, "nested", "notes.md") }),
        undefined,
      );
      assert.equal(
        checkToolCallScope(ctx, "replace_text", {
          files: [{ path: path.join(scratchDir, "probe.mjs") }],
        }),
        undefined,
      );
      assert.equal(
        checkToolCallScope(ctx, "write_files", {
          files: [
            { path: path.join(scratchDir, "a.ts") },
            { path: path.join(scratchDir, "sub", "b.ts") },
          ],
        }),
        undefined,
      );
      assert.equal(
        checkToolCallScope(ctx, "apply_patch", {
          input: `*** Begin Patch\n*** Add File: ${path.join(scratchDir, "script.mjs")}\n*** End Patch`,
        }),
        undefined,
      );
    }

    // Escapes out of scratchDir (.., sibling prefix, symlinks, arbitrary /tmp) are all blocked.
    for (const ctx of [mutatingCtx, readOnlyCtx]) {
      for (const badPath of [
        scratchDir,
        path.join(scratchDir, "..", "escape.txt"),
        path.join(scratchDir, "..", "launch.json"),
        path.join(scratchDir, "sub", "..", "..", "escape.txt"),
        path.join(siblingDir, "evil.txt"),
        path.join(outside, "arbitrary.txt"),
        path.join(os.tmpdir(), "arbitrary-outside.txt"),
        path.join(scratchDir, "escaped", "secret.txt"),
        path.join(scratchDir, "readme-link.md"),
        path.join(scratchDir, "dangling-escape.txt"),
      ]) {
        assert.equal(
          isPathAllowedByScope(cwd, badPath, ctx.scope, { toolName: "write", scratchDir }),
          false,
          `expected ${badPath} to be blocked`,
        );
        assert.ok(
          checkToolCallScope(ctx, "write", { path: badPath }) !== undefined,
          `expected write to ${badPath} to be blocked`,
        );
      }
      assert.ok(
        checkToolCallScope(ctx, "apply_patch", {
          input: `*** Begin Patch\n*** Add File: ${path.join(scratchDir, "..", "escape.txt")}\n*** End Patch`,
        }) !== undefined,
      );
    }

    // Mixed batch/patch with one scratch file and one out-of-scope repo file is blocked.
    assert.match(
      checkToolCallScope(mutatingCtx, "apply_patch", {
        input: `*** Begin Patch\n*** Add File: ${path.join(scratchDir, "ok.mjs")}\n*** Update File: README.md\n*** End Patch`,
      }) ?? "",
      /blocks editing README\.md/u,
    );
    // Mixed batch with one scratch file and one in-scope repo file succeeds.
    assert.equal(
      checkToolCallScope(mutatingCtx, "write_files", {
        files: [{ path: path.join(scratchDir, "ok.mjs") }, { path: "src/allowed.ts" }],
      }),
      undefined,
    );

    // Repo edits remain strictly governed by scope; scope: [] keeps its disables file-edit tools message.
    assert.equal(checkToolCallScope(mutatingCtx, "edit", { path: "src/allowed.ts" }), undefined);
    assert.match(
      checkToolCallScope(mutatingCtx, "edit", { path: "README.md" }) ?? "",
      /blocks editing README\.md/u,
    );
    assert.match(
      checkToolCallScope(readOnlyCtx, "edit", { path: "src/allowed.ts" }) ?? "",
      /disables file-edit tools/u,
    );
    assert.match(checkToolCallScope(readOnlyCtx, "write", {}) ?? "", /disables file-edit tools/u);

    // formatContractSection surfaces scratchDir and the no-/tmp rule for both mutating and read-only contracts.
    const mutatingSection = formatContractSection(
      { scope: ["src/**"], verification: ["npm test"] },
      { scratchDir },
    );
    assert.match(mutatingSection, /Scratch directory for temporary files\/scripts/u);
    assert.ok(mutatingSection.includes(scratchDir));
    assert.match(mutatingSection, /\$PI_SUBAGENT_SCRATCH_DIR/u);
    assert.match(mutatingSection, /rather than \/tmp/u);
    assert.match(mutatingSection, /edit tools block paths outside allowed scope/u);
    const readOnlySection = formatContractSection({ scope: [] }, { scratchDir });
    assert.match(readOnlySection, /edit tools allowed only in the scratch directory below/u);
    assert.ok(readOnlySection.includes(scratchDir));
    assert.match(readOnlySection, /\$PI_SUBAGENT_SCRATCH_DIR/u);
    assert.match(readOnlySection, /rather than \/tmp/u);
    const noScratchSection = formatContractSection({
      scope: ["src/**"],
      verification: ["npm test"],
    });
    assert.doesNotMatch(noScratchSection, /\$PI_SUBAGENT_SCRATCH_DIR|\/tmp/u);

    // A tampered launch.scratchDir pointing into the repo is ignored by scratchDirectory,
    // harnessExcludePaths, and successor (always anchored under <base>/<rootId>/scratch).
    const runsBase = path.join(root, "runs");
    const poisonedLaunch: Launch = {
      version: 1,
      id: "run-1",
      rootId: "run-1",
      owner: "owner-1",
      cwd,
      agentDir: path.join(root, "agent"),
      sdk: "/sdk",
      entry: "/entry.js",
      sessionFile: path.join(runDir, "session.jsonl"),
      sessionId: "sess-1",
      prompt: "initial",
      context: "fresh",
      provider: "google",
      model: "gemini-4-hydrogen",
      thinking: "medium",
      trusted: true,
      contract: { scope: [] },
      scratchDir: path.join(cwd, "src"),
      createdAt: Date.now(),
    };
    assert.equal(scratchDirectory(runsBase, poisonedLaunch), scratchDir);
    assert.equal(
      harnessExcludePaths(runsBase, poisonedLaunch).includes(path.join(cwd, "src")),
      false,
    );
    const nextLaunch = successor(runsBase, poisonedLaunch, "follow-up");
    assert.ok(nextLaunch !== undefined);
    assert.equal(nextLaunch.scratchDir, scratchDir);
  },
);

nodeTest(
  "prepareContractAmendment merges partial updates, clears optional fields, and validates fail-fast",
  (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-amend-"));
    t.after(() => {
      fs.rmSync(cwd, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "test", "unit"), { recursive: true });

    const initial = normalizeDelegationContract({
      scope: ["src"],
      verification: ["npm run test:unit"],
      baseBranch: "main",
      requiredPrimitives: ["OldApi"],
      nonGoals: ["No custom shims"],
    });

    // Partial scope widening preserves all unspecified fields.
    const widened = prepareContractAmendment(
      initial,
      { scope: ["src/**", "test/**/*.test.ts"] },
      cwd,
    );
    assert.deepEqual(widened.changedFields, ["scope"]);
    assert.deepEqual(widened.contract, {
      scope: ["src/**", "test/**/*.test.ts"],
      verification: ["npm run test:unit"],
      baseBranch: "main",
      requiredPrimitives: ["OldApi"],
      nonGoals: ["No custom shims"],
    });

    // Explicit empty arrays/strings clear optional fields cleanly.
    const cleared = prepareContractAmendment(
      widened.contract,
      { baseBranch: "", requiredPrimitives: [], nonGoals: [] },
      cwd,
    );
    assert.deepEqual(cleared.changedFields, ["baseBranch", "requiredPrimitives", "nonGoals"]);
    assert.deepEqual(cleared.contract, {
      scope: ["src/**", "test/**/*.test.ts"],
      verification: ["npm run test:unit"],
    });

    // Transitioning to read-only and back to mutating enforces verification.
    const readOnly = prepareContractAmendment(
      cleared.contract,
      { scope: [], verification: [] },
      cwd,
    );
    assert.deepEqual(readOnly.contract, { scope: [] });
    assert.throws(
      () => prepareContractAmendment(readOnly.contract, { scope: ["src/**"] }, cwd),
      /requires at least one verification check/u,
    );
    const mutatingAgain = prepareContractAmendment(
      readOnly.contract,
      { scope: ["src/**"], verification: ["npm test"] },
      cwd,
    );
    assert.deepEqual(mutatingAgain.contract, { scope: ["src/**"], verification: ["npm test"] });

    // Adding a contract to a run with no contract requires scope (and verification if mutating).
    assert.throws(
      () => prepareContractAmendment(undefined, { verification: ["npm test"] }, cwd),
      /requires scope/u,
    );
    const added = prepareContractAmendment(
      undefined,
      { scope: ["src/**"], verification: ["npm test"] },
      cwd,
    );
    assert.equal(added.previous, undefined);
    assert.deepEqual(added.contract, { scope: ["src/**"], verification: ["npm test"] });

    // Empty amendments and invalid scopes fail fast.
    assert.throws(() => prepareContractAmendment(initial, {}, cwd), /at least one field/u);
    assert.throws(
      () => prepareContractAmendment(initial, { scope: ["nonexistent/**"] }, cwd),
      /needs an existing directory "nonexistent"/u,
    );
    assert.throws(
      () => prepareContractAmendment(initial, { scope: ["../escape/**"] }, cwd),
      /without '\.\.' traversal/u,
    );
  },
);

function replyDetails(reply: unknown): Record<string, unknown> {
  assert.ok(isRecord(reply) && isRecord(reply.details));
  return reply.details;
}

function replyText(reply: unknown): string {
  assert.ok(isRecord(reply) && Array.isArray(reply.content));
  const first: unknown = reply.content[0];
  assert.ok(isRecord(first) && typeof first.text === "string");
  return first.text;
}

nodeTest(
  "agent_runs continue and review amend live contracts durably, fail fast on invalid scopes, and propagate to successors",
  async (t) => {
    const sessionId = "overseer-amend-parent";
    const harness = await createHarness(t, sessionId);
    await harness.start();

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-amend-run-"));
    t.after(() => {
      fs.rmSync(workdir, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(workdir, "src"), { recursive: true });
    fs.mkdirSync(path.join(workdir, "test", "unit"), { recursive: true });

    const base = ownerDirectory(getPiAgentDir(), sessionId);
    const runId = "run-live-amend";
    const dir = runDirectory(base, runId);
    const scratchDir = path.join(dir, "scratch");
    const sessionFile = path.join(dir, "child.jsonl");
    fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sessionFile, '{"type":"session","id":"child-1"}\n', { mode: 0o600 });
    const launch: Launch = {
      version: 1,
      id: runId,
      rootId: runId,
      owner: sessionId,
      cwd: workdir,
      agentDir: getPiAgentDir(),
      sdk: packageRoot(),
      entry: path.join(process.cwd(), "src/agent/index.ts"),
      sessionFile,
      sessionId: "child-1",
      prompt: "Initial task",
      context: "fresh",
      provider: "google",
      model: "gemini-4-hydrogen",
      thinking: "medium",
      trusted: true,
      name: "amend-worker",
      contract: {
        scope: ["src"],
        verification: ["npm run test:unit"],
        baseBranch: "main",
        requiredPrimitives: ["OldApi"],
        nonGoals: ["No custom shims"],
      },
      scratchDir,
      overseer: { enabled: true, judge: "auto" },
      createdAt: Date.now(),
    };
    write(path.join(dir, "launch.json"), launch, true);
    write(path.join(dir, "admissions", `${runId}.json`), {
      id: runId,
      runId,
      action: "run",
      state: "accepted",
      at: Date.now(),
    });
    const dummyActor = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    assert.ok(dummyActor.pid !== undefined);
    t.after(() => {
      dummyActor.kill("SIGKILL");
    });
    write(path.join(dir, "actor.lock", "process.json"), {
      ...ownIdentity(dummyActor.pid),
      token: "live-token",
    });

    // Unsupported actions reject contract fail-fast before touching disk.
    await assert.rejects(
      harness.callTool("agent_runs", { action: "list", contract: { scope: ["src"] } }),
      /only supported with action="continue"/u,
    );
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "review",
        id: runId,
        verdict: "approved",
        summary: "Looks good",
        contract: { scope: ["src"] },
      }),
      /only supported with action="continue"/u,
    );
    assert.equal(readReview(base, runId), undefined);

    // Invalid amended scope fails fast before writing contract.json, review.json, or commands.
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "continue",
        id: runId,
        prompt: "Widen to nonexistent",
        contract: { scope: ["nonexistent/**"] },
      }),
      /needs an existing directory "nonexistent"/u,
    );
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "review",
        id: runId,
        verdict: "changes_requested",
        summary: "Widen to nonexistent",
        contract: { scope: ["nonexistent/**"] },
      }),
      /needs an existing directory "nonexistent"/u,
    );
    assert.equal(fs.existsSync(path.join(dir, "contract.json")), false);
    assert.equal(readReview(base, runId), undefined);
    assert.equal(fs.existsSync(path.join(dir, "commands")), false);

    // Valid live continue amends contract durably and notifies the child in the steer prompt.
    const steered = replyDetails(
      await harness.callTool("agent_runs", {
        action: "continue",
        id: runId,
        prompt: "Also add unit tests in test/unit.",
        contract: { scope: ["src/**", "test/**/*.test.ts"] },
      }),
    );
    assert.ok(typeof steered.command === "string");
    assert.deepEqual(activeContract(base, launch), {
      scope: ["src/**", "test/**/*.test.ts"],
      verification: ["npm run test:unit"],
      baseBranch: "main",
      requiredPrimitives: ["OldApi"],
      nonGoals: ["No custom shims"],
    });
    assert.deepEqual(steered.contract, activeContract(base, launch));
    assert.equal("contractAmendments" in steered, false);
    const queued = read(path.join(dir, "commands", `${steered.command}.json`), commandSchema);
    assert.equal(queued?.action, "steer");
    assert.match(
      queued.prompt,
      /^\[Delegation contract updated: scope: src\/\*\*, test\/\*\*\/\*\.test\.ts\]\n\nAlso add unit tests in test\/unit\.$/u,
    );

    // review(verdict="changes_requested") also supports amending the contract in the same step.
    const reviewed = replyDetails(
      await harness.callTool("agent_runs", {
        action: "review",
        id: runId,
        verdict: "changes_requested",
        summary: "Switch to path.posix.matchesGlob.",
        contract: { requiredPrimitives: ["path.posix.matchesGlob"] },
      }),
    );
    assert.ok(typeof reviewed.command === "string");
    assert.equal(readReview(base, runId)?.verdict, "changes_requested");
    assert.deepEqual(activeContract(base, launch)?.requiredPrimitives, ["path.posix.matchesGlob"]);
    assert.equal(readContractAmendments(base, launch).length, 2);
    const reviewSteer = read(path.join(dir, "commands", `${reviewed.command}.json`), commandSchema);
    assert.equal(reviewSteer?.action, "steer");
    assert.match(
      reviewSteer.prompt,
      /^\[Delegation contract updated: requiredPrimitives: path\.posix\.matchesGlob\]\n\nSwitch to path\.posix\.matchesGlob\.$/u,
    );

    // inspect displays the active amended contract and full amendment history.
    const inspectText = replyText(
      await harness.callTool("agent_runs", {
        action: "inspect",
        id: runId,
      }),
    );
    assert.match(inspectText, /Contract: scope=src\/\*\*, test\/\*\*\/\*\.test\.ts/u);
    assert.match(inspectText, /requiredPrimitives=path\.posix\.matchesGlob/u);
    assert.match(inspectText, /Contract amendments \(2\):/u);

    // Successor without a new contract inherits the run's latest amended contract (not stale launch.json).
    const inheritedNext = successor(
      base,
      launch,
      "Finish up",
      successorContractOptions(base, launch, activeContract(base, launch)),
    );
    assert.ok(inheritedNext !== undefined);
    assert.deepEqual(inheritedNext.contract, activeContract(base, launch));
    assert.equal(inheritedNext.scratchDir, scratchDir);

    // Successor with a new amendment persists both launch.json and contract.json history.
    const nextAmendment = prepareContractAmendment(
      activeContract(base, inheritedNext),
      { nonGoals: [] },
      workdir,
    );
    const amendedNext = successor(
      base,
      inheritedNext,
      "Clear non-goals and continue",
      successorContractOptions(
        base,
        inheritedNext,
        activeContract(base, inheritedNext),
        nextAmendment,
      ),
    );
    assert.ok(amendedNext !== undefined);
    assert.equal(amendedNext.contract?.nonGoals, undefined);
    assert.deepEqual(amendedNext.contract?.scope, ["src/**", "test/**/*.test.ts"]);
    assert.equal(readContractAmendments(base, amendedNext).length, 1);
    assert.match(
      renderInspection(base, amendedNext).content[0]?.text ?? "",
      /Contract amendments \(1\):.*nonGoals: \(cleared\)/su,
    );
  },
);

nodeTest(
  "childRuntime dynamically reloads amended contracts on tool_call and before_agent_start without restart",
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-child-reload-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
    const cwd = path.join(root, "repo");
    const base = path.join(root, "runs");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "test", "unit"), { recursive: true });

    const sdkRoot = packageRoot();
    const sdk = await loadSDK(sdkRoot);
    const run1Id = "child-reload-1";
    const run1Dir = runDirectory(base, run1Id);
    const scratchDir = path.join(run1Dir, "scratch");
    fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    const sessionManager = sdk.SessionManager.create(cwd, run1Dir);
    const sessionFile = sessionManager.getSessionFile();
    assert.ok(sessionFile !== undefined);
    fs.writeFileSync(sessionFile, `${JSON.stringify(sessionManager.getHeader())}\n`, {
      mode: 0o600,
    });

    const launch1: Launch = {
      version: 1,
      id: run1Id,
      rootId: run1Id,
      owner: "parent-1",
      cwd,
      agentDir: getPiAgentDir(),
      sdk: sdkRoot,
      entry: path.join(process.cwd(), "src/agent/index.ts"),
      sessionFile,
      sessionId: sessionManager.getSessionId(),
      prompt: "Implement feature",
      context: "fresh",
      provider: "openai",
      model: "gpt-5.4",
      thinking: "low",
      trusted: true,
      contract: { scope: ["src"], verification: ["npm test"] },
      scratchDir,
      createdAt: Date.now(),
    };
    write(path.join(run1Dir, "launch.json"), launch1, true);

    let currentLaunch = launch1;
    const seenEvents: string[] = [];
    const factory = childRuntime(sdk, launch1, {
      directory: run1Dir,
      token: "reload-token",
      activeLaunch: () => currentLaunch,
      saved: undefined,
      started: () => {
        seenEvents.push("started");
      },
      tool: (event) => {
        seenEvents.push(event.toolName);
      },
    });
    const runtime = await sdk.createAgentSessionRuntime(factory, {
      sessionManager,
      cwd,
      agentDir: getPiAgentDir(),
    });
    t.after(async () => {
      await runtime.dispose();
    });
    const guardExt = runtime.services.resourceLoader
      .getExtensions()
      .extensions.find(
        (ext) =>
          ext.handlers.has("tool_execution_start") &&
          ext.handlers.has("before_agent_start") &&
          ext.handlers.has("tool_call"),
      );
    assert.ok(guardExt !== undefined);

    const runBeforeStart = async () => {
      const sections: Record<string, string> = {};
      for (const handler of guardExt.handlers.get("before_agent_start") ?? []) {
        await handler({ type: "before_agent_start", systemPromptOptions: { sections } }, {});
      }
      return sections;
    };
    const runToolCall = async (toolName: string, input: Record<string, unknown>) => {
      for (const handler of guardExt.handlers.get("tool_call") ?? []) {
        const res: unknown = await handler({ type: "tool_call", toolName, input }, {});
        if (isRecord(res)) {
          return res;
        }
      }
      return;
    };

    // Before amendment: src/ and scratchDir are allowed; test/ is blocked.
    const initialSections = await runBeforeStart();
    const roleSection = initialSections.delegation_role;
    assert.ok(roleSection !== undefined);
    assert.match(roleSection, /delegated subagent reporting results to your parent session/u);
    assert.match(roleSection, /not speaking directly to the user/u);
    assert.match(roleSection, /Do not merge PRs, deploy, push/u);
    assert.ok(
      Object.keys(initialSections).indexOf("delegation_role") <
        Object.keys(initialSections).indexOf("delegation_contract"),
    );
    assert.match(initialSections.delegation_contract ?? "", /Allowed edit scope: src$/mu);
    assert.equal(await runToolCall("write", { path: "src/a.ts" }), undefined);
    assert.equal(
      await runToolCall("write", { path: path.join(scratchDir, "probe.mjs") }),
      undefined,
    );
    assert.equal((await runToolCall("write", { path: "test/unit/a.test.ts" }))?.block, true);

    // Amend R1 durably on disk while the child runtime stays live.
    recordContractAmendment(
      base,
      run1Id,
      prepareContractAmendment(
        launch1.contract,
        {
          scope: ["src/**", "test/**/*.test.ts"],
          requiredPrimitives: ["path.posix.matchesGlob"],
        },
        cwd,
      ),
    );

    // Without restarting the child runtime, tool_call and before_agent_start honor the new contract immediately.
    assert.equal(await runToolCall("write", { path: "test/unit/a.test.ts" }), undefined);
    assert.equal((await runToolCall("write", { path: "README.md" }))?.block, true);
    const amendedSections = await runBeforeStart();
    assert.equal(amendedSections.delegation_role, roleSection);
    assert.match(
      amendedSections.delegation_contract ?? "",
      /Allowed edit scope: src\/\*\*, test\/\*\*\/\*\.test\.ts/u,
    );
    assert.match(amendedSections.delegation_contract ?? "", /path\.posix\.matchesGlob/u);
    assert.match(amendedSections.delegation_contract ?? "", /Latest contract amendment:/u);

    // Resident actor switching to a successor launch picks up the successor's contract immediately.
    const launch2 = successor(
      base,
      launch1,
      "Switch to read-only analysis",
      successorContractOptions(
        base,
        launch1,
        activeContract(base, launch1),
        prepareContractAmendment(activeContract(base, launch1), { scope: [] }, cwd),
      ),
    );
    assert.ok(launch2 !== undefined);
    currentLaunch = launch2;
    assert.equal((await runToolCall("write", { path: "src/a.ts" }))?.block, true);
    assert.equal(
      await runToolCall("write", { path: path.join(scratchDir, "notes.md") }),
      undefined,
    );
    const successorSections = await runBeforeStart();
    assert.equal(successorSections.delegation_role, roleSection);
    assert.match(
      successorSections.delegation_contract ?? "",
      /edit tools allowed only in the scratch directory below/u,
    );

    // A run that started with no contract still gets the cache-stable child role framing and enforces a newly added contract immediately.
    const unconstrainedId = "child-reload-unconstrained";
    const unconstrainedDir = runDirectory(base, unconstrainedId);
    fs.mkdirSync(unconstrainedDir, { recursive: true, mode: 0o700 });
    const { contract: _contract, scratchDir: _scratchDir, ...baseLaunch } = launch1;
    const unconstrainedLaunch: Launch = {
      ...baseLaunch,
      id: unconstrainedId,
      rootId: unconstrainedId,
    };
    write(path.join(unconstrainedDir, "launch.json"), unconstrainedLaunch, true);
    const priorScratchEnv = process.env.PI_SUBAGENT_SCRATCH_DIR;
    t.after(() => {
      if (priorScratchEnv === undefined) {
        delete process.env.PI_SUBAGENT_SCRATCH_DIR;
      } else {
        process.env.PI_SUBAGENT_SCRATCH_DIR = priorScratchEnv;
      }
    });
    currentLaunch = unconstrainedLaunch;
    const unconstrainedSections = await runBeforeStart();
    assert.equal(unconstrainedSections.delegation_role, roleSection);
    assert.equal(unconstrainedSections.delegation_contract, undefined);
    assert.equal(process.env.PI_SUBAGENT_SCRATCH_DIR, undefined);
    assert.equal(await runToolCall("write", { path: "README.md" }), undefined);

    recordContractAmendment(
      base,
      unconstrainedId,
      prepareContractAmendment(undefined, { scope: ["src/**"], verification: ["npm test"] }, cwd),
    );
    assert.equal((await runToolCall("write", { path: "README.md" }))?.block, true);
    assert.equal(process.env.PI_SUBAGENT_SCRATCH_DIR, scratchDirectory(base, unconstrainedLaunch));
    assert.equal(await runToolCall("write", { path: "src/ok.ts" }), undefined);
    const attachedContractSections = await runBeforeStart();
    assert.equal(attachedContractSections.delegation_role, roleSection);
    assert.match(
      attachedContractSections.delegation_contract ?? "",
      /Allowed edit scope: src\/\*\*/u,
    );
    assert.match(attachedContractSections.delegation_contract ?? "", /rather than \/tmp/u);

    // Inspect reports latest 20 of total when amendment history exceeds 20 entries.
    for (let i = 0; i < 21; i += 1) {
      recordContractAmendment(
        base,
        unconstrainedId,
        prepareContractAmendment(
          activeContract(base, unconstrainedLaunch),
          { nonGoals: [`No shortcut ${i}`] },
          cwd,
        ),
      );
    }
    const manyInspect = renderInspection(base, unconstrainedLaunch);
    assert.match(replyText(manyInspect), /Contract amendments \(latest 20 of 22\):/u);
  },
);

nodeTest(
  "overseer live state file syncs on /overseer, /overseer-judge, /tree, and successor(overseer: null) strips launch.overseer",
  async (t) => {
    const harness = await createHarness(t, "overseer-live-sync");
    await harness.start();
    const base = ownerDirectory(getPiAgentDir(), "overseer-live-sync");
    const liveFile = path.join(base, OVERSEER_STATE_FILE);

    // Default inert startup (overseer off, judge auto) leaves the run directory untouched.
    assert.equal(fs.existsSync(liveFile), false);

    await harness.runCommand("overseer", "on");
    assert.equal(read(liveFile, overseerLiveStateSchema)?.enabled, true);
    await harness.runCommand("overseer-judge", "off");
    assert.equal(read(liveFile, overseerLiveStateSchema)?.judge, "off");

    // Turning overseer off updates overseer.json immediately and successor(overseer: null) strips launch.overseer.
    await harness.runCommand("overseer", "off");
    assert.equal(read(liveFile, overseerLiveStateSchema)?.enabled, false);
    const dummyLaunch: Launch = {
      version: 1,
      id: "live-sync-r1",
      rootId: "live-sync-r1",
      owner: "overseer-live-sync",
      agentDir: getPiAgentDir(),
      sdk: packageRoot(),
      entry: path.join(packageRoot(), "dist", "agent", "runner.js"),
      cwd: process.cwd(),
      prompt: "Do work",
      context: "fresh",
      sessionId: "child-session",
      sessionFile: path.join(base, "child.jsonl"),
      provider: "openai",
      model: "openai/gpt-5",
      thinking: "medium",
      trusted: true,
      overseer: { enabled: true, judge: "auto" },
      createdAt: Date.now(),
    };
    fs.mkdirSync(runDirectory(base, dummyLaunch.id), { recursive: true, mode: 0o700 });
    write(path.join(runDirectory(base, dummyLaunch.id), "launch.json"), dummyLaunch, true);
    assert.deepEqual(activeOverseer(base, dummyLaunch), { enabled: false, judge: "off" });

    const stripped = successor(base, dummyLaunch, "Continue without overseer", { overseer: null });
    assert.ok(stripped !== undefined);
    assert.equal(stripped.overseer, undefined);

    // Navigating /tree back to an earlier branch entry where overseer was on updates overseer.json immediately.
    harness.setBranch([
      {
        type: "custom",
        customType: OVERSEER_ENTRY_TYPE,
        data: { version: 1, enabled: true, model: DEFAULT_OVERSEER_MODEL, judge: "auto" },
      },
    ]);
    await harness.tree();
    assert.equal(read(liveFile, overseerLiveStateSchema)?.enabled, true);
    assert.equal(read(liveFile, overseerLiveStateSchema)?.judge, "auto");
  },
);

function withChildLineageEnv<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prevRoot = process.env.PI_INTERCOM_ROOT_SESSION_ID;
  const prevParent = process.env.PI_INTERCOM_PARENT_SESSION_ID;
  process.env.PI_INTERCOM_ROOT_SESSION_ID = sessionId;
  process.env.PI_INTERCOM_PARENT_SESSION_ID = sessionId;
  return fn().finally(() => {
    if (prevRoot === undefined) {
      delete process.env.PI_INTERCOM_ROOT_SESSION_ID;
    } else {
      process.env.PI_INTERCOM_ROOT_SESSION_ID = prevRoot;
    }
    if (prevParent === undefined) {
      delete process.env.PI_INTERCOM_PARENT_SESSION_ID;
    } else {
      process.env.PI_INTERCOM_PARENT_SESSION_ID = prevParent;
    }
  });
}

function createIntercomReplyFixture(
  pi: ExtensionAPI,
  sessionId: string,
  base: string,
  launch: Launch,
) {
  const replies = new ReplyTracker();
  const sent: Array<{ to: string; text: string; contractAtSend: readonly string[] | undefined }> =
    [];
  const transport: IntercomTransport = {
    sessionId: nativePeerId(sessionId),
    isConnected: () => true,
    listSessions: async () => [],
    send: async (to, options) => {
      sent.push({
        to,
        text: options.text,
        contractAtSend: activeContract(base, launch)?.scope,
      });
      return { id: `sent-${sent.length}`, accepted: true, delivered: true };
    },
    last: async () => ({ error: "unused" }),
    updatePresence: () => {
      // no-op
    },
    supportsTopics: false,
    updateTopics: async () => {
      throw new Error("unused");
    },
  };
  const amendChildContract = (
    target: ChildContractTarget,
    contract: ContractAmendmentInput,
  ): Promise<ChildContractAmendmentResult> => {
    let outcome: Promise<ChildContractAmendmentResult> | undefined;
    pi.events.emit(AMEND_CHILD_CONTRACT, {
      target,
      contract,
      reply: (result: Promise<ChildContractAmendmentResult>) => {
        outcome = result;
      },
    });
    assert.ok(outcome !== undefined);
    return outcome;
  };
  const outbound = new IntercomOutbound(
    {
      pi,
      lifecycle: {
        markActivity: () => {
          // no-op
        },
      },
      connection: {
        syncStatus: () => {
          // no-op
        },
      },
      replies,
      wait: {
        waiting: false,
        transact: async () => {
          throw new Error("unused");
        },
      },
      devices: {
        address: () => {
          return;
        },
        send: async () => {
          throw new Error("unused");
        },
        ask: async () => {
          throw new Error("unused");
        },
      },
      amendChildContract,
    },
    loadConfig(),
  );
  return { replies, sent, transport, outbound };
}

nodeTest(
  "intercom reply with contract atomically amends owned child before send and rejects non-owned, non-reply, child, or invalid contracts",
  async (t) => {
    // Reject contract on every non-reply action before touching transport or disk.
    for (const action of ["list", "send", "ask", "pending", "status", "last"] as const) {
      const invalid = validateIntercomArguments({ action, contract: { scope: ["src"] } });
      assert.ok(invalid !== undefined);
      assert.equal(invalid.isError, true);
      assert.match(replyText(invalid), /only valid for action='reply'/u);
    }
    assert.equal(
      validateIntercomArguments({ action: "reply", message: "ok", contract: { scope: ["src"] } }),
      undefined,
    );

    const sessionId = "intercom-contract-parent";
    const harness = await createHarness(t, sessionId);
    await harness.start();

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-contract-work-"));
    t.after(() => {
      fs.rmSync(workdir, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(workdir, "src"), { recursive: true });
    fs.mkdirSync(path.join(workdir, "test", "unit"), { recursive: true });

    const base = ownerDirectory(getPiAgentDir(), sessionId);
    const runId = "run-intercom-child-1";
    const childSessionId = "child-intercom-sess-1";
    const childPeerId = nativePeerId(childSessionId);
    const dir = runDirectory(base, runId);
    fs.mkdirSync(path.join(dir, "scratch"), { recursive: true, mode: 0o700 });
    const launch: Launch = {
      version: 1,
      id: runId,
      rootId: runId,
      owner: sessionId,
      cwd: workdir,
      agentDir: getPiAgentDir(),
      sdk: packageRoot(),
      entry: path.join(process.cwd(), "src/agent/index.ts"),
      sessionFile: path.join(dir, "child.jsonl"),
      sessionId: childSessionId,
      prompt: "Implement feature",
      context: "fresh",
      provider: "google",
      model: "gemini-4-hydrogen",
      thinking: "medium",
      trusted: true,
      name: "scope-asker",
      contract: { scope: ["src"], verification: ["npm test"] },
      scratchDir: path.join(dir, "scratch"),
      overseer: { enabled: true, judge: "auto" },
      createdAt: Date.now(),
    };
    write(path.join(dir, "launch.json"), launch, true);
    write(path.join(dir, "admissions", `${runId}.json`), {
      id: runId,
      runId,
      action: "run",
      state: "accepted",
      at: Date.now(),
    });

    const { replies, sent, transport, outbound } = createIntercomReplyFixture(
      harness.pi,
      sessionId,
      base,
      launch,
    );

    // 1. Non-owned main peer ask is rejected without sending reply or writing contract.json.
    replies.recordIncomingMessage(
      {
        id: nativePeerId("other-main"),
        name: "other-main",
        cwd: workdir,
        model: "google/gemini-4-hydrogen",
        rootSessionId: "other-main",
      },
      {
        id: "ask-from-main",
        timestamp: Date.now(),
        expectsReply: true,
        content: { text: "Can you change scope?" },
      },
    );
    const mainReject = await outbound.reply(transport, {
      action: "reply",
      replyTo: "ask-from-main",
      message: "Sure",
      contract: { scope: ["src/**", "test/**/*.test.ts"] },
    });
    assert.equal(mainReject.isError, true);
    assert.match(replyText(mainReject), /owned child run/u);
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "contract.json")), false);
    // Pending ask remains pending when amendment fails.
    assert.equal(replies.listPending().length, 1);
    replies.markReplied("ask-from-main");

    // 2. Peer claiming matching parentSessionId without an owned run record is rejected.
    replies.recordIncomingMessage(
      {
        id: nativePeerId("unowned-child-sess"),
        name: "ghost-child",
        cwd: workdir,
        model: "google/gemini-4-hydrogen",
        rootSessionId: sessionId,
        parentSessionId: sessionId,
      },
      {
        id: "ask-from-ghost",
        timestamp: Date.now(),
        expectsReply: true,
        content: { text: "Amend me?" },
      },
    );
    const ghostReject = await outbound.reply(transport, {
      action: "reply",
      replyTo: "ask-from-ghost",
      message: "Sure",
      contract: { scope: ["src/**"] },
    });
    assert.equal(ghostReject.isError, true);
    assert.match(replyText(ghostReject), /does not match an owned child run/u);
    assert.equal(sent.length, 0);
    replies.markReplied("ask-from-ghost");

    // 3. Owned child asks for scope widening.
    replies.recordIncomingMessage(
      {
        id: childPeerId,
        name: "scope-asker",
        cwd: workdir,
        model: "google/gemini-4-hydrogen",
        rootSessionId: sessionId,
        parentSessionId: sessionId,
      },
      {
        id: "ask-from-child",
        timestamp: Date.now(),
        expectsReply: true,
        content: { text: "Need to add a unit test under test/unit." },
      },
    );

    // Invalid contracts fail cleanly WITHOUT sending reply or mutating contract.json.
    let rejectedAmendment: Promise<ChildContractAmendmentResult> | undefined;
    harness.pi.events.emit(AMEND_CHILD_CONTRACT, {
      target: { peerId: childPeerId, parentSessionId: sessionId, rootSessionId: sessionId },
      contract: null,
      reply: (outcome: Promise<ChildContractAmendmentResult>) => {
        rejectedAmendment = outcome;
      },
    });
    assert.ok(rejectedAmendment);
    await assert.rejects(rejectedAmendment, /invalid contract amendment/iu);

    const unknownField = { scope: ["src"], typo: true };
    const malformed = await outbound.reply(transport, {
      action: "reply",
      replyTo: "ask-from-child",
      message: "Go ahead",
      contract: unknownField,
    });
    assert.equal(malformed.isError, true);
    assert.match(replyText(malformed), /invalid contract amendment/iu);
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "contract.json")), false);
    assert.equal(replies.listPending().length, 1);

    const emptyPatch = await outbound.reply(transport, {
      action: "reply",
      replyTo: "ask-from-child",
      message: "Go ahead",
      contract: {},
    });
    assert.equal(emptyPatch.isError, true);
    assert.match(replyText(emptyPatch), /at least one field/u);
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "contract.json")), false);

    const badScope = await outbound.reply(transport, {
      action: "reply",
      replyTo: "ask-from-child",
      message: "Go ahead",
      contract: { scope: ["nonexistent/**"] },
    });
    assert.equal(badScope.isError, true);
    assert.match(replyText(badScope), /needs an existing directory "nonexistent"/u);
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "contract.json")), false);
    assert.equal(replies.listPending().length, 1);

    // Child sessions are rejected even if they invoke reply with contract.
    const childCallerReject = await withChildLineageEnv(sessionId, () =>
      outbound.reply(transport, {
        action: "reply",
        replyTo: "ask-from-child",
        message: "Self-amend",
        contract: { scope: ["src/**", "test/**/*.test.ts"] },
      }),
    );
    assert.equal(childCallerReject.isError, true);
    assert.match(replyText(childCallerReject), /owning main session/u);
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "contract.json")), false);

    // Valid contract amendment persists BEFORE transport.send() runs and updates receipt + text.
    const okReply = await outbound.reply(transport, {
      action: "reply",
      replyTo: "ask-from-child",
      message: "Yes, add the unit test in test/unit.",
      contract: { scope: ["src/**", "test/**/*.test.ts"] },
    });
    assert.equal(okReply.isError, false);
    assert.equal(sent.length, 1);
    const [firstSent] = sent;
    assert.ok(firstSent !== undefined);
    assert.equal(firstSent.to, childPeerId);
    assert.deepEqual(firstSent.contractAtSend, ["src/**", "test/**/*.test.ts"]);
    assert.match(
      firstSent.text,
      /^\[Delegation contract updated: scope: src\/\*\*, test\/\*\*\/\*\.test\.ts\]\n\nYes, add the unit test in test\/unit\.$/u,
    );
    assert.match(
      replyText(okReply),
      /Reply sent to scope-asker\nDelegation contract amended for run run-intercom-child-1 \(scope-asker\): scope: src\/\*\*, test\/\*\*\/\*\.test\.ts/u,
    );
    assert.deepEqual(activeContract(base, launch), {
      scope: ["src/**", "test/**/*.test.ts"],
      verification: ["npm test"],
    });
    assert.equal(replies.listPending().length, 0);

    // 4. Successor run receives amendment when conversation has advanced R1 -> R2.
    const nextRun = successor(
      base,
      launch,
      "Second phase",
      successorContractOptions(base, launch, activeContract(base, launch)),
    );
    assert.ok(nextRun !== undefined);
    write(path.join(dir, "admissions", `${nextRun.id}.json`), {
      id: nextRun.id,
      runId: nextRun.id,
      action: "run",
      state: "accepted",
      at: Date.now(),
    });
    replies.recordIncomingMessage(
      {
        id: childPeerId,
        name: "scope-asker",
        cwd: workdir,
        model: "google/gemini-4-hydrogen",
        rootSessionId: sessionId,
        parentSessionId: sessionId,
      },
      {
        id: "ask-from-successor",
        timestamp: Date.now(),
        expectsReply: true,
        content: { text: "Can we clear non-goals?" },
      },
    );
    const successorReply = await outbound.reply(transport, {
      action: "reply",
      replyTo: "ask-from-successor",
      message: "Cleared baseBranch.",
      contract: { baseBranch: "main" },
    });
    assert.equal(successorReply.isError, false);
    assert.equal(activeContract(base, nextRun)?.baseBranch, "main");
    assert.equal(activeContract(base, launch)?.baseBranch, undefined);

    // 5. If transport.send throws AFTER contract.json is persisted, the error discloses the persisted amendment.
    replies.recordIncomingMessage(
      {
        id: childPeerId,
        name: "scope-asker",
        cwd: workdir,
        model: "google/gemini-4-hydrogen",
        rootSessionId: sessionId,
        parentSessionId: sessionId,
      },
      {
        id: "ask-before-timeout",
        timestamp: Date.now(),
        expectsReply: true,
        content: { text: "Need nonGoals updated too." },
      },
    );
    const throwingTransport: IntercomTransport = {
      ...transport,
      send: async () => {
        throw new Error("Send timeout");
      },
    };
    const timeoutReply = await outbound.reply(throwingTransport, {
      action: "reply",
      replyTo: "ask-before-timeout",
      message: "Updated nonGoals.",
      contract: { nonGoals: ["no docs"] },
    });
    assert.equal(timeoutReply.isError, true);
    assert.match(
      replyText(timeoutReply),
      /Failed to reply: Send timeout Delegation contract amendment was persisted for run /u,
    );
    assert.deepEqual(activeContract(base, nextRun)?.nonGoals, ["no docs"]);
    assert.equal(replies.listPending().length, 1);
  },
);

nodeTest(
  "agent_runs review(verdict='approved', note=...) steers paused/running children atomically and rejects invalid/settled calls",
  async (t) => {
    const sessionId = "overseer-review-note-parent";
    const harness = await createHarness(t, sessionId);
    await harness.start();

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-review-note-"));
    t.after(() => {
      fs.rmSync(workdir, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(workdir, "src"), { recursive: true });

    const base = ownerDirectory(getPiAgentDir(), sessionId);
    const dummyActor = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    assert.ok(dummyActor.pid !== undefined);
    t.after(() => {
      dummyActor.kill("SIGKILL");
    });

    const setupRun = (
      runId: string,
      options: { admitted?: boolean; live?: boolean; completed?: boolean; paused?: boolean },
    ): Launch => {
      const dir = runDirectory(base, runId);
      const sessionFile = path.join(dir, "child.jsonl");
      fs.mkdirSync(path.join(dir, "scratch"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(sessionFile, `{"type":"session","id":"sess-${runId}"}\n`, { mode: 0o600 });
      const launch: Launch = {
        version: 1,
        id: runId,
        rootId: runId,
        owner: sessionId,
        cwd: workdir,
        agentDir: getPiAgentDir(),
        sdk: packageRoot(),
        entry: path.join(process.cwd(), "src/agent/index.ts"),
        sessionFile,
        sessionId: `sess-${runId}`,
        prompt: "Task",
        context: "fresh",
        provider: "google",
        model: "gemini-4-hydrogen",
        thinking: "medium",
        trusted: true,
        name: runId,
        contract: { scope: ["src"], verification: ["npm test"] },
        scratchDir: path.join(dir, "scratch"),
        overseer: { enabled: true, judge: "auto" },
        createdAt: Date.now(),
      };
      write(path.join(dir, "launch.json"), launch, true);
      if (options.admitted !== false) {
        write(path.join(dir, "admissions", `${runId}.json`), {
          id: runId,
          runId,
          action: "run",
          state: "accepted",
          at: Date.now(),
        });
      }
      if (options.live === true) {
        write(path.join(dir, "actor.lock", "process.json"), {
          ...ownIdentity(dummyActor.pid),
          token: `token-${runId}`,
        });
      }
      if (options.completed === true) {
        write(path.join(dir, "result.json"), {
          id: runId,
          owner: sessionId,
          status: "completed",
          endedAt: Date.now(),
          changedFiles: ["src/a.ts"],
        });
      }
      if (options.paused === true) {
        write(path.join(dir, "escalation.json"), {
          id: `esc-${runId}`,
          runId,
          owner: sessionId,
          at: Date.now(),
          strikes: 1,
          kind: "scope_violation",
          summary: "Pause for review",
          changedFiles: ["src/a.ts"],
          diffExcerpt: "+const a = 1;",
          diffDigest: "digest-1",
        });
      }
      return launch;
    };

    const pausedRun = setupRun("run-paused", { live: true, paused: true });
    const runningRun = setupRun("run-running", { live: true });
    const silentRun = setupRun("run-silent", { live: true, paused: true });
    const completedRun = setupRun("run-completed", { completed: true });
    const interruptedRun = setupRun("run-interrupted", { live: false });
    const unadmittedRun = setupRun("run-unadmitted", { admitted: false });

    // Reject note on non-review actions, non-approved verdicts, and whitespace-only notes.
    await assert.rejects(
      harness.callTool("agent_runs", { action: "list", note: "hint" }),
      /only supported with action="review" and verdict="approved"/u,
    );
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "continue",
        id: runningRun.id,
        prompt: "Next",
        note: "hint",
      }),
      /only supported with action="review" and verdict="approved"/u,
    );
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "review",
        id: pausedRun.id,
        verdict: "changes_requested",
        summary: "Fix bug",
        note: "Extra hint",
      }),
      /only supported with action="review" and verdict="approved"/u,
    );
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "review",
        id: pausedRun.id,
        verdict: "approved",
        summary: "Looks good",
        note: "   ",
      }),
      /note must be non-empty/u,
    );
    assert.equal(readReview(base, pausedRun.id), undefined);

    // Reject note on completed, interrupted, and unadmitted runs without recording review or commands.
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "review",
        id: completedRun.id,
        verdict: "approved",
        summary: "Looks good",
        note: "Also clean up foo",
      }),
      /run run-completed is completed/u,
    );
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "review",
        id: interruptedRun.id,
        verdict: "approved",
        summary: "Looks good",
        note: "Also clean up foo",
      }),
      /run run-interrupted is interrupted/u,
    );
    await assert.rejects(
      harness.callTool("agent_runs", {
        action: "review",
        id: unadmittedRun.id,
        verdict: "approved",
        summary: "Looks good",
        note: "Also clean up foo",
      }),
      /awaiting native admission/u,
    );
    for (const untouched of [completedRun, interruptedRun, unadmittedRun]) {
      assert.equal(readReview(base, untouched.id), undefined);
      assert.equal(fs.existsSync(path.join(runDirectory(base, untouched.id), "commands")), false);
    }

    // Paused child: approval + note records review, resolves escalation with inline steer, and queues command.
    const pausedReply = await harness.callTool("agent_runs", {
      action: "review",
      id: pausedRun.id,
      verdict: "approved",
      summary: "Inspected diff; scope expansion is acceptable.",
      note: "Add a quick comment explaining the lock order.",
    });
    const pausedDetails = replyDetails(pausedReply);
    assert.equal(pausedDetails.released, true);
    assert.ok(typeof pausedDetails.command === "string");
    assert.equal(readReview(base, pausedRun.id)?.verdict, "approved");
    assert.equal(
      readReview(base, pausedRun.id)?.summary,
      "Inspected diff; scope expansion is acceptable.",
    );
    const resolution = read(
      path.join(runDirectory(base, pausedRun.id), "escalation-resolution.json"),
      escalationResolutionSchema,
    );
    assert.ok(resolution !== undefined);
    assert.equal(resolution.verdict, "approved");
    assert.deepEqual(resolution.steer, {
      id: pausedDetails.command,
      prompt: "Add a quick comment explaining the lock order.",
    });
    const queuedCmd = read(
      path.join(runDirectory(base, pausedRun.id), "commands", `${pausedDetails.command}.json`),
      commandSchema,
    );
    assert.equal(queuedCmd?.action, "steer");
    assert.equal(queuedCmd.prompt, "Add a quick comment explaining the lock order.");
    assert.match(
      replyText(pausedReply),
      new RegExp(
        `Pause approval recorded\\.[\\s\\S]*Summary saved for review only\\. Steering note queued for the child \\(command ${pausedDetails.command};`,
        "u",
      ),
    );

    // Running (unpaused) child: approval + note records review and queues steer command.
    const runningReply = await harness.callTool("agent_runs", {
      action: "review",
      id: runningRun.id,
      verdict: "approved",
      summary: "Mid-run check approved.",
      note: "Prefer strict equality in the parser.",
    });
    const runningDetails = replyDetails(runningReply);
    assert.equal(runningDetails.released, false);
    assert.ok(typeof runningDetails.command === "string");
    const runningCmd = read(
      path.join(runDirectory(base, runningRun.id), "commands", `${runningDetails.command}.json`),
      commandSchema,
    );
    assert.equal(runningCmd?.action, "steer");
    assert.equal(runningCmd.prompt, "Prefer strict equality in the parser.");
    assert.match(replyText(runningReply), /The child is still running\./u);
    assert.match(replyText(runningReply), /Steering note queued for the child/u);

    // Omitting note preserves exact backward-compatible silent approval without queueing a command.
    const silentReply = await harness.callTool("agent_runs", {
      action: "review",
      id: silentRun.id,
      verdict: "approved",
      summary: "Silent approval.",
    });
    const silentDetails = replyDetails(silentReply);
    assert.equal(silentDetails.released, true);
    assert.equal("command" in silentDetails, false);
    assert.equal(fs.existsSync(path.join(runDirectory(base, silentRun.id), "commands")), false);
    assert.match(
      replyText(silentReply),
      /Summary saved for review only\. It was not sent to the child\. Use `agent_runs` `action="continue"` to send instructions\./u,
    );
  },
);

nodeTest(
  "delegate tool describes prompt requirements, requests preferred strict JSON schema, and coerces strict nullable optionals",
  async (t) => {
    const harness = await createHarness(t, "delegate-schema-strict");
    const delegateTool = harness.extension.tools.get("delegate");
    assert.ok(delegateTool !== undefined);
    const { definition } = delegateTool;

    assert.deepEqual(definition.constrainedSampling, { type: "json_schema", strict: "prefer" });
    assert.ok(isRecord(definition.parameters));
    assert.deepEqual(definition.parameters.required, ["prompt"]);
    const promptSchema = isRecord(definition.parameters.properties)
      ? definition.parameters.properties.prompt
      : undefined;
    assert.ok(isRecord(promptSchema) && typeof promptSchema.description === "string");
    assert.match(promptSchema.description, /settled product decisions/u);
    assert.match(promptSchema.description, /non-goals/u);

    const toolSpec = {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      constrainedSampling: definition.constrainedSampling,
    };

    assert.throws(
      () =>
        validateToolArguments(toolSpec, {
          type: "toolCall",
          id: "missing-prompt",
          name: "delegate",
          arguments: { name: "worker" },
        }),
      /prompt/u,
    );

    const coercedMinimal: unknown = validateToolArguments(toolSpec, {
      type: "toolCall",
      id: "strict-nulls",
      name: "delegate",
      arguments: {
        prompt: "Implement feature",
        name: null,
        cwd: null,
        model: null,
        thinking: null,
        context: null,
        contract: null,
      },
    });
    assert.deepEqual(coercedMinimal, { prompt: "Implement feature" });

    const coercedContract: unknown = validateToolArguments(toolSpec, {
      type: "toolCall",
      id: "strict-contract-nulls",
      name: "delegate",
      arguments: {
        prompt: "Implement feature",
        name: null,
        cwd: null,
        model: null,
        thinking: null,
        context: null,
        contract: {
          scope: ["src"],
          verification: ["npm test"],
          baseBranch: null,
          requiredPrimitives: null,
          nonGoals: null,
        },
      },
    });
    assert.deepEqual(coercedContract, {
      prompt: "Implement feature",
      contract: { scope: ["src"], verification: ["npm test"] },
    });
  },
);
