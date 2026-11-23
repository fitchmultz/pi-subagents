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
import type { OverseerState } from "../../src/agent/overseer.ts";
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
    ]) {
      assert.equal(isHighImpactBash(cmd), true, cmd);
    }

    for (const cmd of [
      "cat > notes.md <<EOF\ngit push\nEOF\ngit status",
      "gh -R owner/repo pr view 42",
      "git status --short",
      "git commit -m 'local work'",
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
});
