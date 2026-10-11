import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { assertDefined } from "../support/assertions.ts";
import { assistant } from "../support/runtime-messages.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createForkContextResolver,
  resolveSubagentContext,
} from "../../src/shared/fork-context.ts";

describe("resolveSubagentContext", () => {
  it("defaults to fresh", () => {
    assert.equal(resolveSubagentContext(undefined), "fresh");
    assert.equal(resolveSubagentContext("anything"), "fresh");
  });
  it("accepts fork", () => assert.equal(resolveSubagentContext("fork"), "fork"));
});

describe("createForkContextResolver", () => {
  it("fresh mode never opens a parent session", (t) => {
    const opener = t.mock.method(SessionManager, "open", () => {
      throw new Error("must not open");
    });
    const resolver = createForkContextResolver(
      {
        getSessionFile: () => "/tmp/parent.jsonl",
        getLeafId: () => "leaf-123",
        getSessionDir: () => "/tmp",
      },
      "fresh",
    );
    assert.equal(resolver.sessionFileForIndex(0), undefined);
    assert.equal(opener.mock.callCount(), 0);
  });

  it("fails fast when parent session file is missing", () => {
    assert.throws(
      () =>
        createForkContextResolver(
          {
            getSessionFile: (): string | undefined => undefined,
            getLeafId: () => "leaf-123",
            getSessionDir: () => "/tmp",
          },
          "fork",
        ),
      /Forked subagent context requires a persisted parent session\./,
    );
  });

  it("fails fast when leaf id is missing", () => {
    assert.throws(
      () =>
        createForkContextResolver(
          {
            getSessionFile: () => "/tmp/parent.jsonl",
            getLeafId: () => null,
            getSessionDir: () => "/tmp",
          },
          "fork",
        ),
      /Forked subagent context requires a current leaf to fork from\./,
    );
  });

  it("creates isolated native branches per index without changing the parent", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fork-native-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parent = SessionManager.create(dir, dir);
    parent.appendMessage({ role: "user", content: "parent prompt", timestamp: 1 });
    parent.appendMessage(assistant([{ type: "text", text: "parent response" }]));
    const parentFile = parent.getSessionFile();
    const leaf = parent.getLeafId();
    assertDefined(parentFile);
    assertDefined(leaf);
    const bytes = fs.readFileSync(parentFile, "utf8");
    const entries = parent.getBranch(leaf);
    const resolver = createForkContextResolver(parent, "fork");
    const children = [0, 1, 2, 3, 4, 7].map((index) => {
      const file = resolver.sessionFileForIndex(index);
      assertDefined(file);
      return file;
    });
    assert.equal(
      new Set(children).size,
      6,
      "single, parallel and chain indices have separate journals",
    );
    for (const file of children) {
      assert.notEqual(file, parentFile);
      assert.equal(fs.existsSync(file), true);
      const child = SessionManager.open(file);
      assert.equal(child.getLeafId(), leaf);
      assert.deepEqual(
        child.getBranch(leaf),
        entries,
        "every child inherits the exact selected branch",
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.subagent-cwd-init`, "utf8")), {});
    }
    const cached = children.at(-1);
    assertDefined(cached);
    fs.unlinkSync(`${cached}.subagent-cwd-init`);
    assert.equal(resolver.sessionFileForIndex(7), cached);
    assert.equal(
      fs.existsSync(`${cached}.subagent-cwd-init`),
      false,
      "cached forks do not reset consumed directory intent",
    );
    assert.equal(parent.getSessionFile(), parentFile);
    assert.equal(parent.getLeafId(), leaf);
    assert.equal(fs.readFileSync(parentFile, "utf8"), bytes);
  });

  it("fails clearly when the parent file has not been persisted", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fork-unpersisted-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "parent.jsonl");
    const parent = {
      getSessionFile: () => file,
      getLeafId: () => "unpersisted-leaf",
      getSessionDir: () => dir,
    };
    const resolver = createForkContextResolver(parent, "fork");
    assert.throws(
      () => resolver.sessionFileForIndex(0),
      /Failed to create forked subagent session: Parent session file does not exist: .*Pi has not persisted enough history to fork yet\./,
    );
    assert.equal(parent.getSessionFile(), file);
    assert.equal(parent.getLeafId(), "unpersisted-leaf");
    assert.equal(fs.existsSync(file), false);
  });

  it("fails clearly when branch extraction returns a missing child file", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fork-missing-child-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parentFile = path.join(dir, "parent.jsonl");
    fs.writeFileSync(parentFile, "{}");
    t.mock.method(SessionManager, "open", () => ({
      createBranchedSession: () => path.join(dir, "missing-child.jsonl"),
    }));
    const resolver = createForkContextResolver(
      { getSessionFile: () => parentFile, getLeafId: () => "leaf", getSessionDir: () => dir },
      "fork",
    );
    assert.throws(
      () => resolver.sessionFileForIndex(0),
      /Failed to create forked subagent session: Session manager returned a forked session file that does not exist: .*missing-child\.jsonl/,
    );
  });

  it("does not silently fallback to fresh when branch extraction fails", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fork-no-path-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parentFile = path.join(dir, "parent.jsonl");
    fs.writeFileSync(parentFile, "{}");
    t.mock.method(SessionManager, "open", () => ({
      createBranchedSession: (): string | undefined => undefined,
    }));
    const resolver = createForkContextResolver(
      { getSessionFile: () => parentFile, getLeafId: () => "leaf", getSessionDir: () => dir },
      "fork",
    );
    assert.throws(
      () => resolver.sessionFileForIndex(0),
      /Failed to create forked subagent session: Session manager did not return a forked session file\./,
    );
  });
});
