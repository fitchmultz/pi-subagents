import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Escalation, Launch, Result } from "../../src/agent/contracts.ts";
import { captureRepoSnapshot, changedFilesSinceBaseline } from "../../src/agent/overseer-judge.ts";
import {
  buildReviewGateDraft,
  needsOverseerReview,
  prepareOverseerReviewAction,
  readReview,
  recordOverseerReview,
  unreviewedCompletedRuns,
} from "../../src/agent/overseer-review.ts";
import { waitForEscalationResolution } from "../../src/agent/overseer-sentinel.ts";
import { captureOverseerBaseline } from "../../src/agent/run-result.ts";
import { runDirectory, write } from "../../src/agent/storage.ts";
import { renderInspection } from "../../src/agent/view.ts";

function makeLaunch(
  base: string,
  id: string,
  owner: string,
  options: { overseen?: boolean; scope?: string[] } = {},
): Launch {
  const launch: Launch = {
    version: 1,
    id,
    rootId: id,
    owner,
    cwd: base,
    agentDir: base,
    sdk: base,
    entry: path.join(base, "dist", "index.js"),
    sessionFile: path.join(base, `${id}.jsonl`),
    sessionId: `session-${id}`,
    prompt: "Implement feature",
    context: "fresh",
    provider: "google",
    model: "gemini-4-hydrogen",
    thinking: "high",
    trusted: true,
    name: id,
    ...(options.overseen !== false
      ? {
          contract: { scope: options.scope ?? ["src"], verification: ["npm test"] },
          overseer: { enabled: true as const, judge: "auto" },
        }
      : {}),
    createdAt: Date.now(),
  };
  const dir = runDirectory(base, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  write(path.join(dir, "launch.json"), launch, true);
  return launch;
}

function writeCompletedResult(base: string, launch: Launch, changedFiles?: string[]): Result {
  const result: Result = {
    id: launch.id,
    owner: launch.owner,
    status: "completed",
    endedAt: Date.now(),
    ...(changedFiles !== undefined ? { changedFiles } : {}),
  };
  const dir = runDirectory(base, launch.id);
  fs.writeFileSync(path.join(dir, "output.txt"), "done", { mode: 0o600 });
  write(path.join(dir, "result.json"), result);
  return result;
}

nodeTest(
  "overseer review gate requires approval only for completed mutating overseen runs with delivered receipts",
  (t: TestContext) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-review-"));
    t.after(() => {
      fs.rmSync(temp, { recursive: true, force: true });
    });

    const parentSession = SessionManager.inMemory();
    const owner = parentSession.getSessionId();
    const base = path.join(temp, "runs");

    const mutating = makeLaunch(base, "mutating-run", owner);
    const mutatingResult = writeCompletedResult(base, mutating, ["src/db.ts"]);

    const readOnly = makeLaunch(base, "readonly-run", owner, { scope: [] });
    const readOnlyResult = writeCompletedResult(base, readOnly);

    assert.equal(needsOverseerReview(base, mutating, mutatingResult), true);
    assert.equal(needsOverseerReview(base, readOnly, readOnlyResult), false);

    // Before parent receives the completion receipt, settle is not blocked.
    assert.deepEqual(unreviewedCompletedRuns({ sessionManager: parentSession }, base, owner), []);

    // Record completion receipts in parent session transcript.
    parentSession.appendCustomMessageEntry("agent-completion", "done", true, {
      owner,
      id: mutating.id,
      completed: true,
    });
    parentSession.appendCustomMessageEntry("agent-completion", "done", true, {
      owner,
      id: readOnly.id,
      completed: true,
    });

    const pending = unreviewedCompletedRuns({ sessionManager: parentSession }, base, owner);
    assert.deepEqual(
      pending.map((entry) => entry.launch.id),
      ["mutating-run"],
    );

    const reminders = new Map<string, number>();
    const firstDraft = buildReviewGateDraft(pending, reminders);
    assert.ok(firstDraft !== undefined);
    assert.match(firstDraft.content, /mutating-run/u);
    assert.equal(buildReviewGateDraft(pending, reminders) !== undefined, true);
    // Bounded at 2 reminders per run so a misbehaving model cannot loop forever.
    assert.equal(buildReviewGateDraft(pending, reminders), undefined);

    // Recording approval satisfies the review gate immediately.
    const saved = recordOverseerReview(
      base,
      mutating,
      "approved",
      "Verified git diff in src/db.ts uses createTagStore() and unit tests pass.",
    );
    assert.equal(saved.verdict, "approved");
    assert.equal(readReview(base, mutating.id)?.verdict, "approved");
    assert.deepEqual(unreviewedCompletedRuns({ sessionManager: parentSession }, base, owner), []);
  },
);

