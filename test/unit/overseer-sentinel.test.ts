import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Escalation, Launch } from "../../src/agent/contracts.ts";
import { notifications, release } from "../../src/agent/notifications.ts";
import {
  captureRepoSnapshot,
  changedFilesSinceBaseline,
  checkDeterministicTripwires,
  evaluateDecisionCheckpoint,
} from "../../src/agent/overseer-judge.ts";
import {
  resolveActiveEscalation,
  waitForEscalationResolution,
} from "../../src/agent/overseer-sentinel.ts";
import { runDirectory, write } from "../../src/agent/storage.ts";

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
  fs.writeFileSync(path.join(dir, "src", "allowed.ts"), "export const x = 1;\n");
  git("add", ".");
  git("commit", "-m", "initial");
  return dir;
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
  "deterministic tripwires ignore pre-existing dirty files and catch scope, branch, and loop violations",
  (t) => {
    const repo = initGitRepo(t);
    fs.writeFileSync(path.join(repo, "preexisting-notes.md"), "untouched\n");
    execFileSync("git", ["checkout", "-b", "feat/work"], { cwd: repo, stdio: "ignore" });

    const baseline = captureRepoSnapshot(repo);
    const contract = {
      scope: ["src"],
      verification: ["npm test"],
      baseBranch: "main",
    };

    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "export const x = 2;\n");
    const cleanSnap = captureRepoSnapshot(repo, baseline.head);
    assert.deepEqual(changedFilesSinceBaseline(repo, baseline, cleanSnap), ["src/allowed.ts"]);
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

    const loopHit = checkDeterministicTripwires({
      cwd: repo,
      contract,
      baseline,
      current: cleanSnap,
      consecutiveErrors: 3,
    });
    assert.equal(loopHit?.kind, "loop_violation");

    fs.writeFileSync(path.join(repo, "README.md"), "unrequested\n");
    const scopeSnap = captureRepoSnapshot(repo, baseline.head);
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

    fs.rmSync(path.join(repo, "README.md"));
    execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
    const mainBaseline = captureRepoSnapshot(repo);
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "export const x = 3;\n");
    execFileSync("git", ["commit", "-am", "direct main commit"], { cwd: repo, stdio: "ignore" });
    const mainAfter = captureRepoSnapshot(repo, mainBaseline.head);
    const branchHit = checkDeterministicTripwires({
      cwd: repo,
      contract,
      baseline: mainBaseline,
      current: mainAfter,
      consecutiveErrors: 0,
    });
    assert.equal(branchHit?.kind, "branch_violation");
  },
);

nodeTest(
  "evaluateDecisionCheckpoint prioritizes google/gemini-decision-1 and flags high-confidence primitive drift",
  async (t) => {
    const repo = initGitRepo(t);
    const baseline = captureRepoSnapshot(repo);
    fs.writeFileSync(path.join(repo, "src", "allowed.ts"), "const customCache = new Map();\n");
    const snap = captureRepoSnapshot(repo, baseline.head);

    const chosenModels: string[] = [];
    const fakeRegistry = {
      getAvailableOfType: () =>
        Promise.resolve([
          { provider: "openai", id: "gpt-6-luna" },
          { provider: "google", id: "gemini-decision-1" },
        ]),
      classify: (model: { provider: string; id: string }) => {
        chosenModels.push(`${model.provider}/${model.id}`);
        return Promise.resolve({
          stopReason: "stop",
          answers: {
            scope_violation: { type: "bool", probability: 0.12 },
            primitive_violation: { type: "bool", probability: 0.91 },
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
  },
);
