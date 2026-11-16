import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { escalationSchema, type Escalation, type Launch } from "../../src/agent/contracts.ts";
import { notifications, release } from "../../src/agent/notifications.ts";
import {
  captureRepoSnapshot,
  changedFilesSinceBaseline,
  checkDeterministicTripwires,
  evaluateDecisionCheckpoint,
  type JudgeModelRegistry,
} from "../../src/agent/overseer-judge.ts";
import {
  attachOverseerSentinel,
  resolveActiveEscalation,
  waitForEscalationResolution,
} from "../../src/agent/overseer-sentinel.ts";
import { enqueue, read, runDirectory, write } from "../../src/agent/storage.ts";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";

function initGitRepo(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-git-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "foo", "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "allowed.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "packages", "foo", "src", "item.ts"), "export const y = 1;\n");
  fs.writeFileSync(path.join(dir, "README.md"), "committed\n");
  git("add", ".");
  git("commit", "-m", "initial");
  return dir;
}

function makeClassifierModel(
  provider: string,
  id: string,
  inputCost: number,
): ClassifierModel<ClassifierApi> {
  return {
    type: "classifier",
    id,
    name: id,
    api: "typesafe-system-one",
    provider,
    baseUrl: "https://example.invalid/v1",
    input: ["text"],
    contextWindow: 32768,
    cost: { input: inputCost, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function sampleLaunch(base: string, cwd: string, owner: string): Launch {
  const launch: Launch = {
    version: 1,
    id: "run-overseer-1",
    rootId: "run-overseer-1",
    owner,
    cwd,
    agentDir: base,
    sdk: cwd,
    entry: path.join(cwd, "dist", "index.js"),
    sessionFile: path.join(cwd, "child.jsonl"),
    sessionId: "child-session",
    prompt: "Use DatabaseSync.createTagStore()",
    context: "fresh",
    provider: "google",
    model: "gemini-4-hydrogen",
    thinking: "high",
    trusted: true,
    name: "tag-store",
    contract: {
      scope: ["src"],
      verification: ["npm test"],
      baseBranch: "main",
      requiredPrimitives: ["DatabaseSync.createTagStore()"],
    },
    overseer: { enabled: true, judge: "auto" },
    createdAt: Date.now(),
  };
  const dir = runDirectory(base, launch.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  write(path.join(dir, "launch.json"), launch, true);
  return launch;
}

nodeTest(
  "deterministic tripwires handle dirty baselines, reverts, unicode paths, subdirectory cwd, and branch rules",
  (t) => {
    const repo = initGitRepo(t);
    fs.writeFileSync(path.join(repo, "preexisting-notes.md"), "untouched\n");
    fs.writeFileSync(path.join(repo, "README.md"), "preexisting dirty\n");
    execFileSync("git", ["checkout", "-b", "feat/work"], { cwd: repo, stdio: "ignore" });

    const baseline = captureRepoSnapshot(repo, { baseBranch: "main" });
    const contract = {
      scope: ["src"],
      verification: ["npm test"],
      baseBranch: "main",
    };

    // Reverting pre-existing dirty out-of-scope file back to clean HEAD is not a scope violation,
    // and non-ASCII filenames inside scope are parsed via -z without Git octal quoting.
    fs.writeFileSync(path.join(repo, "README.md"), "committed\n");
    fs.writeFileSync(path.join(repo, "src", "café.ts"), "export const accent = true;\n");
    const cleanSnap = captureRepoSnapshot(repo, {
      baselineHead: baseline.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.deepEqual(changedFilesSinceBaseline(repo, baseline, cleanSnap), ["src/café.ts"]);
    assert.equal(
      checkDeterministicTripwires({
        cwd: repo,
        contract,
        baseline,
        current: cleanSnap,
        consecutiveErrors: 0,
      }),
      undefined,
    );

    // Subdirectory delegation cwd resolves Git's worktree-relative paths against show-toplevel.
    const subCwd = path.join(repo, "packages", "foo");
    const subBase = captureRepoSnapshot(subCwd, { baseBranch: "main" });
    fs.writeFileSync(path.join(subCwd, "src", "item.ts"), "export const y = 2;\n");
    const subClean = captureRepoSnapshot(subCwd, {
      baselineHead: subBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.deepEqual(changedFilesSinceBaseline(subCwd, subBase, subClean), ["src/item.ts"]);
    assert.equal(
      checkDeterministicTripwires({
        cwd: subCwd,
        contract,
        baseline: subBase,
        current: subClean,
        consecutiveErrors: 0,
      }),
      undefined,
    );

    // Advancing main after feat/work was cut does not wedge in-scope edits on feat/work.
    execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "UPSTREAM.md"), "ahead on main\n");
    execFileSync("git", ["add", "UPSTREAM.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "advance main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "feat/work"], { cwd: repo, stdio: "ignore" });
    const divergedBase = captureRepoSnapshot(repo, { baseBranch: "main" });
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "export const x = 22;\n");
    const divergedCurrent = captureRepoSnapshot(repo, {
      baselineHead: divergedBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.equal(
      checkDeterministicTripwires({
        cwd: repo,
        contract,
        baseline: divergedBase,
        current: divergedCurrent,
        consecutiveErrors: 0,
      }),
      undefined,
    );

    // Unresolvable baseBranch fails closed instead of silently skipping ancestry checks.
    const typoSnap = captureRepoSnapshot(repo, {
      baselineHead: divergedBase.head,
      hasBaseline: true,
      baseBranch: "mun",
    });
    assert.equal(
      checkDeterministicTripwires({
        cwd: repo,
        contract: { ...contract, baseBranch: "mun" },
        baseline: divergedBase,
        current: typoSnap,
        consecutiveErrors: 0,
      })?.kind,
      "branch_violation",
    );

    const loopHit = checkDeterministicTripwires({
      cwd: repo,
      contract,
      baseline,
      current: cleanSnap,
      consecutiveErrors: 3,
    });
    assert.equal(loopHit?.kind, "loop_violation");

    fs.writeFileSync(path.join(repo, "README.md"), "new drift\n");
    const scopeSnap = captureRepoSnapshot(repo, {
      baselineHead: baseline.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    const scopeHit = checkDeterministicTripwires({
      cwd: repo,
      contract,
      baseline,
      current: scopeSnap,
      consecutiveErrors: 0,
    });
    assert.ok(scopeHit !== undefined);
    assert.equal(scopeHit.kind, "scope_violation");
    assert.match(scopeHit.summary, /README\.md/u);

    fs.writeFileSync(path.join(repo, "README.md"), "committed\n");
    // Sneaky commit on main followed by switching back to feat/work is caught via localBaseHead.
    const sneakBase = captureRepoSnapshot(repo, { baseBranch: "main" });
    execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "export const x = 3;\n");
    execFileSync("git", ["commit", "-m", "direct main commit", "src/allowed.ts"], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "feat/work"], { cwd: repo, stdio: "ignore" });
    const sneakAfter = captureRepoSnapshot(repo, {
      baselineHead: sneakBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    const branchHit = checkDeterministicTripwires({
      cwd: repo,
      contract,
      baseline: sneakBase,
      current: sneakAfter,
      consecutiveErrors: 0,
    });
    assert.equal(branchHit?.kind, "branch_violation");

    // Committed git mv from out-of-scope README.md into src/ is caught via --no-renames.
    const renameBase = captureRepoSnapshot(repo, { baseBranch: "main" });
    execFileSync("git", ["mv", "README.md", "src/moved-readme.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "move readme", "README.md", "src/moved-readme.md"], {
      cwd: repo,
      stdio: "ignore",
    });
    const renameAfter = captureRepoSnapshot(repo, {
      baselineHead: renameBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.equal(
      checkDeterministicTripwires({
        cwd: repo,
        contract,
        baseline: renameBase,
        current: renameAfter,
        consecutiveErrors: 0,
      })?.kind,
      "scope_violation",
    );

    // First commit in an unborn Git repository catches both out-of-scope files and main commits.
    const unborn = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-unborn-"));
    t.after(() => fs.rmSync(unborn, { recursive: true, force: true }));
    execFileSync("git", ["init", "-b", "main"], { cwd: unborn, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: unborn,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: unborn, stdio: "ignore" });
    const unbornBase = captureRepoSnapshot(unborn, { baseBranch: "main" });
    fs.mkdirSync(path.join(unborn, "src"), { recursive: true });
    fs.writeFileSync(path.join(unborn, "src", "init.ts"), "export const v = 1;\n");
    execFileSync("git", ["add", "."], { cwd: unborn, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "first"], { cwd: unborn, stdio: "ignore" });
    const unbornAfter = captureRepoSnapshot(unborn, {
      baselineHead: unbornBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.deepEqual(changedFilesSinceBaseline(unborn, unbornBase, unbornAfter), ["src/init.ts"]);
    assert.equal(
      checkDeterministicTripwires({
        cwd: unborn,
        contract,
        baseline: unbornBase,
        current: unbornAfter,
        consecutiveErrors: 0,
      })?.kind,
      "branch_violation",
    );

    // Unborn empty Git repository already checked out on a task branch allows in-scope edits/commits.
    const unbornTask = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-unborn-task-"));
    t.after(() => fs.rmSync(unbornTask, { recursive: true, force: true }));
    execFileSync("git", ["init", "-b", "main"], { cwd: unbornTask, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: unbornTask,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: unbornTask, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "feat/work"], { cwd: unbornTask, stdio: "ignore" });
    const unbornTaskBase = captureRepoSnapshot(unbornTask, { baseBranch: "main" });
    fs.mkdirSync(path.join(unbornTask, "src"), { recursive: true });
    fs.writeFileSync(path.join(unbornTask, "src", "init.ts"), "export const v = 1;\n");
    const unbornTaskDirty = captureRepoSnapshot(unbornTask, {
      baselineHead: unbornTaskBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.equal(
      checkDeterministicTripwires({
        cwd: unbornTask,
        contract,
        baseline: unbornTaskBase,
        current: unbornTaskDirty,
        consecutiveErrors: 0,
      }),
      undefined,
    );
    execFileSync("git", ["add", "."], { cwd: unbornTask, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "task first"], { cwd: unbornTask, stdio: "ignore" });
    const unbornTaskCommitted = captureRepoSnapshot(unbornTask, {
      baselineHead: unbornTaskBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.equal(
      checkDeterministicTripwires({
        cwd: unbornTask,
        contract,
        baseline: unbornTaskBase,
        current: unbornTaskCommitted,
        consecutiveErrors: 0,
      }),
      undefined,
    );

    // Remote-only baseBranch (origin/main without refs/heads/main) reports sneaky base commit as
    // branch_violation without diffing from the empty tree and inventing README.md scope drift.
    const remoteOnly = initGitRepo(t);
    execFileSync("git", ["checkout", "-b", "feat/work"], { cwd: remoteOnly, stdio: "ignore" });
    const mainTip = execFileSync("git", ["rev-parse", "main"], {
      cwd: remoteOnly,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", mainTip], {
      cwd: remoteOnly,
      stdio: "ignore",
    });
    execFileSync("git", ["branch", "-D", "main"], { cwd: remoteOnly, stdio: "ignore" });
    const remoteBase = captureRepoSnapshot(remoteOnly, { baseBranch: "main" });
    execFileSync("git", ["checkout", "-b", "main", "origin/main"], {
      cwd: remoteOnly,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(remoteOnly, "src", "sneak.ts"), "export const s = 1;\n");
    execFileSync("git", ["add", "src/sneak.ts"], { cwd: remoteOnly, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "sneak on main"], { cwd: remoteOnly, stdio: "ignore" });
    execFileSync("git", ["checkout", "feat/work"], { cwd: remoteOnly, stdio: "ignore" });
    const remoteAfter = captureRepoSnapshot(remoteOnly, {
      baselineHead: remoteBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.deepEqual(changedFilesSinceBaseline(remoteOnly, remoteBase, remoteAfter), [
      "src/sneak.ts",
    ]);
    assert.equal(
      checkDeterministicTripwires({
        cwd: remoteOnly,
        contract,
        baseline: remoteBase,
        current: remoteAfter,
        consecutiveErrors: 0,
      })?.kind,
      "branch_violation",
    );

    // Fast-forwarding local main from upstream (git fetch origin main:main) while on feat/work
    // is NOT misattributed as child scope/branch drift, even if upstream touched README.md.
    const upstream = initGitRepo(t);
    execFileSync("git", ["branch", "feat/work"], { cwd: upstream, stdio: "ignore" });
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-ff-clone-"));
    t.after(() => fs.rmSync(cloneDir, { recursive: true, force: true }));
    execFileSync("git", ["clone", upstream, cloneDir], { stdio: "ignore" });
    execFileSync("git", ["checkout", "feat/work"], { cwd: cloneDir, stdio: "ignore" });
    execFileSync("git", ["branch", "-f", "main", "origin/main"], {
      cwd: cloneDir,
      stdio: "ignore",
    });
    const ffBase = captureRepoSnapshot(cloneDir, { baseBranch: "main" });
    execFileSync("git", ["checkout", "main"], { cwd: upstream, stdio: "ignore" });
    fs.writeFileSync(path.join(upstream, "README.md"), "upstream readme update\n");
    execFileSync("git", ["add", "README.md"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "upstream main"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["fetch", "origin", "main:main"], { cwd: cloneDir, stdio: "ignore" });
    const ffAfter = captureRepoSnapshot(cloneDir, {
      baselineHead: ffBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.deepEqual(changedFilesSinceBaseline(cloneDir, ffBase, ffAfter), []);
    assert.equal(
      checkDeterministicTripwires({
        cwd: cloneDir,
        contract,
        baseline: ffBase,
        current: ffAfter,
        consecutiveErrors: 0,
      }),
      undefined,
    );

    // git pull --ff-only and ref-form baseBranch ("origin/main") fast-forwards pass, while
    // reflogless direct commit + push on main fails closed even after a subsequent git fetch.
    fs.writeFileSync(path.join(upstream, "README.md"), "upstream pull update\n");
    execFileSync("git", ["commit", "-am", "upstream pull"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: cloneDir, stdio: "ignore" });
    execFileSync("git", ["pull", "--ff-only", "origin", "main"], {
      cwd: cloneDir,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "feat/work"], { cwd: cloneDir, stdio: "ignore" });
    const refFormBase = captureRepoSnapshot(cloneDir, { baseBranch: "origin/main" });
    fs.writeFileSync(path.join(upstream, "README.md"), "upstream ref-form update\n");
    execFileSync("git", ["commit", "-am", "upstream ref-form"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["fetch", "origin", "main:main"], { cwd: cloneDir, stdio: "ignore" });
    const pullAfter = captureRepoSnapshot(cloneDir, {
      baselineHead: refFormBase.head,
      hasBaseline: true,
      baseBranch: "origin/main",
    });
    assert.deepEqual(changedFilesSinceBaseline(cloneDir, refFormBase, pullAfter), []);
    assert.equal(
      checkDeterministicTripwires({
        cwd: cloneDir,
        contract: { ...contract, baseBranch: "origin/main" },
        baseline: refFormBase,
        current: pullAfter,
        consecutiveErrors: 0,
      }),
      undefined,
    );

    // Child committing directly on main and pushing to origin/main (even with a colliding `main`
    // tag present) is still caught as branch_violation, not treated as an upstream fast-forward.
    const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-bare-origin-"));
    const pushClone = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-push-clone-"));
    t.after(() => {
      fs.rmSync(bareOrigin, { recursive: true, force: true });
      fs.rmSync(pushClone, { recursive: true, force: true });
    });
    execFileSync("git", ["init", "--bare", "-b", "main", bareOrigin], { stdio: "ignore" });
    execFileSync("git", ["clone", bareOrigin, pushClone], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: pushClone,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: pushClone, stdio: "ignore" });
    fs.mkdirSync(path.join(pushClone, "src"), { recursive: true });
    fs.writeFileSync(path.join(pushClone, "src", "init.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: pushClone, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: pushClone, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: pushClone, stdio: "ignore" });
    execFileSync("git", ["tag", "main"], { cwd: pushClone, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "feat/work"], { cwd: pushClone, stdio: "ignore" });
    const pushBase = captureRepoSnapshot(pushClone, { baseBranch: "main" });
    execFileSync("git", ["checkout", "refs/heads/main"], { cwd: pushClone, stdio: "ignore" });
    execFileSync("git", ["checkout", "-B", "main"], { cwd: pushClone, stdio: "ignore" });
    fs.writeFileSync(path.join(pushClone, "src", "init.ts"), "export const a = 2;\n");
    execFileSync("git", ["commit", "-am", "sneak push"], { cwd: pushClone, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "refs/heads/main:refs/heads/main"], {
      cwd: pushClone,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "feat/work"], { cwd: pushClone, stdio: "ignore" });
    const pushAfter = captureRepoSnapshot(pushClone, {
      baselineHead: pushBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.deepEqual(changedFilesSinceBaseline(pushClone, pushBase, pushAfter), ["src/init.ts"]);
    assert.equal(
      checkDeterministicTripwires({
        cwd: pushClone,
        contract,
        baseline: pushBase,
        current: pushAfter,
        consecutiveErrors: 0,
      })?.kind,
      "branch_violation",
    );
    // Even under scope: ['*'], losing Git status mid-run fails closed instead of silently passing.
    assert.equal(
      checkDeterministicTripwires({
        cwd: pushClone,
        contract: { scope: ["*"], verification: ["npm test"] },
        baseline: pushBase,
        current: captureRepoSnapshot(path.join(os.tmpdir(), "non-existent-git-dir")),
        consecutiveErrors: 0,
      })?.kind,
      "loop_violation",
    );
    execFileSync("git", ["config", "core.logAllRefUpdates", "false"], {
      cwd: pushClone,
      stdio: "ignore",
    });
    fs.rmSync(path.join(pushClone, ".git", "logs"), { recursive: true, force: true });
    const refloglessPushBase = captureRepoSnapshot(pushClone, { baseBranch: "main" });
    execFileSync("git", ["checkout", "-B", "main", "origin/main"], {
      cwd: pushClone,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(pushClone, "src", "init.ts"), "export const a = 3;\n");
    execFileSync("git", ["commit", "-am", "reflogless push"], { cwd: pushClone, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "refs/heads/main:refs/heads/main"], {
      cwd: pushClone,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "feat/work"], { cwd: pushClone, stdio: "ignore" });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: pushClone, stdio: "ignore" });
    const refloglessPushAfter = captureRepoSnapshot(pushClone, {
      baselineHead: refloglessPushBase.head,
      hasBaseline: true,
      baseBranch: "main",
    });
    assert.equal(
      checkDeterministicTripwires({
        cwd: pushClone,
        contract,
        baseline: refloglessPushBase,
        current: refloglessPushAfter,
        consecutiveErrors: 0,
      })?.kind,
      "branch_violation",
    );
  },
);

nodeTest(
  "evaluateDecisionCheckpoint uses typed classifier catalog and surfaces explicit judge errors",
  async (t) => {
    const repo = initGitRepo(t);
    const baseline = captureRepoSnapshot(repo);
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "const customCache = new Map();\n");
    const snap = captureRepoSnapshot(repo, baseline.head);

    const geminiDecision = makeClassifierModel("google", "gemini-decision-1", 0.03);
    const freeOpenRouter = makeClassifierModel("openrouter", "parallel/decisions-fast:free", 0);
    const luna = makeClassifierModel("openai", "gpt-6-luna", 0.25);
    const chosenModels: string[] = [];
    const fakeRegistry: JudgeModelRegistry = {
      getAvailableOfType: () => Promise.resolve([freeOpenRouter, luna, geminiDecision]),
      getModelOfType: (_type, provider, id) =>
        [freeOpenRouter, luna, geminiDecision].find((m) => m.provider === provider && m.id === id),
      classify: (model) => {
        chosenModels.push(`${model.provider}/${model.id}`);
        return Promise.resolve({
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          answers: {
            verdict: {
              type: "choice",
              choice: "primitive_violation",
              probabilities: {
                compliant: 0.05,
                scope_violation: 0.04,
                primitive_violation: 0.91,
              },
              confidence: 0.91,
            },
          },
        });
      },
    };

    const hit = await evaluateDecisionCheckpoint({
      modelRegistry: fakeRegistry,
      judgeSpec: "auto",
      prompt: "Implement tag queries",
      contract: {
        scope: ["src"],
        verification: ["npm test"],
        requiredPrimitives: ["DatabaseSync.createTagStore()"],
      },
      changedFiles: ["src/allowed.ts"],
      snapshot: snap,
      signal: undefined,
    });

    assert.deepEqual(chosenModels, ["google/gemini-decision-1"]);
    assert.ok(hit !== undefined);
    assert.equal(hit.kind, "primitive_violation");
    assert.match(hit.summary, /gemini-decision-1/u);

    const failingRegistry: JudgeModelRegistry = {
      ...fakeRegistry,
      classify: (model) =>
        Promise.resolve({
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "error",
          errorMessage: "invalid API key",
          timestamp: Date.now(),
          answers: {},
        }),
    };
    await assert.rejects(
      () =>
        evaluateDecisionCheckpoint({
          modelRegistry: failingRegistry,
          judgeSpec: "auto",
          prompt: "Implement tag queries",
          contract: { scope: ["src"], verification: ["npm test"] },
          changedFiles: ["src/allowed.ts"],
          snapshot: snap,
          signal: undefined,
        }),
      /invalid API key/u,
    );
  },
);

nodeTest(
  "attachOverseerSentinel primes baseline before turn 1 and re-judges unfixed steered drift on settle",
  async (t) => {
    const repo = initGitRepo(t);
    execFileSync("git", ["checkout", "-b", "feat/work"], { cwd: repo, stdio: "ignore" });
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-sentinel-runs-"));
    t.after(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    const parentSession = SessionManager.inMemory();
    const owner = parentSession.getSessionId();
    const launch = sampleLaunch(base, repo, owner);

    let flushed = 0;
    let flushHasQueued = true;
    const loader = new DefaultResourceLoader({
      cwd: repo,
      agentDir: getPiAgentDir(),
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi: ExtensionAPI) => {
          attachOverseerSentinel(pi, {
            base,
            activeLaunch: () => launch,
            isStopping: () => false,
            flushPendingCommands: () => {
              flushed += 1;
              return flushHasQueued;
            },
          });
        },
      ],
    });
    await loader.reload();
    const ext = loader.getExtensions().extensions[0];
    assert.ok(ext !== undefined);

    const classifier = makeClassifierModel("google", "gemini-decision-1", 0.03);
    let classifyCalls = 0;
    const ctx = {
      hasPendingMessages: () => false,
      modelRegistry: {
        getAvailableOfType: () => Promise.resolve([classifier]),
        getModelOfType: () => classifier,
        classify: () => {
          classifyCalls += 1;
          return Promise.resolve({
            api: classifier.api,
            provider: classifier.provider,
            model: classifier.id,
            stopReason: "stop",
            timestamp: Date.now(),
            answers: {
              verdict: {
                type: "choice",
                choice: "primitive_violation",
                probabilities: { compliant: 0.1, scope_violation: 0, primitive_violation: 0.9 },
                confidence: 0.9,
              },
            },
          });
        },
      },
    };
    const emit = async (name: string, event: Record<string, unknown>): Promise<unknown[]> =>
      Promise.all(
        (ext.handlers.get(name) ?? []).map((handler) => handler({ type: name, ...event }, ctx)),
      );

    // Prime baseline BEFORE turn 1 edits anything.
    await emit("before_agent_start", {});

    // Turn 1 introduces >120 lines of primitive-violating diff inside src/allowed.ts.
    const bigViolation = Array.from({ length: 130 }, (_, i) => `export const v${i} = ${i};`).join(
      "\n",
    );
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), `${bigViolation}\n`);

    const turnPromise = emit("turn_end", {
      toolResults: [{ toolName: "write", isError: false }],
    });
    // Wait until escalation.json appears, then steer (do NOT approve).
    const escPath = path.join(runDirectory(base, launch.id), "escalation.json");
    while (!fs.existsSync(escPath)) {
      await delay(10);
    }
    const firstEsc = read(escPath, escalationSchema);
    assert.ok(firstEsc !== undefined);
    assert.equal(firstEsc.strikes, 1);
    t.after(() => release(owner, `escalation:${firstEsc.id}`));
    resolveActiveEscalation(base, launch, "steered");
    await turnPromise;
    assert.equal(classifyCalls, 1);

    // Child tries to settle WITHOUT changing the drifted digest -> re-judged and caught!
    const settlePromise = emit("agent_before_settle", {
      outcome: "completed",
      entries: [],
      context: { pendingMessages: [] },
    });
    while (!fs.existsSync(escPath)) {
      await delay(10);
    }
    const secondEsc = read(escPath, escalationSchema);
    assert.ok(secondEsc !== undefined);
    assert.equal(secondEsc.strikes, 2);
    t.after(() => release(owner, `escalation:${secondEsc.id}`));
    resolveActiveEscalation(base, launch, "steered");
    const steeredResults = await settlePromise;
    assert.equal(classifyCalls, 2);
    assert.equal(flushed, 1);
    assert.deepEqual(steeredResults, [{ continue: true }]);

    flushHasQueued = false;
    const approvePromise = emit("agent_before_settle", {
      outcome: "completed",
      entries: [],
      context: { pendingMessages: [] },
    });
    while (!fs.existsSync(escPath)) {
      await delay(10);
    }
    const thirdEsc = read(escPath, escalationSchema);
    assert.ok(thirdEsc !== undefined);
    assert.equal(thirdEsc.strikes, 3);
    t.after(() => release(owner, `escalation:${thirdEsc.id}`));
    resolveActiveEscalation(base, launch, "approved");
    const approvedResults = await approvePromise;
    assert.deepEqual(approvedResults, [undefined]);

    // Unsteered settle fallback injects overseer-sentinel only when no steer is queued.
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), `${bigViolation}\n// strike 4\n`);
    const fallbackPromise = emit("agent_before_settle", {
      outcome: "completed",
      entries: [],
      context: { pendingMessages: [] },
    });
    while (!fs.existsSync(escPath)) {
      await delay(10);
    }
    const fourthEsc = read(escPath, escalationSchema);
    assert.ok(fourthEsc !== undefined);
    t.after(() => release(owner, `escalation:${fourthEsc.id}`));
    resolveActiveEscalation(base, launch, "steered");
    const fallbackResults = await fallbackPromise;
    assert.equal(flushed, 2);
    assert.match(JSON.stringify(fallbackResults), /overseer-sentinel/u);
  },
);

nodeTest(
  "pause-on-drift publishes escalation notice to parent and resumes when parent steers",
  async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-pause-"));
    t.after(() => {
      fs.rmSync(temp, { recursive: true, force: true });
    });

    const parentSession = SessionManager.inMemory();
    const owner = parentSession.getSessionId();
    t.after(() => {
      release(owner, "escalation:esc-1");
    });

    const base = path.join(temp, "runs");
    const launch = sampleLaunch(base, temp, owner);
    const escalation: Escalation = {
      id: "esc-1",
      runId: launch.id,
      owner,
      at: Date.now(),
      strikes: 1,
      kind: "primitive_violation",
      summary: "Custom Map cache added instead of createTagStore",
      changedFiles: ["src/allowed.ts"],
      diffExcerpt: "+const cache = new Map();",
      diffDigest: "digest-1",
    };

    const approved = new Set<string>();
    let resolved = false;
    const waiting = (async () => {
      await waitForEscalationResolution({
        base,
        launch,
        escalation,
        approvedDigests: approved,
        isStopping: () => false,
      });
      resolved = true;
    })();

    const reconciled = notifications({ sessionManager: parentSession }, base, owner);
    assert.equal(reconciled.notices.length, 1);
    assert.equal(reconciled.notices[0]?.message.customType, "agent-escalation");
    assert.equal(
      reconciled.awaited.has(path.join(runDirectory(base, launch.id), "escalation.json")),
      true,
    );
    assert.equal(resolved, false);

    const cleared = resolveActiveEscalation(base, launch, "steered");
    assert.equal(cleared?.id, "esc-1");
    await waiting;
    assert.equal(resolved, true);
    assert.equal(fs.existsSync(path.join(runDirectory(base, launch.id), "escalation.json")), false);

    // Guidance enqueued before waitForEscalationResolution starts is honored without wedging.
    enqueue(base, launch, { action: "steer", prompt: "Fix drift immediately" });
    const preSteeredVerdict = await waitForEscalationResolution({
      base,
      launch,
      escalation: { ...escalation, id: "esc-pre-steered" },
      approvedDigests: approved,
      isStopping: () => false,
    });
    assert.equal(preSteeredVerdict, "steered");
  },
);
