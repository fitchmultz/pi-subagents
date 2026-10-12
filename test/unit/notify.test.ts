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
        // This fixture observes messages without owning the delivery queue.
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
          exitCode: 0,
          summary: "  Done streaming\nAll clear  ",
          taskIndex: 1,
          totalTasks: 3,
        },
        "Background task completed: **worker** (2/3)\n\n  Done streaming\nAll clear  ",
      ],
      [
        { id: "notify-table-empty", exitCode: 0, summary: "" },
        "Background task completed: **worker**\n\n(no output)",
      ],
      [
        {
          id: "notify-table-path",
          exitCode: 0,
          summary: "Done",
          sessionFile: "/tmp/session.jsonl",
        },
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
    const first = { agent: "worker", success: false, summary: "Result" };
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
    const completed = { ...first, success: true, exitCode: 0 };
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
    assert.equal(sent.length, 1, "re-registration detaches the old bus");
    replacement.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
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
  });
});
