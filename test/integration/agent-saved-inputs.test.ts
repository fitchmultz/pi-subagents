import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test as nodeTest } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readContractAmendments } from "../../src/agent/overseer-contract.ts";
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

nodeTest(
  "legacy continuation attaches a contract without EEXIST and rejects re-adoption with a contract",
  async (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "pi-saved-contract-"));
    const workdir = path.join(root, "repo");
    fs.mkdirSync(path.join(workdir, "src"), { recursive: true });
    const manager = SessionManager.create(workdir, path.join(root, "sessions"));
    const native = await createNativeSessionFixture({
      cwd: workdir,
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
    fs.mkdirSync(base, { mode: 0o700 });
    const source = path.join(root, "sessions", "subagent-runs", "legacy-contract");
    fs.mkdirSync(path.join(source, "contracts"), { recursive: true, mode: 0o700 });
    const childManager = SessionManager.create(workdir, source);
    const childFile = childManager.getSessionFile();
    assert.ok(childFile !== undefined);
    fs.writeFileSync(childFile, `${JSON.stringify(childManager.getHeader())}\n`, { mode: 0o600 });
    fs.writeFileSync(
      path.join(source, "question-owner.json"),
      JSON.stringify({ sessionId: manager.getSessionId() }),
    );
    manager.appendCustomEntry("subagent-run", {
      runId: "legacy-contract",
      ownerSessionId: manager.getSessionId(),
      mode: "single",
      children: [{ index: 0, sessionFile: childFile }],
    });
    fs.writeFileSync(
      path.join(source, "contracts", "0.json"),
      JSON.stringify({
        sessionFile: childFile,
        nativeSessionId: childManager.getSessionId(),
        launch: {
          cwd: workdir,
          context: "fresh",
          model: `${model.provider}/${model.id}`,
          thinking: "off",
        },
      }),
    );

    const adopted = savedContinuation({
      id: "legacy-contract",
      prompt: "Continue legacy work under contract",
      contract: { scope: ["src/**"], verification: ["npm test"] },
      context: native.context,
      base,
      agentDir: root,
    });
    assert.equal(adopted.kind, "created");
    assert.deepEqual(adopted.launch.contract, {
      scope: ["src/**"],
      verification: ["npm test"],
    });
    assert.ok(adopted.launch.scratchDir !== undefined && fs.existsSync(adopted.launch.scratchDir));
    assert.equal(readContractAmendments(base, adopted.launch).length, 1);

    assert.throws(
      () =>
        savedContinuation({
          id: "legacy-contract",
          prompt: "Second try with contract",
          contract: { scope: [] },
          context: native.context,
          base,
          agentDir: root,
        }),
      new RegExp(`already adopted as ${adopted.launch.id}`, "u"),
    );
  },
);