nodeTest(
  "approving a paused mid-run escalation via recordOverseerReview allowlists the diff digest and unpauses",
  async (t: TestContext) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-approve-"));
    t.after(() => {
      fs.rmSync(temp, { recursive: true, force: true });
    });

    const base = path.join(temp, "runs");
    const launch = makeLaunch(base, "paused-run", "owner-1");
    const escalation: Escalation = {
      id: "esc-approve-1",
      runId: launch.id,
      owner: "owner-1",
      at: Date.now(),
      strikes: 1,
      kind: "scope_violation",
      summary: "Judge false positive",
      changedFiles: ["src/db.ts"],
      diffExcerpt: "+// valid change",
      diffDigest: "approved-digest-abc",
    };

    const approvedDigests = new Set<string>();
    const waiting = waitForEscalationResolution({
      base,
      launch,
      escalation,
      approvedDigests,
      isStopping: () => false,
    });

    recordOverseerReview(base, launch, "approved", "Inspected diff; change is within contract.");
    await waiting;
    assert.equal(approvedDigests.has("approved-digest-abc"), true);

    // Mid-run escalation approval predates final completion, so final completion still requires review.
    const completedAfterPause: Result = {
      id: launch.id,
      owner: launch.owner,
      status: "completed",
      endedAt: Date.now() + 1000,
      changedFiles: ["src/allowed.ts", "src/extra.ts"],
    };
    write(path.join(runDirectory(base, launch.id), "result.json"), completedAfterPause);
    assert.equal(needsOverseerReview(base, launch, completedAfterPause), true);
    const midRunInspect = renderInspection(base, launch);
    const inspectText = midRunInspect.content[0]?.text ?? "";
    assert.match(inspectText, /Overseer review: approved at /u);
    assert.match(inspectText, /Overseer review: required before parent settles\./u);
    recordOverseerReview(base, launch, "approved", "Verified final diff across both files.");
    assert.equal(needsOverseerReview(base, launch, completedAfterPause), false);

    // Continuing launch -> tipB and calling review(id=launch.id, verdict="approved") while tipB
    // is paused resolves tipB's active escalation instead of stranding the live tip.
    const tipB: Launch = { ...launch, id: "paused-tip-b", predecessor: launch.id };
    const tipDir = runDirectory(base, tipB.id);
    fs.mkdirSync(tipDir, { recursive: true, mode: 0o700 });
    write(path.join(tipDir, "launch.json"), tipB, true);
    write(path.join(runDirectory(base, launch.id), "successor.json"), { id: tipB.id }, true);
    const tipDigests = new Set<string>();
    const tipWait = waitForEscalationResolution({
      base,
      launch: tipB,
      escalation: { ...escalation, id: "esc-tip-b", runId: tipB.id, diffDigest: "tip-digest" },
      approvedDigests: tipDigests,
      isStopping: () => false,
    });
    const actionResult = prepareOverseerReviewAction(base, launch, {
      action: "review",
      id: launch.id,
      verdict: "approved",
      summary: "Approved paused tip via predecessor id.",
    });
    assert.equal(actionResult.target.id, tipB.id);
    await tipWait;
    assert.equal(tipDigests.has("tip-digest"), true);

    // Unborn empty Git repo where a scope:[] child makes the first commit still populates
    // changedFiles so needsOverseerReview gates parent settlement.
    const unbornRepo = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-review-unborn-"));
    t.after(() => fs.rmSync(unbornRepo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-b", "main"], { cwd: unbornRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: unbornRepo,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: unbornRepo, stdio: "ignore" });
    const unbornLaunch: Launch = {
      ...makeLaunch(base, "unborn-readonly", launch.owner, { scope: [] }),
      cwd: unbornRepo,
    };
    const unbornBaseline = captureOverseerBaseline(base, unbornLaunch);
    assert.ok(unbornBaseline !== undefined);
    fs.writeFileSync(path.join(unbornRepo, "first.txt"), "hello\n");
    execFileSync("git", ["add", "first.txt"], { cwd: unbornRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: unbornRepo, stdio: "ignore" });
    const unbornCurrent = captureRepoSnapshot(unbornRepo, {
      baselineHead: unbornBaseline.head,
      hasBaseline: true,
    });
    const unbornChanged = changedFilesSinceBaseline(unbornRepo, unbornBaseline, unbornCurrent);
    assert.deepEqual(unbornChanged, ["first.txt"]);
    const unbornResult: Result = {
      id: unbornLaunch.id,
      owner: launch.owner,
      status: "completed",
      endedAt: Date.now(),
      changedFiles: unbornChanged,
    };
    assert.equal(needsOverseerReview(base, unbornLaunch, unbornResult), true);

    // Commits left on a side branch after checking out baseline branch still require review.
    execFileSync("git", ["checkout", "-b", "feat/side"], { cwd: unbornRepo, stdio: "ignore" });
    const sideLaunch: Launch = {
      ...makeLaunch(base, "side-branch", launch.owner, { scope: ["src"] }),
      cwd: unbornRepo,
    };
    execFileSync("git", ["checkout", "main"], { cwd: unbornRepo, stdio: "ignore" });
    const sideBaseline = captureOverseerBaseline(base, sideLaunch);
    assert.ok(sideBaseline !== undefined);
    execFileSync("git", ["checkout", "feat/side"], { cwd: unbornRepo, stdio: "ignore" });
    fs.mkdirSync(path.join(unbornRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(unbornRepo, "src", "side.ts"), "export const s = 1;\n");
    execFileSync("git", ["add", "src/side.ts"], { cwd: unbornRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "side commit"], { cwd: unbornRepo, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: unbornRepo, stdio: "ignore" });
    const sideCurrent = captureRepoSnapshot(unbornRepo, {
      baselineHead: sideBaseline.head,
      hasBaseline: true,
    });
    const sideChanged = changedFilesSinceBaseline(unbornRepo, sideBaseline, sideCurrent);
    assert.deepEqual(sideChanged, ["src/side.ts"]);
    assert.equal(
      needsOverseerReview(base, sideLaunch, {
        id: sideLaunch.id,
        owner: launch.owner,
        status: "completed",
        endedAt: Date.now(),
        changedFiles: sideChanged,
      }),
      true,
    );
  },
);
