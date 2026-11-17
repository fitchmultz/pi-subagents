import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ClassifierApi, ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  escalationResolutionSchema,
  escalationSchema,
  type Escalation,
  type Launch,
} from "../../src/agent/contracts.ts";
import { notifications, release } from "../../src/agent/notifications.ts";
import {
  acceptedPoint,
  captureRepoSnapshot,
  changesDiff,
  launchPoint,
  ownChanges,
  type RepoSnapshot,
  type ReviewPoint,
} from "../../src/agent/overseer-git.ts";
import {
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
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "foo", "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "allowed.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "packages", "foo", "src", "item.ts"), "export const y = 1;\n");
  fs.writeFileSync(path.join(dir, "README.md"), "committed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
  return dir;
}

/** The deterministic checks for a run whose only accepted state is its launch. */
function tripwires(options: {
  cwd: string;
  contract: NonNullable<Launch["contract"]>;
  baseline: ReviewPoint;
  current: RepoSnapshot;
  consecutiveErrors: number;
}): ReturnType<typeof checkDeterministicTripwires> {
  const { baseline, ...rest } = options;
  return checkDeterministicTripwires({
    ...rest,
    launch: baseline.snapshot,
    changes: ownChanges(options.cwd, baseline, options.current),
  });
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

    const baseline = launchPoint(repo, { baseBranch: "main" });
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
      baseBranch: "main",
    });
    assert.deepEqual(ownChanges(repo, baseline, cleanSnap).files, ["src/café.ts"]);
    assert.equal(
      tripwires({
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
    const subBase = launchPoint(subCwd, { baseBranch: "main" });
    fs.writeFileSync(path.join(subCwd, "src", "item.ts"), "export const y = 2;\n");
    const subClean = captureRepoSnapshot(subCwd, {
      baseBranch: "main",
    });
    assert.deepEqual(ownChanges(subCwd, subBase, subClean).files, ["src/item.ts"]);
    assert.equal(
      tripwires({
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
    const divergedBase = launchPoint(repo, { baseBranch: "main" });
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "export const x = 22;\n");
    const divergedCurrent = captureRepoSnapshot(repo, {
      baseBranch: "main",
    });
    assert.equal(
      tripwires({
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
      baseBranch: "mun",
    });
    assert.equal(
      tripwires({
        cwd: repo,
        contract: { ...contract, baseBranch: "mun" },
        baseline: divergedBase,
        current: typoSnap,
        consecutiveErrors: 0,
      })?.kind,
      "branch_violation",
    );

    const loopHit = tripwires({
      cwd: repo,
      contract,
      baseline,
      current: cleanSnap,
      consecutiveErrors: 3,
    });
    assert.equal(loopHit?.kind, "loop_violation");

    fs.writeFileSync(path.join(repo, "README.md"), "new drift\n");
    const scopeSnap = captureRepoSnapshot(repo, {
      baseBranch: "main",
    });
    const scopeHit = tripwires({
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
    const sneakBase = launchPoint(repo, { baseBranch: "main" });
    execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "export const x = 3;\n");
    execFileSync("git", ["commit", "-m", "direct main commit", "src/allowed.ts"], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "feat/work"], { cwd: repo, stdio: "ignore" });
    const sneakAfter = captureRepoSnapshot(repo, {
      baseBranch: "main",
    });
    const branchHit = tripwires({
      cwd: repo,
      contract,
      baseline: sneakBase,
      current: sneakAfter,
      consecutiveErrors: 0,
    });
    assert.equal(branchHit?.kind, "branch_violation");

    // Committed git mv from out-of-scope README.md into src/ is caught via --no-renames.
    const renameBase = launchPoint(repo, { baseBranch: "main" });
    execFileSync("git", ["mv", "README.md", "src/moved-readme.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "move readme", "README.md", "src/moved-readme.md"], {
      cwd: repo,
      stdio: "ignore",
    });
    const renameAfter = captureRepoSnapshot(repo, {
      baseBranch: "main",
    });
    assert.equal(
      tripwires({
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
    const unbornBase = launchPoint(unborn, { baseBranch: "main" });
    fs.mkdirSync(path.join(unborn, "src"), { recursive: true });
    fs.writeFileSync(path.join(unborn, "src", "init.ts"), "export const v = 1;\n");
    execFileSync("git", ["add", "."], { cwd: unborn, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "first"], { cwd: unborn, stdio: "ignore" });
    const unbornAfter = captureRepoSnapshot(unborn, {
      baseBranch: "main",
    });
    assert.deepEqual(ownChanges(unborn, unbornBase, unbornAfter).files, ["src/init.ts"]);
    assert.equal(
      tripwires({
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
    const unbornTaskBase = launchPoint(unbornTask, { baseBranch: "main" });
    fs.mkdirSync(path.join(unbornTask, "src"), { recursive: true });
    fs.writeFileSync(path.join(unbornTask, "src", "init.ts"), "export const v = 1;\n");
    const unbornTaskDirty = captureRepoSnapshot(unbornTask, {
      baseBranch: "main",
    });
    assert.equal(
      tripwires({
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
      baseBranch: "main",
    });
    assert.equal(
      tripwires({
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
    const remoteBase = launchPoint(remoteOnly, { baseBranch: "main" });
    execFileSync("git", ["checkout", "-b", "main", "origin/main"], {
      cwd: remoteOnly,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(remoteOnly, "src", "sneak.ts"), "export const s = 1;\n");
    execFileSync("git", ["add", "src/sneak.ts"], { cwd: remoteOnly, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "sneak on main"], { cwd: remoteOnly, stdio: "ignore" });
    execFileSync("git", ["checkout", "feat/work"], { cwd: remoteOnly, stdio: "ignore" });
    const remoteAfter = captureRepoSnapshot(remoteOnly, {
      baseBranch: "main",
    });
    assert.deepEqual(ownChanges(remoteOnly, remoteBase, remoteAfter).files, ["src/sneak.ts"]);
    assert.equal(
      tripwires({
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
    const ffBase = launchPoint(cloneDir, { baseBranch: "main" });
    execFileSync("git", ["checkout", "main"], { cwd: upstream, stdio: "ignore" });
    fs.writeFileSync(path.join(upstream, "README.md"), "upstream readme update\n");
    execFileSync("git", ["add", "README.md"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "upstream main"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["fetch", "origin", "main:main"], { cwd: cloneDir, stdio: "ignore" });
    const ffAfter = captureRepoSnapshot(cloneDir, {
      baseBranch: "main",
    });
    assert.deepEqual(ownChanges(cloneDir, ffBase, ffAfter).files, []);
    assert.equal(
      tripwires({
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
    const refFormBase = launchPoint(cloneDir, { baseBranch: "origin/main" });
    fs.writeFileSync(path.join(upstream, "README.md"), "upstream ref-form update\n");
    execFileSync("git", ["commit", "-am", "upstream ref-form"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["fetch", "origin", "main:main"], { cwd: cloneDir, stdio: "ignore" });
    const pullAfter = captureRepoSnapshot(cloneDir, {
      baseBranch: "origin/main",
    });
    assert.deepEqual(ownChanges(cloneDir, refFormBase, pullAfter).files, []);
    assert.equal(
      tripwires({
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
    const pushBase = launchPoint(pushClone, { baseBranch: "main" });
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
      baseBranch: "main",
    });
    assert.deepEqual(ownChanges(pushClone, pushBase, pushAfter).files, ["src/init.ts"]);
    assert.equal(
      tripwires({
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
      tripwires({
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
    const refloglessPushBase = launchPoint(pushClone, { baseBranch: "main" });
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
      baseBranch: "main",
    });
    assert.equal(
      tripwires({
        cwd: pushClone,
        contract,
        baseline: refloglessPushBase,
        current: refloglessPushAfter,
        consecutiveErrors: 0,
      })?.kind,
      "branch_violation",
    );

    // An uncommitted edit that was there at launch is not the run's work. A forced checkout of
    // another branch that drops it lists nothing, also after a checkpoint accepted that state.
    const dirty = initGitRepo(t);
    git(dirty, "branch", "feat/old");
    fs.writeFileSync(path.join(dirty, "src", "second.ts"), "export const second = 2;\n");
    git(dirty, "add", ".");
    git(dirty, "commit", "-m", "second");
    fs.writeFileSync(path.join(dirty, "README.md"), "preexisting dirty\n");
    const dirtyLaunch = launchPoint(dirty);
    const dirtyPassed = acceptedPoint(dirtyLaunch, captureRepoSnapshot(dirty));
    git(dirty, "checkout", "-f", "feat/old");
    assert.deepEqual(ownChanges(dirty, dirtyLaunch, captureRepoSnapshot(dirty)).files, []);
    assert.deepEqual(ownChanges(dirty, dirtyPassed, captureRepoSnapshot(dirty)).files, []);
  },
);

nodeTest(
  "evaluateDecisionCheckpoint uses typed classifier catalog and surfaces explicit judge errors",
  async (t) => {
    const repo = initGitRepo(t);
    const baseline = launchPoint(repo);
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "const customCache = new Map();\n");
    const diff = changesDiff(ownChanges(repo, baseline, captureRepoSnapshot(repo)));

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
      diff,
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
          diff,
          signal: undefined,
        }),
      /invalid API key/u,
    );
  },
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** An upstream repository, a clone of it on `main`, and two linked worktrees of that clone. */
function initWorktrees(t: TestContext): {
  upstream: string;
  checkout: string;
  child: string;
  sibling: string;
} {
  const upstream = initGitRepo(t);
  fs.writeFileSync(
    path.join(upstream, "src", "shared.ts"),
    "export const first = 1;\n\n\n\n\nexport const last = 1;\n",
  );
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "shared");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "overseer-worktrees-")));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const checkout = path.join(root, "checkout");
  git(root, "clone", upstream, checkout);
  git(checkout, "config", "user.email", "test@example.com");
  git(checkout, "config", "user.name", "Test");
  const child = path.join(root, "child");
  const sibling = path.join(root, "sibling");
  git(checkout, "worktree", "add", "-b", "feat/child", child);
  git(checkout, "worktree", "add", "-b", "feat/sibling", sibling);
  return { upstream, checkout, child, sibling };
}

nodeTest(
  "a run's changes are its own work: sibling worktrees, upstream and existing commits stay out",
  (t) => {
    const { upstream, checkout, child, sibling } = initWorktrees(t);
    const contract = { scope: ["src"], verification: ["npm test"], baseBranch: "main" };
    const snapshot = (): RepoSnapshot => captureRepoSnapshot(child, { baseBranch: "main" });
    const launch = launchPoint(child, { baseBranch: "main" });

    // A sibling commits and edits in its own worktree; the main checkout commits on the base branch.
    fs.writeFileSync(path.join(sibling, "README.md"), "sibling\n");
    git(sibling, "commit", "-am", "sibling work");
    fs.writeFileSync(path.join(sibling, "src", "allowed.ts"), "export const sibling = 1;\n");
    fs.writeFileSync(path.join(checkout, "NOTES.md"), "main checkout\n");
    git(checkout, "add", "NOTES.md");
    git(checkout, "commit", "-m", "local main work");
    const afterSibling = snapshot();
    assert.deepEqual(ownChanges(child, launch, afterSibling).files, []);
    assert.equal(
      tripwires({
        cwd: child,
        contract,
        baseline: launch,
        current: afterSibling,
        consecutiveErrors: 0,
      }),
      undefined,
    );

    // Fast-forwarding the clean worktree to upstream lists nothing.
    fs.writeFileSync(path.join(upstream, "README.md"), "upstream one\n");
    fs.writeFileSync(path.join(upstream, "UPSTREAM.md"), "one\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "upstream one");
    git(child, "fetch", "origin");
    git(child, "merge", "--ff-only", "origin/main");
    const afterFastForward = snapshot();
    assert.deepEqual(ownChanges(child, launch, afterFastForward).files, []);
    assert.equal(
      tripwires({
        cwd: child,
        contract,
        baseline: launch,
        current: afterFastForward,
        consecutiveErrors: 0,
      }),
      undefined,
    );

    // Merging newer upstream into the child's commits lists the child's files, and a file both
    // sides changed, but nothing that only upstream changed.
    fs.writeFileSync(path.join(child, "src", "allowed.ts"), "export const x = 2;\n");
    fs.writeFileSync(
      path.join(child, "src", "shared.ts"),
      "export const first = 2;\n\n\n\n\nexport const last = 1;\n",
    );
    git(child, "commit", "-am", "child work");
    fs.mkdirSync(path.join(upstream, "docs"));
    fs.writeFileSync(path.join(upstream, "docs", "UP.md"), "two\n");
    fs.writeFileSync(path.join(upstream, "README.md"), "upstream two\n");
    fs.writeFileSync(
      path.join(upstream, "src", "shared.ts"),
      "export const first = 1;\n\n\n\n\nexport const last = 2;\n",
    );
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "upstream two");
    git(child, "fetch", "origin");
    git(child, "merge", "--no-edit", "origin/main");
    const merged = ownChanges(child, launch, snapshot());
    assert.deepEqual(merged.files, ["src/allowed.ts", "src/shared.ts"]);
    assert.doesNotMatch(changesDiff(merged), /README\.md|UPSTREAM\.md|docs\/UP\.md/u);

    // A second branch stacked on the first. Switching back down with a clean worktree lists
    // nothing, whether the branches were accepted during this run or existed at its launch,
    // and an edit made after the switch shows as that edit alone.
    git(child, "checkout", "-b", "feat/child-2");
    fs.writeFileSync(path.join(child, "src", "two.ts"), "export const two = 2;\n");
    fs.appendFileSync(path.join(child, "src", "allowed.ts"), "export const upper = true;\n");
    git(child, "add", ".");
    git(child, "commit", "-m", "upper work");
    const accepted = acceptedPoint(launch, snapshot());
    for (const reviewed of [accepted, launchPoint(child, { baseBranch: "main" })]) {
      git(child, "checkout", "feat/child");
      assert.deepEqual(ownChanges(child, reviewed, snapshot()).files, []);
      fs.appendFileSync(path.join(child, "src", "allowed.ts"), "export const lower = true;\n");
      const edited = ownChanges(child, reviewed, snapshot());
      assert.deepEqual(edited.files, ["src/allowed.ts"]);
      assert.match(changesDiff(edited), /^\+export const lower = true;$/mu);
      assert.doesNotMatch(changesDiff(edited), /upper|two\.ts/u);
      git(child, "checkout", "--", "src/allowed.ts");
      git(child, "checkout", "feat/child-2");
    }

    // The overseer approves uncommitted work: a new test and an edit.
    fs.mkdirSync(path.join(child, "test"));
    fs.writeFileSync(path.join(child, "test", "foo.test.ts"), "export const covered = true;\n");
    fs.appendFileSync(path.join(child, "src", "two.ts"), "export const more = 1;\n");
    const dirty = snapshot();
    const approved = acceptedPoint(accepted, dirty);
    // Taking that work back out is new work, although the files again match the commit below.
    fs.rmSync(path.join(child, "test", "foo.test.ts"));
    git(child, "checkout", "--", "src/two.ts");
    assert.deepEqual(ownChanges(child, approved, snapshot()).files, [
      "src/two.ts",
      "test/foo.test.ts",
    ]);
    // Dropping it with a forced checkout of the branch below is new work too. The file then
    // matches the commit that was checked out, but the approved edit is in no commit.
    fs.writeFileSync(path.join(child, "test", "foo.test.ts"), "export const covered = true;\n");
    fs.appendFileSync(path.join(child, "src", "two.ts"), "export const more = 1;\n");
    git(child, "checkout", "-f", "feat/child");
    const dropped = ownChanges(child, approved, snapshot());
    assert.deepEqual(dropped.files, ["src/two.ts"]);
    assert.deepEqual(dropped.leftBehind, ["src/two.ts"]);
    git(child, "checkout", "feat/child-2");
    // Committing the approved work changes nothing the overseer has not seen.
    fs.writeFileSync(path.join(child, "test", "foo.test.ts"), "export const covered = true;\n");
    fs.appendFileSync(path.join(child, "src", "two.ts"), "export const more = 1;\n");
    git(child, "add", ".");
    git(child, "commit", "-m", "approved work");
    const committed = snapshot();
    assert.equal(committed.tree, dirty.tree);
    assert.deepEqual(ownChanges(child, approved, committed).files, []);

    // Work committed on a side branch and left there still counts, until the overseer approves it.
    const beforeSide = acceptedPoint(approved, committed);
    git(child, "checkout", "-b", "feat/side");
    fs.writeFileSync(path.join(child, "src", "side.ts"), "export const side = 1;\n");
    git(child, "add", ".");
    git(child, "commit", "-m", "side work");
    git(child, "checkout", "feat/child-2");
    const back = snapshot();
    const left = ownChanges(child, beforeSide, back);
    assert.deepEqual(left.files, ["src/side.ts"]);
    assert.deepEqual(left.leftBehind, ["src/side.ts"]);
    const afterSide = acceptedPoint(beforeSide, back);
    // Looking at commits made in other worktrees after launch, and coming back, lists nothing.
    git(child, "checkout", "--detach", "feat/sibling");
    git(child, "checkout", "--detach", "main");
    git(child, "checkout", "feat/child-2");
    assert.deepEqual(ownChanges(child, afterSide, snapshot()).files, []);
    // Measured from launch, as the completed run reports it, all of the child's work is listed.
    assert.deepEqual(ownChanges(child, launch, snapshot()).files, [
      "src/allowed.ts",
      "src/shared.ts",
      "src/side.ts",
      "src/two.ts",
      "test/foo.test.ts",
    ]);

    // An accepted working tree is an object that no ref holds. Once it is pruned the changes
    // since then cannot be computed, and that is reported instead of "no changes".
    fs.writeFileSync(path.join(child, "README.md"), "accepted drift\n");
    const unreferenced = acceptedPoint(afterSide, snapshot());
    fs.writeFileSync(path.join(child, "README.md"), "later drift\n");
    assert.deepEqual(ownChanges(child, unreferenced, snapshot()).files, ["README.md"]);
    git(child, "prune", "--expire=now");
    assert.deepEqual(ownChanges(child, unreferenced, snapshot()).files, [
      "(git-status-unavailable)",
    ]);
    // The checkpoint pauses for it whatever the scope allows.
    assert.deepEqual(
      tripwires({
        cwd: child,
        contract: { scope: ["*"], verification: ["npm test"] },
        baseline: unreferenced,
        current: snapshot(),
        consecutiveErrors: 0,
      }),
      {
        kind: "loop_violation",
        summary: "Git status became unavailable during supervised run.",
      },
    );
  },
);

type JudgeChoice = "compliant" | "scope_violation" | "primitive_violation";
const mutatingTurn = { toolResults: [{ toolName: "bash", isError: false }] };

/**
 * A supervised run on `feat/work` of a real repository, with the sentinel attached through the
 * native extension loader and a classifier that answers what `verdict` returns.
 */
async function supervisedRun(
  t: TestContext,
  options: {
    verdict: (diff: string) => JudgeChoice;
    flushPendingCommands?: () => boolean;
  },
) {
  const repo = initGitRepo(t);
  execFileSync("git", ["checkout", "-b", "feat/work"], { cwd: repo, stdio: "ignore" });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-sentinel-runs-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const owner = SessionManager.inMemory().getSessionId();
  const launch = sampleLaunch(base, repo, owner);
  // A failed assertion must not leave a paused child waiting for its overseer.
  let ended = false;
  t.after(() => {
    ended = true;
  });
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
          isStopping: () => ended,
          ...(options.flushPendingCommands === undefined
            ? {}
            : { flushPendingCommands: options.flushPendingCommands }),
        });
      },
    ],
  });
  await loader.reload();
  const ext = loader.getExtensions().extensions[0];
  assert.ok(ext !== undefined);

  const classifier = makeClassifierModel("google", "gemini-decision-1", 0.03);
  /** What the judge received on each call. */
  const judged: { changedFiles: unknown; diff: string }[] = [];
  const ctx = {
    hasPendingMessages: () => false,
    modelRegistry: {
      getAvailableOfType: () => Promise.resolve([classifier]),
      getModelOfType: () => classifier,
      classify: (_model: unknown, context: ClassifierContext) => {
        const { changedFiles, diff } = context.state;
        const asked = { changedFiles, diff: typeof diff === "string" ? diff : "" };
        judged.push(asked);
        return Promise.resolve({
          api: classifier.api,
          provider: classifier.provider,
          model: classifier.id,
          stopReason: "stop",
          timestamp: Date.now(),
          answers: {
            verdict: {
              type: "choice",
              choice: options.verdict(asked.diff),
              probabilities: {},
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
  const escPath = path.join(runDirectory(base, launch.id), "escalation.json");
  /** The escalation the paused child published. Released from the delivery queue after the test. */
  const paused = async (): Promise<Escalation> => {
    while (!fs.existsSync(escPath)) {
      await delay(10);
    }
    const escalation = read(escPath, escalationSchema);
    assert.ok(escalation !== undefined);
    t.after(() => release(owner, `escalation:${escalation.id}`));
    return escalation;
  };
  return { repo, base, launch, emit, paused, judged, escPath };
}

nodeTest(
  "attachOverseerSentinel primes baseline before turn 1 and re-judges unfixed steered drift on settle",
  async (t) => {
    let flushed = 0;
    let flushHasQueued = true;
    const { repo, base, launch, emit, paused, judged } = await supervisedRun(t, {
      verdict: () => "primitive_violation",
      flushPendingCommands: () => {
        flushed += 1;
        return flushHasQueued;
      },
    });

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
    const firstEsc = await paused();
    assert.equal(firstEsc.strikes, 1);
    resolveActiveEscalation(base, launch, "steered");
    await turnPromise;
    assert.equal(judged.length, 1);

    // Child tries to settle WITHOUT changing the drifted digest -> re-judged and caught!
    const settlePromise = emit("agent_before_settle", {
      outcome: "completed",
      entries: [],
      context: { pendingMessages: [] },
    });
    const secondEsc = await paused();
    assert.equal(secondEsc.strikes, 2);
    resolveActiveEscalation(base, launch, "steered");
    const steeredResults = await settlePromise;
    assert.equal(judged.length, 2);
    assert.equal(flushed, 1);
    assert.deepEqual(steeredResults, [{ continue: true }]);

    flushHasQueued = false;
    const approvePromise = emit("agent_before_settle", {
      outcome: "completed",
      entries: [],
      context: { pendingMessages: [] },
    });
    const thirdEsc = await paused();
    assert.equal(thirdEsc.strikes, 3);
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
    await paused();
    resolveActiveEscalation(base, launch, "steered");
    const fallbackResults = await fallbackPromise;
    assert.equal(flushed, 2);
    assert.match(JSON.stringify(fallbackResults), /overseer-sentinel/u);
  },
);

nodeTest(
  "a pause shows the work since the last approval, and the judge sees the work since the last accepted state",
  async (t) => {
    const { repo, base, launch, emit, paused, judged, escPath } = await supervisedRun(t, {
      verdict: (diff) => (diff.includes("FLAG") ? "primitive_violation" : "compliant"),
    });
    const settle = { outcome: "completed", entries: [], context: { pendingMessages: [] } };
    const manyLines = (name: string): string =>
      `${Array.from({ length: 130 }, (_, i) => `export const ${name}${i} = ${i};`).join("\n")}\n`;
    await emit("before_agent_start", {});

    // 130 new lines reach the judge at once. It finds them clean, so the child is not paused.
    fs.writeFileSync(path.join(repo, "src", "big.ts"), manyLines("big"));
    await emit("turn_end", mutatingTurn);
    assert.equal(judged.length, 1);
    assert.equal(fs.existsSync(escPath), false);

    // An out-of-scope edit pauses the child. The overseer has approved nothing yet, so the pause
    // shows everything since launch, including the work the judge cleared.
    fs.writeFileSync(path.join(repo, "README.md"), "drift\n");
    const firstTurn = emit("turn_end", mutatingTurn);
    const first = await paused();
    assert.equal(first.kind, "scope_violation");
    assert.deepEqual(first.changedFiles, ["README.md", "src/big.ts"]);
    resolveActiveEscalation(base, launch, "approved");
    // An older child still running accepts an approval by this snapshot identifier.
    assert.equal(
      read(
        path.join(runDirectory(base, launch.id), "escalation-resolution.json"),
        escalationResolutionSchema,
      )?.diffDigest,
      first.diffDigest,
    );
    await firstTurn;

    // A turn that changes nothing, and then committing the approved work, raise nothing.
    await emit("turn_end", mutatingTurn);
    git(repo, "add", ".");
    git(repo, "commit", "-m", "approved work");
    await emit("turn_end", mutatingTurn);
    assert.equal(fs.existsSync(escPath), false);

    // The next pause covers only the work after that approval.
    fs.mkdirSync(path.join(repo, "docs"));
    fs.writeFileSync(path.join(repo, "docs", "NEW.md"), "new\n");
    fs.appendFileSync(path.join(repo, "src", "allowed.ts"), "export const later = 1;\n");
    const secondTurn = emit("turn_end", mutatingTurn);
    const second = await paused();
    assert.deepEqual(second.changedFiles, ["docs/NEW.md", "src/allowed.ts"]);
    assert.match(second.diffExcerpt, /docs\/NEW\.md/u);
    assert.doesNotMatch(second.diffExcerpt, /README\.md|big\.ts/u);
    resolveActiveEscalation(base, launch, "approved");
    await secondTurn;
    assert.equal(judged.length, 1);

    // Before settling the judge sees the new work only, and flags it.
    fs.appendFileSync(path.join(repo, "src", "allowed.ts"), "// FLAG\n");
    const flaggedSettle = emit("agent_before_settle", settle);
    const third = await paused();
    assert.equal(third.kind, "primitive_violation");
    assert.deepEqual(third.changedFiles, ["src/allowed.ts"]);
    assert.equal(judged.length, 2);
    assert.deepEqual(judged[1], {
      changedFiles: ["src/allowed.ts"],
      diff: [
        "diff --git a/src/allowed.ts b/src/allowed.ts",
        "index 5dc3114..46469ae 100644",
        "--- a/src/allowed.ts",
        "+++ b/src/allowed.ts",
        "@@ -1,2 +1,3 @@",
        " export const x = 1;",
        " export const later = 1;",
        "+// FLAG",
        "",
      ].join("\n"),
    });
    resolveActiveEscalation(base, launch, "steered");
    await flaggedSettle;

    // The steered child leaves the flagged state as it is: the judge is not asked again.
    for (let turn = 0; turn < 5; turn += 1) {
      await emit("turn_end", mutatingTurn);
    }
    assert.equal(judged.length, 2);
    assert.equal(fs.existsSync(escPath), false);

    // Once the state changes the pending turn trigger asks the judge, which clears the fix.
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "export const fixed = 1;\n");
    await emit("turn_end", mutatingTurn);
    assert.equal(judged.length, 3);
    // Every existing trigger still reaches the judge when there is new work: the fourth mutating turn,
    for (let turn = 0; turn < 3; turn += 1) {
      fs.appendFileSync(path.join(repo, "src", "allowed.ts"), `export const step${turn} = 1;\n`);
      await emit("turn_end", mutatingTurn);
    }
    assert.equal(judged.length, 3);
    fs.appendFileSync(path.join(repo, "src", "allowed.ts"), "export const fourth = 1;\n");
    await emit("turn_end", mutatingTurn);
    assert.equal(judged.length, 4);
    // 120 or more new lines,
    fs.writeFileSync(path.join(repo, "src", "bulk.ts"), manyLines("bulk"));
    await emit("turn_end", mutatingTurn);
    assert.equal(judged.length, 5);
    // and the checkpoint before the run settles.
    fs.appendFileSync(path.join(repo, "src", "allowed.ts"), "export const last = 1;\n");
    assert.deepEqual(await emit("agent_before_settle", settle), [undefined]);
    assert.equal(judged.length, 6);
    assert.equal(fs.existsSync(escPath), false);
  },
);

nodeTest("an approved base-branch issue is not raised again for later work", async (t) => {
  const { repo, base, launch, emit, paused, escPath } = await supervisedRun(t, {
    verdict: () => "compliant",
  });
  await emit("before_agent_start", {});

  fs.appendFileSync(path.join(repo, "src", "allowed.ts"), "export const y = 1;\n");
  git(repo, "commit", "-am", "work");
  git(repo, "branch", "-f", "main", "HEAD");
  const turn = emit("turn_end", mutatingTurn);
  const pause = await paused();
  assert.equal(pause.kind, "branch_violation");
  assert.match(pause.summary, /committed directly onto base branch 'main'/u);
  resolveActiveEscalation(base, launch, "approved");
  await turn;

  fs.appendFileSync(path.join(repo, "src", "allowed.ts"), "export const z = 1;\n");
  git(repo, "commit", "-am", "more work");
  await emit("turn_end", mutatingTurn);
  assert.equal(fs.existsSync(escPath), false);
});

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

    let resolved = false;
    const waiting = (async () => {
      await waitForEscalationResolution({
        base,
        launch,
        escalation,
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
      isStopping: () => false,
    });
    assert.equal(preSteeredVerdict, "steered");
  },
);
