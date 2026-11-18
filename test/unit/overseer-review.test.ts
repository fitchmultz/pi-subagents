import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Escalation, Launch, Result } from "../../src/agent/contracts.ts";
import { notifications, release } from "../../src/agent/notifications.ts";
import { captureRepoSnapshot, ownChanges } from "../../src/agent/overseer-git.ts";
import {
  buildReviewGateDraft,
  needsOverseerReview,
  prepareOverseerReviewAction,
  readReview,
  recordOverseerReview,
  unreviewedCompletedRuns,
} from "../../src/agent/overseer-review.ts";
import { EscalationPause } from "../../src/agent/overseer-pause.ts";
import { captureOverseerBaseline } from "../../src/agent/run-result.ts";
import { runDirectory, write } from "../../src/agent/storage.ts";
import { pauseLabel } from "../../src/agent/run-state.ts";
import { renderInspection, renderReceipt } from "../../src/agent/view.ts";

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
    assert.match(firstDraft.content, /summary="\.\.\."/u);
    assert.match(firstDraft.content, /"approved".*"changes_requested"/u);
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
  "approving a paused mid-run escalation records its digest and unpauses",
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

    const waiting = new EscalationPause(launch.id).wait(base, escalation, () => false);
    const approval = prepareOverseerReviewAction(base, launch, {
      action: "review",
      verdict: "approved",
      summary: "Inspected diff; change is within contract.",
    });
    assert.equal(approval.released, true);
    assert.deepEqual(await waiting, { verdict: "approved" });

    // Every pause notice offers steer, approve and stop, each with its required `summary="..."`.
    // Earlier steering is context, not evidence about the worker or a reason to stop it.
    const escFile = path.join(runDirectory(base, launch.id), "escalation.json");
    const options =
      'Steer (`agent_runs` `action="continue"` or `action="review"`, `verdict="changes_requested"`, `summary="..."`), approve (`action="review"`, `verdict="approved"`, `summary="..."`), or `action="stop"`.';
    const closing = (
      id: string,
      counts: Pick<Escalation, "strikes" | "steers" | "corrections">,
    ): string => {
      write(escFile, { ...escalation, id, ...counts });
      t.after(() => release(launch.owner, `escalation:${id}`));
      const [notice] = notifications(
        { sessionManager: SessionManager.inMemory() },
        base,
        launch.owner,
      ).notices;
      fs.rmSync(escFile, { force: true });
      const content = notice?.message.content;
      assert.ok(typeof content === "string");
      assert.match(content, new RegExp(`^\\[Overseer escalation #${counts.strikes} - `, "u"));
      return content.split("\n").slice(3).join("\n");
    };
    assert.equal(closing("esc-older-child", { strikes: 3 }), `+// valid change\n${options}`);
    assert.equal(
      closing("esc-approved-twice", { strikes: 3, corrections: 0 }),
      `+// valid change\n${options}`,
    );
    assert.equal(
      closing("esc-steered-twice", { strikes: 3, steers: 2 }),
      `+// valid change\nEarlier pauses answered with steering: 2.\n${options}`,
    );
    assert.equal(
      closing("esc-legacy-steered-thrice", { strikes: 5, corrections: 3 }),
      `+// valid change\nEarlier pauses answered with steering: 3.\n${options}`,
    );
    // The inventory, the inspection and the observer print the same two counts.
    assert.equal(pauseLabel({ ...escalation, strikes: 3 }), "scope_violation #3");
    assert.equal(
      pauseLabel({ ...escalation, strikes: 3, corrections: 1 }),
      "scope_violation #3, 1 steer",
    );
    assert.equal(
      pauseLabel({ ...escalation, strikes: 5, corrections: 3 }),
      "scope_violation #5, 3 steers",
    );

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
    t.after(() => release(launch.owner, launch.id));
    const unreviewedCompletion = notifications(
      { sessionManager: SessionManager.inMemory() },
      base,
      launch.owner,
    ).notices.find((item) => item.id === launch.id);
    const unreviewedText =
      typeof unreviewedCompletion?.message.content === "string"
        ? unreviewedCompletion.message.content
        : "";
    assert.match(unreviewedText, /Check current review status.*approved or changes_requested/u);
    release(launch.owner, launch.id);
    const midRunInspect = renderInspection(base, launch);
    const inspectText = midRunInspect.content[0]?.text ?? "";
    assert.match(inspectText, /Overseer review: approved at /u);
    assert.match(inspectText, /Overseer review: required before parent settles\./u);
    const finalReview = recordOverseerReview(
      base,
      launch,
      "approved",
      "Verified final diff across both files.",
    );
    assert.equal(needsOverseerReview(base, launch, completedAfterPause), false);
    // The reply to the review confirms it and says what follows. It does not repeat the run
    // record or the child's report.
    fs.writeFileSync(path.join(runDirectory(base, launch.id), "output.txt"), "The final report.\n");
    assert.match(renderInspection(base, launch).content[0]?.text ?? "", /The final report\./u);
    assert.equal(
      renderReceipt(base, launch, undefined, {
        receipt: "review",
        review: finalReview,
        released: false,
      }).content[0]?.text,
      [
        `Overseer review recorded: run paused-run (paused-run) approved at ${new Date(finalReview.at).toISOString().slice(0, 19)}Z.`,
        "The run's status is completed; it needs no further review.",
        'Summary saved for review only. It was not sent to the child. Use `agent_runs` `action="continue"` to send instructions.',
      ].join("\n"),
    );
    const approvedCompletion = notifications(
      { sessionManager: SessionManager.inMemory() },
      base,
      launch.owner,
    ).notices.find((item) => item.id === launch.id);
    const approvedText =
      typeof approvedCompletion?.message.content === "string"
        ? approvedCompletion.message.content
        : "";
    assert.doesNotMatch(approvedText, /Overseer review required:/u);
    release(launch.owner, launch.id);

    // Clear review.json so the superseded-run check below exercises successor.json independently.
    fs.rmSync(path.join(runDirectory(base, launch.id), "review.json"), { force: true });
    assert.equal(needsOverseerReview(base, launch, completedAfterPause), true);

    // Continuing launch -> tipB and calling review(id=launch.id, verdict="approved") while tipB
    // is paused resolves tipB's active escalation instead of stranding the live tip.
    const tipB: Launch = { ...launch, id: "paused-tip-b", predecessor: launch.id };
    const tipDir = runDirectory(base, tipB.id);
    fs.mkdirSync(tipDir, { recursive: true, mode: 0o700 });
    write(path.join(tipDir, "launch.json"), tipB, true);
    write(path.join(runDirectory(base, launch.id), "successor.json"), { id: tipB.id }, true);
    // An unapproved run does not hold up settlement once it has a successor.
    assert.equal(needsOverseerReview(base, launch, completedAfterPause), false);
    const supersededCompletion = notifications(
      { sessionManager: SessionManager.inMemory() },
      base,
      launch.owner,
    ).notices.find((item) => item.id === launch.id);
    const supersededText =
      typeof supersededCompletion?.message.content === "string"
        ? supersededCompletion.message.content
        : "";
    assert.doesNotMatch(supersededText, /Overseer review required:/u);
    release(launch.owner, launch.id);
    const tipWait = new EscalationPause(tipB.id).wait(
      base,
      { ...escalation, id: "esc-tip-b", runId: tipB.id, diffDigest: "tip-digest" },
      () => false,
    );
    const actionResult = prepareOverseerReviewAction(base, launch, {
      action: "review",
      id: launch.id,
      verdict: "approved",
      summary: "Approved paused tip via predecessor id.",
    });
    assert.equal(actionResult.target.id, tipB.id);
    assert.equal(actionResult.released, true);
    assert.deepEqual(await tipWait, { verdict: "approved" });

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
    const unbornCurrent = captureRepoSnapshot(unbornRepo);
    const unbornChanged = ownChanges(unbornRepo, unbornBaseline, unbornCurrent).files;
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
    const sideCurrent = captureRepoSnapshot(unbornRepo);
    const sideChanged = ownChanges(unbornRepo, sideBaseline, sideCurrent).files;
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

    // Non-Git directory at launch where the child runs `git init` and commits still requires review.
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-review-nongit-"));
    t.after(() => fs.rmSync(nonGitDir, { recursive: true, force: true }));
    const nonGitLaunch: Launch = {
      ...makeLaunch(base, "nongit-init", launch.owner, { scope: ["src"] }),
      cwd: nonGitDir,
    };
    const nonGitBaseline = captureOverseerBaseline(base, nonGitLaunch);
    assert.equal(nonGitBaseline?.snapshot.isGit, false);
    execFileSync("git", ["init", "-b", "main"], { cwd: nonGitDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: nonGitDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: nonGitDir, stdio: "ignore" });
    fs.mkdirSync(path.join(nonGitDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(nonGitDir, "src", "greenfield.ts"), "export const g = 1;\n");
    execFileSync("git", ["add", "src/greenfield.ts"], { cwd: nonGitDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "greenfield"], { cwd: nonGitDir, stdio: "ignore" });
    const nonGitCurrent = captureRepoSnapshot(nonGitDir);
    const nonGitChanged = ownChanges(nonGitDir, nonGitBaseline, nonGitCurrent).files;
    assert.deepEqual(nonGitChanged, ["src/greenfield.ts"]);
    assert.equal(
      needsOverseerReview(base, nonGitLaunch, {
        id: nonGitLaunch.id,
        owner: launch.owner,
        status: "completed",
        endedAt: Date.now(),
        changedFiles: nonGitChanged,
      }),
      true,
    );

    // If baseline was a Git repo and completion git status fails (or .git disappears),
    // ownChanges fails closed so needsOverseerReview still gates settlement.
    const gitBaseline = captureOverseerBaseline(base, nonGitLaunch);
    assert.ok(gitBaseline !== undefined);
    fs.rmSync(path.join(nonGitDir, ".git"), { recursive: true, force: true });
    const brokenChanged = ownChanges(nonGitDir, gitBaseline, captureRepoSnapshot(nonGitDir)).files;
    assert.deepEqual(brokenChanged, ["(git-status-unavailable)"]);
    assert.equal(
      needsOverseerReview(base, nonGitLaunch, {
        id: nonGitLaunch.id,
        owner: launch.owner,
        status: "completed",
        endedAt: Date.now(),
        changedFiles: brokenChanged,
      }),
      true,
    );
  },
);
