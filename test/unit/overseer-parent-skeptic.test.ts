import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isHighImpactBash } from "../../src/agent/overseer-bash-gate.ts";
import {
  attachParentSkeptic,
  extractParentAction,
  validateParentFindings,
} from "../../src/agent/overseer-parent-skeptic.ts";
import type { SkepticModelRegistry } from "../../src/agent/overseer-skeptic.ts";
import { captureOwnerBranchContext, type OverseerState } from "../../src/agent/overseer.ts";
import { record } from "../support/assertions.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";

function makeModel(provider: string, id: string, reasoning = true): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "http://127.0.0.1",
    reasoning,
    input: ["text"],
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
}

function fakeAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}

function makeRegistry(
  models: readonly Model<Api>[],
  responder: (model: Model<Api>, prompt: string) => Promise<AssistantMessage>,
): SkepticModelRegistry {
  return {
    getAvailable: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    streamSimple: (model, context) => {
      const first = context.messages[0];
      const text = typeof first?.content === "string" ? first.content : "";
      const promise = responder(model, text);
      return { result: () => promise };
    },
  };
}

nodeDescribe("overseer parent-side skeptic classification and grounding", () => {
  nodeIt("targets only delegate, continue-with-prompt, and high-impact bash commands", () => {
    for (const cmd of [
      "gh-personal pr merge 497 --squash",
      "gh -R owner/repo pr merge 42",
      "gh --repo o/r pr merge",
      "gh-personal -R fitchmultz/x pr merge 3",
      "gh -R a/b release create v1",
      "gh pr -R owner/repo merge 42",
      "git push -u origin main",
      "git -C wt push origin feat",
      "git commit --no-verify -m 'skip hooks'",
      "git commit -nm 'skip hooks'",
      'git commit -m "" --no-verify',
      'git commit -am "msg" -n',
      "(git commit --no-verify -m 'skip hooks')",
      "git reset --hard HEAD~1",
      "git reset HEAD~1 --hard",
      "git clean -fd",
      "git clean -fdx",
      "git clean --force",
      "npm publish",
      "pnpm -r publish",
      "npm --workspace pkg publish",
      "npm --prefix packages/a publish",
      "yarn --cwd packages/a publish",
      "wrangler deploy",
      "npx wrangler deploy",
      "chezmoi apply",
      "chezmoi --source ~/.dotfiles apply",
      "chezmoi -S ~/.dotfiles apply",
      "sudo git push origin main",
      "/usr/bin/git push origin main",
      "/usr/local/bin/gh pr merge 42",
      "bash -c 'git push origin main'",
      "bash -lc 'cd repo && git push origin main'",
      "(cd repo && git push)",
      "env FOO=1 git push",
      "if git push; then echo ok; fi",
      "git status # owner's note — don't push\ngit push",
      "cat > notes.md <<'EOF'\nWe won't merge yet.\nEOF\ngh pr merge 12 --squash",
      "cat > f <<END-OF-FILE\nbody\nEND-OF-FILE\ngh pr merge 1",
      "cat > main.cpp <<C++\nint main() { return 0; }\nC++\ngit push origin main",
      "cat > f <<EOF[1]\nbody\nEOF[1]\ngit push",
      'read -r out <<< "$state"\ngit push',
      "cat <<<note\ngh pr merge 42",
      "echo '<<EOF'\ngit push",
      "grep -n '<<EOF' docs/reference.md\ngit push",
      "echo $((1<<shift))\ngit push",
      "(( i << 1 ))\ngit push",
      "(( x <<= 1 ))\ngh pr merge 1",
      "for ((i=0;i<8;i<<=1)); do\ngit push\ndone",
      "echo $[1<<2]\ngh pr merge 2",
      "a[1<<2]=5\ngit push",
      "arr[i<<2]=1\ngh pr merge 1",
      "echo ${x#<<2}\ngit push",
      "echo ${x//<<2/c}\ngit push",
      "echo ${x:-1<<2}\ngit push",
      "bash <<'EOF'\ncd repo\ngit push\nEOF",
      "sh <<'EOF'\ncd repo\ngh pr merge 1\nEOF",
      "sudo bash -s <<EOF\ngit push\nEOF",
    ]) {
      assert.equal(isHighImpactBash(cmd), true, cmd);
    }

    for (const cmd of [
      "cat > notes.md <<EOF\ngit push\nEOF\ngit status",
      "gh -R owner/repo pr view 42",
      "git status --short",
      "git commit -m 'local work'",
      'git commit -m "feat: gate bash\n\ngit push and gh pr merge now need approval."',
      'git commit -m "clarify --no-verify gating"',
      'git commit -m "document -n short flag"',
      'git commit -m "-n"',
      'git commit -m"--no-verify"',
      `git commit -m"don't skip hooks"`,
      'git commit -m "(keep --no-verify)"',
      'git commit -unormal -m "normal commit"',
      "git commit -- -n",
      'gh pr create --body "Before:\n\ngh pr merge 12\n\nAfter: gated"',
      "git commit -m 'subject\n\nnpm publish is gated'",
      "npm run test:unit",
      "npm run publish",
      "rg -n foo src/",
      "echo 'git push'",
      "echo 'foo; git push'",
      "# git push",
    ]) {
      assert.equal(isHighImpactBash(cmd), false, cmd);
    }
    // Linear time on long option chains (regression against regex backtracking).
    const start = performance.now();
    assert.equal(isHighImpactBash(`npm ${"--flag ".repeat(500)}run`), false);
    assert.equal(isHighImpactBash(`wrangler ${"--flag ".repeat(500)}tail`), false);
    assert.ok(performance.now() - start < 200);

    const delegated = extractParentAction("delegate", {
      prompt: "Implement X",
      name: "x",
      cwd: "/repo/main",
      readOnly: false,
    });
    assert.ok(delegated !== undefined);
    assert.equal(delegated.kind, "delegate");
    assert.match(delegated.text, /"cwd":"\/repo\/main"/u);
    assert.match(delegated.text, /"readOnly":false/u);
    const continued = extractParentAction("agent_runs", {
      action: "continue",
      id: "r1",
      prompt: "Merge now",
    });
    assert.ok(continued !== undefined);
    assert.equal(continued.kind, "continue");
    assert.match(continued.text, /"id":"r1"/u);
    assert.equal(extractParentAction("agent_runs", { action: "continue", id: "r1" }), undefined);
    assert.equal(extractParentAction("agent_runs", { action: "list" }), undefined);
    assert.equal(extractParentAction("read", { path: "README.md" }), undefined);
    assert.equal(extractParentAction("bash", { command: "git status" }), undefined);
    assert.equal(extractParentAction("bash", { command: "gh pr merge 12 --squash" })?.kind, "bash");
  });

  nodeIt(
    "requires both ownerExcerpt and actionExcerpt verbatim and drops ungrounded blocks",
    () => {
      const owner = "Hold merge until the whole stack is ready.\n---\nKeep edits scoped to src/.";
      const action = "Merge PR #1 right away once CI passes.";
      const raw = {
        action: "block",
        findings: [
          {
            kind: "contradicts_owner",
            ownerExcerpt: "Hold merge until the whole stack is ready.",
            actionExcerpt: "Merge PR #1 right away",
            why: "Owner explicitly placed a merge hold on the stack.",
            blocking: true,
          },
          {
            kind: "contradicts_owner",
            ownerExcerpt: "fabricated owner rule not in session",
            actionExcerpt: "Merge PR #1 right away",
            why: "Must be dropped because owner quote is fabricated.",
            blocking: true,
          },
          {
            kind: "dropped_constraint",
            ownerExcerpt: "Keep edits scoped to src/.",
            actionExcerpt: "fabricated action quote",
            why: "Must be dropped because action quote is fabricated.",
            blocking: true,
          },
        ],
      };
      const checked = validateParentFindings(raw, owner, action);
      assert.ok(checked.ok);
      assert.equal(checked.blocking.length, 1);
      assert.equal(checked.notes.length, 0);
      assert.equal(checked.droppedUngrounded, 2);

      const allBad = validateParentFindings(
        JSON.stringify({
          action: "block",
          findings: [
            {
              kind: "contradicts_owner",
              ownerExcerpt: "not actually said",
              actionExcerpt: "Merge PR #1 right away",
              why: "Ungrounded.",
              blocking: true,
            },
          ],
        }),
        owner,
        action,
      );
      assert.ok(allBad.ok);
      assert.equal(allBad.blocking.length, 0);
      assert.equal(allBad.droppedUngrounded, 1);

      // Absence-of-proof `unverified_action` findings are rejected by the schema.
      const rejectedUnverified = validateParentFindings(
        {
          action: "block",
          findings: [
            {
              kind: "unverified_action",
              ownerExcerpt: "Hold merge until the whole stack is ready.",
              actionExcerpt: "Merge PR #1 right away",
              why: "No proof in command.",
              blocking: true,
            },
          ],
        },
        owner,
        action,
      );
      assert.equal(rejectedUnverified.ok, false);

      // Owner-only grounding rejects excerpts that only appear in assistant text.
      const assistantOnly = validateParentFindings(
        {
          action: "block",
          findings: [
            {
              kind: "contradicts_owner",
              ownerExcerpt: "Assistant proposed keeping typebox in registerTool",
              actionExcerpt: "Merge PR #1 right away",
              why: "Quoted assistant text instead of owner text.",
              blocking: true,
            },
          ],
        },
        ["Hold merge until the whole stack is ready."],
        action,
      );
      assert.ok(assistantOnly.ok);
      assert.equal(assistantOnly.blocking.length, 0);
      assert.equal(assistantOnly.droppedUngrounded, 1);

      // Wrapped whitespace/indentation in pasted owner prompts still satisfies verbatim grounding.
      const wrappedOwner = "merge once checks and required reviews\n  are green";
      const wrapped = validateParentFindings(
        {
          action: "block",
          findings: [
            {
              kind: "contradicts_owner",
              ownerExcerpt: "merge once checks and required reviews are green",
              actionExcerpt: "Merge PR #1 right away",
              why: "Wrapped whitespace should not drop a grounded catch.",
              blocking: true,
            },
          ],
        },
        [wrappedOwner],
        action,
      );
      assert.ok(wrapped.ok);
      assert.equal(wrapped.blocking.length, 1);

      // Standing protection bypasses ground on the literal bypass flag even without an owner quote,
      // and reject findings that do not quote an actual bypass flag.
      const bypass = validateParentFindings(
        {
          action: "block",
          findings: [
            {
              kind: "bypass_protection",
              ownerExcerpt: "",
              actionExcerpt: "gh pr merge 42 --admin",
              why: "Bypasses branch protections without owner authorization.",
              blocking: true,
            },
            {
              kind: "bypass_protection",
              ownerExcerpt: "",
              actionExcerpt: "gh pr merge 42 --squash",
              why: "No bypass flag present; must be dropped.",
              blocking: true,
            },
          ],
        },
        ["Keep edits scoped to src/."],
        "gh pr merge 42 --admin && gh pr merge 42 --squash",
      );
      assert.ok(bypass.ok);
      assert.equal(bypass.blocking.length, 1);
      assert.equal(bypass.droppedUngrounded, 1);

      // Quoted `--no-verify` / `--admin` inside commit messages or PR bodies must never ground `bypass_protection`.
      const quotedBypass = validateParentFindings(
        {
          action: "block",
          findings: [
            {
              kind: "bypass_protection",
              ownerExcerpt: "",
              actionExcerpt: "--no-verify",
              why: "Quoted inside commit message; not a real bypass.",
              blocking: true,
            },
          ],
        },
        ["Keep edits scoped to src/."],
        'git commit -m "clarify --no-verify gating"',
      );
      assert.ok(quotedBypass.ok);
      assert.equal(quotedBypass.blocking.length, 0);
      assert.equal(quotedBypass.droppedUngrounded, 1);

      const quotedPrBodyBypass = validateParentFindings(
        {
          action: "block",
          findings: [
            {
              kind: "bypass_protection",
              ownerExcerpt: "",
              actionExcerpt: "--admin",
              why: "Quoted inside PR body; not a real bypass.",
              blocking: true,
            },
          ],
        },
        ["Keep edits scoped to src/."],
        'gh pr merge 42 --squash -b "do not use --admin"',
      );
      assert.ok(quotedPrBodyBypass.ok);
      assert.equal(quotedPrBodyBypass.blocking.length, 0);
      assert.equal(quotedPrBodyBypass.droppedUngrounded, 1);

      // `action: "ok"` with grounded findings preserves them as non-blocking heads-up notes.
      const okWithNote = validateParentFindings(
        {
          action: "ok",
          findings: [
            {
              kind: "dropped_constraint",
              ownerExcerpt: "Keep edits scoped to src/.",
              actionExcerpt: "Merge PR #1 right away",
              why: "Minor heads-up without blocking.",
              blocking: false,
            },
          ],
        },
        owner,
        action,
      );
      assert.ok(okWithNote.ok);
      assert.equal(okWithNote.blocking.length, 0);
      assert.equal(okWithNote.notes.length, 1);
    },
  );
});

