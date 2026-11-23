import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test as nodeTest } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { savedContinuation } from "../../src/agent/saved.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";

nodeTest(
  "legacy continuation rejects malformed native metadata and non-journal paths before adoption",
  async (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "pi-saved-inputs-"));
    const manager = SessionManager.create(root, path.join(root, "sessions"));
    const native = await createNativeSessionFixture({
      cwd: root,
      agentDir: root,
      sessionManager: manager,
    });
    t.after(async () => {
      await native.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await native.session.prompt("Publish the isolated native owner");
    const model = native.context.model;
    assert.ok(model);
    const base = path.join(root, "runs");
    fs.mkdirSync(base);
    const source = path.join(root, "sessions", "subagent-runs", "legacy");
    fs.mkdirSync(path.join(source, "contracts"), { recursive: true });
    fs.writeFileSync(
      path.join(source, "question-owner.json"),
      JSON.stringify({ sessionId: manager.getSessionId() }),
    );
    for (const scenario of [
      "relative",
      "extension",
      "malformed-contract",
      "invalid-native-header",
    ] as const) {
      const sessionFile =
        scenario === "relative"
          ? "child.jsonl"
          : path.join(root, scenario === "extension" ? "child.txt" : "child.jsonl");
      if (path.isAbsolute(sessionFile)) {
        fs.writeFileSync(
          sessionFile,
          JSON.stringify({
            type: "session",
            version: 3,
            ...(scenario === "invalid-native-header" ? {} : { id: "child" }),
            cwd: root,
          }) + "\n",
        );
      }
      manager.appendCustomEntry("subagent-run", {
        runId: "legacy",
        ownerSessionId: manager.getSessionId(),
        mode: "single",
        children: [{ index: 0, sessionFile }],
      });
      fs.writeFileSync(
        path.join(source, "contracts", "0.json"),
        JSON.stringify({
          sessionFile,
          launch:
            scenario === "malformed-contract"
              ? null
              : {
                  cwd: root,
                  context: "fresh",
                  model: `${model.provider}/${model.id}`,
                  thinking: "off",
                },
        }),
      );
      assert.throws(
        () =>
          savedContinuation({
            id: "legacy",
            prompt: "Must not launch",
            context: native.context,
            base,
            agentDir: root,
          }),
        scenario,
      );
      assert.deepEqual(
        fs.readdirSync(base),
        [],
        `${scenario} must not claim or create a successor`,
      );
    }
  },
);
