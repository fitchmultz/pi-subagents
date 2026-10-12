import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handleSubagentControlNotice,
  SUBAGENT_CONTROL_MESSAGE_TYPE,
} from "../../src/extension/control-notices.ts";
import { assertDefined } from "../support/assertions.ts";
import type { ControlEvent } from "../../src/shared/types.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNativeSessionFixture } from "../support/helpers.ts";
import { createPlainTheme } from "../support/ui.ts";
import { registerMessageRenderers } from "../../src/extension/message-renderers.ts";

function needsAttentionEvent(overrides: Readonly<Partial<ControlEvent>> = {}): ControlEvent {
  return {
    type: "needs_attention",
    to: "needs_attention",
    ts: 1,
    runId: "run-1",
    agent: "worker",
    index: 0,
    message: "worker needs attention",
    reason: "idle",
    ...overrides,
  };
}

function makeRecorder() {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  return {
    sent,
    pi: {
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options });
      },
    },
  };
}

describe("subagent control notice delivery", () => {
  it("validates restored notice details at the native renderer boundary, falling back for malformed data", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "persisted-control-notice-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const manager = SessionManager.inMemory(root);
    const fixture = await createNativeSessionFixture({
      cwd: root,
      agentDir: path.join(root, "agent"),
      sessionManager: manager,
      configure: registerMessageRenderers,
    });
    t.after(fixture.dispose);
    const render = fixture.session.extensionRunner.getMessageRenderer(
      SUBAGENT_CONTROL_MESSAGE_TYPE,
    );
    assertDefined(render);
    const details: unknown[] = [
      { event: needsAttentionEvent() },
      { event: { ...needsAttentionEvent(), type: 123 } },
      { event: { ...needsAttentionEvent(), agent: null } },
      { event: { ...needsAttentionEvent(), supervisorQuestion: { state: "awaiting_input" } } },
      null,
    ];
    for (const value of details) {
      manager.appendCustomMessageEntry(SUBAGENT_CONTROL_MESSAGE_TYPE, "Saved notice", true, value);
    }
    const messages = manager.getEntries().filter((entry) => entry.type === "custom_message");
    assert.equal(messages.length, details.length);
    const restored = messages.map((entry) =>
      render(
        {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          details: entry.details,
          timestamp: Date.parse(entry.timestamp),
        },
        { expanded: false, outputPad: 0 },
        createPlainTheme(),
      ),
    );
    const [valid, ...invalid] = restored;
    assertDefined(valid);
    assert.match(valid.render(80).join("\n"), /Subagent needs attention: worker/);
    assert.deepEqual(
      invalid,
      [undefined, undefined, undefined, undefined],
      "undefined selects Pi's default renderer",
    );
  });

  it("deduplicates the same owner event without hiding another child's attention", () => {
    for (const childIntercomTarget of [undefined, "worker-0"]) {
      const recorder = makeRecorder(),
        visibleControlNotices = new Set<string>();
      const details = {
        source: "async" as const,
        event: needsAttentionEvent(),
        childIntercomTarget,
      };
      handleSubagentControlNotice({ pi: recorder.pi, visibleControlNotices, details });
      assert.equal(recorder.sent.length, 1);
      assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        handleSubagentControlNotice({ pi: recorder.pi, visibleControlNotices, details });
      }
      assert.equal(recorder.sent.length, 1);
      handleSubagentControlNotice({
        pi: recorder.pi,
        visibleControlNotices,
        details: {
          ...details,
          event: needsAttentionEvent({ index: 1 }),
          childIntercomTarget: "worker-1",
        },
      });
      assert.equal(recorder.sent.length, 2);
      assert.deepEqual(recorder.sent[1]?.options, { triggerTurn: true });
    }
  });
});