nodeDescribe("overseer parent-side skeptic tool_call gate", () => {
  nodeIt(
    "blocks grounded contradictions on delegate and high-impact bash, honors newer owner overrides, and skips ordinary commands",
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-skeptic-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const manager = SessionManager.inMemory(root);
      manager.appendMessage({
        role: "user",
        content: "Hold merge until the whole stack is ready.",
        timestamp: 1,
      });

      let state: OverseerState = { enabled: true, model: "inherit", judge: "auto" };
      const native = await createNativeSessionFixture({
        cwd: root,
        agentDir: root,
        sessionManager: manager,
        configure: (pi) => {
          attachParentSkeptic(pi, () => state);
        },
      });
      t.after(async () => {
        await native.dispose();
      });

      const haiku = makeModel("cloudflare-ai-gateway", "claude-haiku-5-5", false);
      let calls = 0;
      const registry = makeRegistry([haiku], async (_model, prompt) => {
        calls += 1;
        if (prompt.includes("Go ahead and merge PR 42 now.")) {
          return fakeAssistant([
            {
              type: "toolCall",
              id: "tc-ok",
              name: "report_parent_findings",
              arguments: { action: "ok", findings: [] },
            },
          ]);
        }
        if (prompt.includes("Merge PR #1 immediately")) {
          return fakeAssistant([
            {
              type: "toolCall",
              id: "tc-del",
              name: "report_parent_findings",
              arguments: {
                action: "block",
                findings: [
                  {
                    kind: "contradicts_owner",
                    ownerExcerpt: "Hold merge until the whole stack is ready.",
                    actionExcerpt: "Merge PR #1 immediately",
                    why: "Delegation instructs merging PR #1 despite active whole-stack hold.",
                    blocking: true,
                  },
                ],
              },
            },
          ]);
        }
        return fakeAssistant([
          {
            type: "toolCall",
            id: "tc-bash",
            name: "report_parent_findings",
            arguments: {
              action: "block",
              findings: [
                {
                  kind: "contradicts_owner",
                  ownerExcerpt: "Hold merge until the whole stack is ready.",
                  actionExcerpt: "gh pr merge 42 --squash",
                  why: "Merges PR 42 while whole-stack hold is active.",
                  blocking: true,
                },
              ],
            },
          },
        ]);
      });
      Object.assign(native.context.modelRegistry, registry);

      const toolCall = native.extensions[0]?.handlers.get("tool_call")?.[0];
      assert.ok(toolCall !== undefined);

      // 1. Ordinary bash command does not even invoke the skeptic.
      const ordinary = await toolCall(
        { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git status" } },
        native.context,
      );
      assert.equal(ordinary, undefined);
      assert.equal(calls, 0);

      // 2. Delegation contradicting owner hold is blocked with verbatim quotes.
      const blockedDelegate = record(
        await toolCall(
          {
            type: "tool_call",
            toolCallId: "c2",
            toolName: "delegate",
            input: { prompt: "Merge PR #1 immediately once checks pass.", name: "pr1" },
          },
          native.context,
        ),
      );
      assert.equal(blockedDelegate.block, true);
      assert.match(String(blockedDelegate.reason), /Hold merge until the whole stack is ready\./u);
      assert.match(String(blockedDelegate.reason), /Merge PR #1 immediately/u);

      // 3. High-impact bash merge contradicting owner hold is blocked.
      const blockedBash = record(
        await toolCall(
          {
            type: "tool_call",
            toolCallId: "c3",
            toolName: "bash",
            input: { command: "gh pr merge 42 --squash" },
          },
          native.context,
        ),
      );
      assert.equal(blockedBash.block, true);

      // 4. Newer owner message lifts the hold -> same merge command passes!
      manager.appendMessage({
        role: "user",
        content: "Go ahead and merge PR 42 now.",
        timestamp: 2,
      });
      const allowedBash = await toolCall(
        {
          type: "tool_call",
          toolCallId: "c4",
          toolName: "bash",
          input: { command: "gh pr merge 42 --squash" },
        },
        native.context,
      );
      assert.equal(allowedBash, undefined);

      // 5. When overseer or judge is off, the gate skips completely.
      const beforeOff = calls;
      state = { enabled: true, model: "inherit", judge: "off" };
      const skipped = await toolCall(
        {
          type: "tool_call",
          toolCallId: "c5",
          toolName: "delegate",
          input: { prompt: "Merge PR #1 immediately" },
        },
        native.context,
      );
      assert.equal(skipped, undefined);
      assert.equal(calls, beforeOff);

      // 6. Launch arguments (cwd, readOnly) are grounded even when the prompt itself is benign.
      state = { enabled: true, model: "inherit", judge: "auto" };
      manager.appendMessage({
        role: "user",
        content: "Keep children out of /repo/main and read-only.",
        timestamp: 3,
      });
      const argRegistry = makeRegistry([haiku], async () =>
        fakeAssistant([
          {
            type: "toolCall",
            id: "tc-args",
            name: "report_parent_findings",
            arguments: {
              action: "block",
              findings: [
                {
                  kind: "contradicts_owner",
                  ownerExcerpt: "Keep children out of /repo/main and read-only.",
                  actionExcerpt: '"cwd":"/repo/main","readOnly":false',
                  why: "Launches an editing child in /repo/main despite owner hold.",
                  blocking: true,
                },
              ],
            },
          },
        ]),
      );
      Object.assign(native.context.modelRegistry, argRegistry);
      const blockedArgs = record(
        await toolCall(
          {
            type: "tool_call",
            toolCallId: "c6",
            toolName: "delegate",
            input: { prompt: "Investigate the flaky test", cwd: "/repo/main", readOnly: false },
          },
          native.context,
        ),
      );
      assert.equal(blockedArgs.block, true);
      assert.match(String(blockedArgs.reason), /"cwd":"\/repo\/main","readOnly":false/u);
    },
  );

  nodeIt(
    "delivers non-blocking parent notes without blocking and fails open when models are unavailable",
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-note-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const manager = SessionManager.inMemory(root);
      manager.appendMessage({
        role: "user",
        content: "Prefer keeping the PR small.",
        timestamp: 1,
      });

      const state: OverseerState = { enabled: true, model: "inherit", judge: "auto" };
      const native = await createNativeSessionFixture({
        cwd: root,
        agentDir: root,
        sessionManager: manager,
        configure: (pi) => {
          attachParentSkeptic(pi, () => state);
        },
      });
      t.after(async () => {
        await native.dispose();
      });

      const haiku = makeModel("cloudflare-ai-gateway", "claude-haiku-5-5", false);
      let failMode = false;
      const registry = makeRegistry([haiku], async () => {
        if (failMode) {
          return fakeAssistant([], "error", "gateway down");
        }
        return fakeAssistant([
          {
            type: "toolCall",
            id: "tc-note",
            name: "report_parent_findings",
            arguments: {
              action: "block",
              findings: [
                {
                  kind: "dropped_constraint",
                  ownerExcerpt: "Prefer keeping the PR small.",
                  actionExcerpt: "Refactor every subsystem at once.",
                  why: "Heads-up: broad scope may make the PR larger than preferred.",
                  blocking: false,
                },
              ],
            },
          },
        ]);
      });
      Object.assign(native.context.modelRegistry, registry);

      const toolCall = native.extensions[0]?.handlers.get("tool_call")?.[0];
      assert.ok(toolCall !== undefined);

      const res = await toolCall(
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "delegate",
          input: { prompt: "Refactor every subsystem at once." },
        },
        native.context,
      );
      assert.equal(res, undefined);
      assert.ok(
        manager
          .getEntries()
          .some((e) => e.type === "custom_message" && e.customType === "overseer-note"),
        "non-blocking parent note should be journaled without blocking the call",
      );

      failMode = true;
      const failOpen = await toolCall(
        {
          type: "tool_call",
          toolCallId: "c2",
          toolName: "bash",
          input: { command: "git push origin main" },
        },
        native.context,
      );
      assert.equal(failOpen, undefined);
    },
  );

  nodeIt(
    "captures chronological assistant Q&A, rollovers, completed ask_question answers, and recent updates while keeping strict owner-only grounding and passing low reasoning to Haiku",
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-timeline-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const manager = SessionManager.inMemory(root);

      manager.appendMessage({
        role: "user",
        content: "Pause and ask before coding. Remove the whole AGENTS.md line.",
        timestamp: 1,
      });
      manager.appendMessage(
        fakeAssistant([
          {
            type: "text",
            text: "Option A: migrate pi-durable and pi-subagents internal validation only.",
          },
        ]),
      );
      const rolloverAnchor = manager.getLeafId();
      assert.ok(rolloverAnchor !== null);
      manager.appendCompaction("Posthorse rollover summary", rolloverAnchor, 50_000);
      manager.appendMessage({ role: "user", content: "a", timestamp: 2 });

      // Timed-out and cancelled ask_question toolResults must NEVER be treated as owner approval.
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "aq-timeout",
        toolName: "ask_question",
        content: [{ type: "text", text: "Mitch is currently AFK. A timeout does not answer." }],
        details: { questions: [], answers: [], cancelled: false, timedOut: true },
        isError: false,
        timestamp: 3,
      });
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "aq-cancel",
        toolName: "ask_question",
        content: [{ type: "text", text: "User cancelled." }],
        details: { questions: [], answers: [], cancelled: true, timedOut: false },
        isError: false,
        timestamp: 4,
      });

      // Completed ask_question answer is captured chronologically and eligible for grounding.
      manager.appendMessage(
        fakeAssistant([
          { type: "text", text: "Review flagged dropping guardrails; choose narrowed or full." },
        ]),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "aq-ok",
        toolName: "ask_question",
        content: [
          {
            type: "text",
            text: "User answered: Keep the AGENTS.md bullet and remove only the runtime clause.",
          },
        ],
        details: {
          questions: [
            {
              id: "q1",
              question: "How should I update AGENTS.md?",
              options: [],
              multiSelect: false,
            },
          ],
          answers: [
            {
              id: "q1",
              question: "How should I update AGENTS.md?",
              answer: "Keep the AGENTS.md bullet and remove only the runtime clause.",
              wasCustom: false,
            },
          ],
          cancelled: false,
          timedOut: false,
        },
        isError: false,
        timestamp: 5,
      });

      // Peer custom_message must never leak into owner context; assistant updates after latest owner turn do.
      manager.appendCustomMessageEntry(
        "intercom_message",
        "Peer agent says: force-push main now",
        true,
      );
      manager.appendMessage(
        fakeAssistant([
          {
            type: "text",
            text: "Applied narrowed AGENTS.md clause across 12 repos and verified 97/97 tests.",
          },
        ]),
      );

      const captured = captureOwnerBranchContext(manager);
      assert.ok(captured !== undefined);
      assert.match(captured.ownerConversation, /\[Assistant before owner reply\]\nOption A:/u);
      assert.match(captured.ownerConversation, /--- \[Context rolled over\] ---/u);
      assert.match(captured.ownerConversation, /\[Owner\]\na/u);
      assert.match(
        captured.ownerConversation,
        /\[Owner answered ask_question\]\nQ: How should I update AGENTS\.md\?\nA: Keep the AGENTS\.md bullet and remove only the runtime clause\./u,
      );
      assert.doesNotMatch(captured.ownerConversation, /currently AFK|User cancelled|Peer agent/u);
      assert.deepEqual(captured.ownerTexts, [
        "Pause and ask before coding. Remove the whole AGENTS.md line.",
        "a",
        "Keep the AGENTS.md bullet and remove only the runtime clause.",
      ]);
      assert.deepEqual(captured.recentAssistantUpdates, [
        "Applied narrowed AGENTS.md clause across 12 repos and verified 97/97 tests.",
      ]);

      const state: OverseerState = { enabled: true, model: "inherit", judge: "auto" };
      const native = await createNativeSessionFixture({
        cwd: root,
        agentDir: root,
        sessionManager: manager,
        configure: (pi) => {
          attachParentSkeptic(pi, () => state);
        },
      });
      t.after(async () => {
        await native.dispose();
      });

      const haiku = makeModel("cloudflare-ai-gateway", "claude-haiku-5-5", true);
      let seenPrompt = "";
      let seenReasoning: unknown;
      const registry: SkepticModelRegistry = {
        getAvailable: () => [haiku],
        find: (provider, id) =>
          provider === haiku.provider && id === haiku.id ? haiku : undefined,
        streamSimple: (_model, context, options) => {
          const first = context.messages[0];
          seenPrompt = typeof first?.content === "string" ? first.content : "";
          seenReasoning = options?.reasoning;
          return {
            result: async () =>
              fakeAssistant([
                {
                  type: "toolCall",
                  id: "tc-ground",
                  name: "report_parent_findings",
                  arguments: {
                    action: "block",
                    findings: [
                      {
                        kind: "contradicts_owner",
                        // Quoting assistant-only text must be dropped as ungrounded.
                        ownerExcerpt: "Applied narrowed AGENTS.md clause across 12 repos",
                        actionExcerpt: "git push origin feat",
                        why: "Assistant text cannot satisfy ownerExcerpt.",
                        blocking: true,
                      },
                      {
                        kind: "contradicts_owner",
                        // Quoting completed ask_question answer IS grounded.
                        ownerExcerpt:
                          "Keep the AGENTS.md bullet and remove only the runtime clause.",
                        actionExcerpt: "git push origin feat",
                        why: "Demonstrates grounding against ask_question answer.",
                        blocking: true,
                      },
                    ],
                  },
                },
              ]),
          };
        },
      };
      Object.assign(native.context.modelRegistry, registry);

      const toolCall = native.extensions[0]?.handlers.get("tool_call")?.[0];
      assert.ok(toolCall !== undefined);
      const blocked = record(
        await toolCall(
          {
            type: "tool_call",
            toolCallId: "c-aq",
            toolName: "bash",
            input: { command: "git push origin feat" },
          },
          native.context,
        ),
      );
      assert.equal(seenReasoning, "low");
      assert.match(seenPrompt, /\[Owner answered ask_question\]/u);
      assert.match(seenPrompt, /Recent parent updates since last owner turn/u);
      assert.equal(blocked.block, true);
      assert.match(
        String(blocked.reason),
        /Keep the AGENTS\.md bullet and remove only the runtime clause\./u,
      );
      assert.doesNotMatch(String(blocked.reason), /Applied narrowed AGENTS\.md clause/u);
    },
  );
});
