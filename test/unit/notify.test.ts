import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createNativeSessionFixture } from "../support/native-session.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

async function createPi(t: TestContext) {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const native = await createNativeSessionFixture({
    cwd: process.cwd(),
    agentDir: process.env.HOME ?? process.cwd(),
    configure(pi) {
      const capture = {
        ...pi,
        sendMessage: (message: unknown, options: unknown) => {
          sent.push({ message, options });
        },
      };
      registerSubagentNotify(capture, () => {
        // Key-less compatibility inputs do not enter the owned queue lifecycle.
      });
    },
  });
  t.after(native.dispose);
  return { events: native.pi.events, sent };
}

describe("registerSubagentNotify", () => {
  it("preserves non-empty completion summaries", async (t) => {
    const { events, sent } = await createPi(t);
    for (const [input, content] of [
      [
        {
          id: "notify-table-summary",
          summary: "  Done streaming\nAll clear  ",
          taskIndex: 1,
          totalTasks: 3,
        },
        "Background task completed: **worker** (2/3)\n\n  Done streaming\nAll clear  ",
      ],
      [
        { id: "notify-table-empty", summary: "" },
        "Background task completed: **worker**\n\n(no output)",
      ],
      [
        { id: "notify-table-path", summary: "Done", sessionFile: "/tmp/session.jsonl" },
        "Background task completed: **worker**\n\nDone\n\nSession file: /tmp/session.jsonl",
      ],
      [
        {
          id: "notify-table-paused",
          success: false,
          state: "paused",
          summary: "Paused after interrupt. Waiting for explicit next action.",
        },
        "Background task paused: **worker**\n\nPaused after interrupt. Waiting for explicit next action.",
      ],
      [
        {
          id: "notify-table-paused-state",
          success: false,
          state: "paused",
          summary: "Work paused",
        },
        "Background task paused: **worker**\n\nWork paused",
      ],
    ] as const) {
      sent.length = 0;
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        agent: "worker",
        success: true,
        timestamp: 456,
        ...input,
      });
      assert.deepEqual(sent, [
        {
          message: { customType: "subagent-notify", content, display: true },
          options: { triggerTurn: true },
        },
      ]);
    }

    sent.length = 0;
    const first = {
      id: "notify-correction",
      agent: "worker",
      success: false,
      summary: "Result",
      timestamp: 789,
    };
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, first);
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, first);
    assert.deepEqual(sent, [
      {
        message: {
          customType: "subagent-notify",
          content: "Background task failed: **worker**\n\nResult",
          display: true,
        },
        options: { triggerTurn: true },
      },
    ]);
    const replacement = await createPi(t);
    const corrected = { ...first, success: true };
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, corrected);
    assert.equal(sent.length, 1, "re-registration detaches the old bus");
    replacement.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, first);
    assert.deepEqual(replacement.sent, [], "reload retains duplicate identity");
    replacement.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, corrected);
    replacement.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, corrected);
    assert.deepEqual(replacement.sent, [
      {
        message: {
          customType: "subagent-notify",
          content: "Background task completed: **worker**\n\nResult",
          display: true,
        },
        options: { triggerTurn: true },
      },
    ]);

    replacement.sent.length = 0;
    for (const input of [
      {},
      { taskIndex: 0 },
      { taskIndex: 0, sessionId: "parent-a" },
      { taskIndex: 0, sessionId: "parent-b" },
      { taskIndex: 1, sessionId: "parent-b" },
    ]) {
      const data = {
        agent: "worker",
        success: true,
        summary: "Same content",
        timestamp: 900,
        totalTasks: 2,
        ...input,
      };
      replacement.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, data);
      replacement.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, data);
    }
    assert.deepEqual(
      replacement.sent,
      ["", " (1/2)", " (1/2)", " (1/2)", " (2/2)"].map((task) => ({
        message: {
          customType: "subagent-notify",
          content: `Background task completed: **worker**${task}\n\nSame content`,
          display: true,
        },
        options: { triggerTurn: true },
      })),
    );
  });
});
