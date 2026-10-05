import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import { toolText } from "../support/background-fixtures.ts";

describe("completion-guard terminal wakeup", () => {
  it("emits one automatic trigger while keeping both completion and actionable control information visible", async () => {
    const cwd = createTempDir("completion-guard-wakeup-");
    const native = await createNativeSessionFixture({ cwd, agentDir: cwd });
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("Completion received.")]);
    native.session.modelRuntime.registerNativeProvider(faux.provider);
    await native.session.setModel(faux.getModel());
    const sent: Array<{
      message: { customType: string; content: string };
      options: { triggerTurn?: boolean } | undefined;
    }> = [];
    const sendOriginal = native.pi.sendMessage.bind(native.pi);
    const sendMessage: ExtensionAPI["sendMessage"] = (message, options) => {
      sent.push({
        message: {
          customType: message.customType,
          content:
            typeof message.content === "string" ? message.content : toolText(message.content),
        },
        options,
      });
      sendOriginal(message, options);
    };
    const pi: ExtensionAPI = { ...native.pi, sendMessage };
    const starts: unknown[] = [];
    const stopObserving = native.session.subscribe((event) => {
      if (event.type === "agent_start") {
        starts.push(event);
      }
    });
    const unsubscribe = registerSubagentNotify(pi);
    try {
      handleSubagentControlNotice({
        pi,
        visibleControlNotices: new Set(),
        details: {
          source: "async",
          event: {
            type: "needs_attention",
            to: "needs_attention",
            ts: 1,
            runId: "resume-run",
            agent: "worker",
            index: 0,
            message: "worker completed without making edits for an implementation task",
            reason: "completion_guard",
          },
        },
      });
      pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: "resume-run",
        agent: "worker",
        success: false,
        summary: "Subagent completed without making edits for an implementation task.",
        timestamp: 2,
      });
      await native.session.waitForIdle();

      assert.equal(sent.length, 2);
      assert.equal(sent.filter((entry) => entry.options?.triggerTurn === true).length, 1);
      assert.deepEqual(
        sent.map((entry) => [entry.message.customType, entry.options?.triggerTurn]),
        [
          ["subagent_control_notice", false],
          ["subagent-notify", true],
        ],
      );
      assert.match(sent[0].message.content, /Next: read the output artifact or session/);
      assert.match(sent[1].message.content, /Background task failed/);
      assert.equal(starts.length, 1, "the native SDK runs only the completion wakeup");
      const persisted = native.session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom_message");
      assert.deepEqual(
        persisted.map((entry) => entry.customType),
        ["subagent_control_notice", "subagent-notify"],
      );
    } finally {
      unsubscribe();
      stopObserving();
      await native.dispose();
      removeTempDir(cwd);
    }
  });
});
