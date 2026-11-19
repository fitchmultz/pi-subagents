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
import { launchSchema, type Launch } from "../../src/agent/contracts.ts";
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
  validateDelegationScope,
} from "../../src/agent/overseer-scope.ts";
import { prepareLaunch } from "../../src/agent/launch.ts";
import { harnessExcludePaths } from "../../src/agent/overseer-sentinel.ts";
import { read, scratchDirectory, successor } from "../../src/agent/storage.ts";
import { renderInspection } from "../../src/agent/view.ts";
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

    // formatContractSection surfaces scratchDir for both mutating and read-only contracts.
    const mutatingSection = formatContractSection(
      { scope: ["src/**"], verification: ["npm test"] },
      { scratchDir },
    );
    assert.match(mutatingSection, /Scratch directory for temporary files\/scripts/u);
    assert.ok(mutatingSection.includes(scratchDir));
    const readOnlySection = formatContractSection({ scope: [] }, { scratchDir });
    assert.match(readOnlySection, /edit tools allowed only in the scratch directory below/u);
    assert.ok(readOnlySection.includes(scratchDir));

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
