import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { AgyInboundQueue, applyHookTransition } from "../../src/pi-intercom/agy/inbound-queue.ts";
import { agyPeerId, parseWakeCredentials } from "../../src/pi-intercom/agy/paths.ts";
import { readAgyLastMessage } from "../../src/pi-intercom/agy/transcript.ts";
import type { SessionInfo } from "../../src/pi-intercom/types.ts";
import { text } from "../support/assertions.ts";

function sampleSession(): SessionInfo {
  return {
    id: agyPeerId("conv-12345678"),
    name: "agy-demo",
    cwd: "/tmp/demo",
    model: "agy (Gemini 4 Neon (Low))",
    status: "idle",
  };
}

nodeTest(
  "readAgyLastMessage reads latest completed PLANNER_RESPONSE and full transcript fallback",
  (t) => {
    const dir = mkdtempSync(path.join(text(process.env.HOME), "agy-transcript-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const fullPath = path.join(dir, "transcript_full.jsonl");
    const fullBody = `Full untruncated response: ${"x".repeat(40)}`;

    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 0,
          source: "USER",
          type: "USER_INPUT",
          status: "DONE",
          content: "hi",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "",
        }),
        JSON.stringify({
          step_index: 2,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "First answer",
        }),
        JSON.stringify({
          step_index: 4,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Truncated...",
          truncated_fields: ["content"],
        }),
        JSON.stringify({
          step_index: 5,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "ERROR",
          content: "",
          error: "upstream quota error",
        }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      fullPath,
      `${JSON.stringify({
        step_index: 4,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: fullBody,
      })}\n`,
    );

    const page1 = readAgyLastMessage(transcriptPath, sampleSession(), { offset: 0, limit: 20 });
    assert.ok(!("error" in page1));
    assert.equal(page1.entryId, "step-4");
    assert.equal(page1.text, fullBody.slice(0, 20));
    assert.equal(page1.totalLength, fullBody.length);
    assert.equal(page1.nextOffset, 20);
    assert.deepEqual(page1.latestTurnError, { entryId: "step-5", error: "upstream quota error" });

    const page2 = readAgyLastMessage(transcriptPath, sampleSession(), {
      entryId: "step-4",
      offset: 20,
      limit: 100,
    });
    assert.ok(!("error" in page2));
    assert.equal(page2.text, fullBody.slice(20));
    assert.equal(page2.nextOffset, undefined);

    const earlier = readAgyLastMessage(transcriptPath, sampleSession(), { entryId: "step-2" });
    assert.ok(!("error" in earlier));
    assert.equal(earlier.text, "First answer");

    const missing = readAgyLastMessage(transcriptPath, sampleSession(), { entryId: "step-999" });
    assert.ok("error" in missing);
  },
);

nodeTest("parseWakeCredentials validates loopback address and required CSRF token", () => {
  const valid = parseWakeCredentials(
    [
      "ANTIGRAVITY_LS_ADDRESS=localhost:61871",
      "ANTIGRAVITY_CSRF_TOKEN=tok-abc-123",
      "ANTIGRAVITY_AGENTAPI_EXE=/usr/local/bin/agy",
    ].join("\n"),
  );
  assert.deepEqual(valid, {
    lsAddress: "localhost:61871",
    csrfToken: "tok-abc-123",
    agentApiExe: "/usr/local/bin/agy",
  });

  assert.deepEqual(
    parseWakeCredentials("ANTIGRAVITY_LS_ADDRESS=127.0.0.1:4242\nANTIGRAVITY_CSRF_TOKEN=t"),
    { lsAddress: "127.0.0.1:4242", csrfToken: "t" },
  );
  assert.equal(
    parseWakeCredentials("ANTIGRAVITY_LS_ADDRESS=example.com:443\nANTIGRAVITY_CSRF_TOKEN=tok"),
    undefined,
  );
  assert.equal(parseWakeCredentials("ANTIGRAVITY_LS_ADDRESS=localhost:61871\n"), undefined);
});

nodeTest(
  "applyHookTransition drains queued inbound on PreInvocation/Stop and always allows PreToolUse",
  () => {
    const queue = new AgyInboundQueue();
    assert.equal(queue.remember("msg-1"), true);
    assert.equal(queue.remember("msg-1"), false);
    queue.enqueue("msg-1", "Hello from Pi");

    const preTool = applyHookTransition(
      { hookEventName: "PreToolUse", toolName: "invoke_subagent" },
      queue,
    );
    assert.equal(preTool.status, "tool: invoke_subagent");
    assert.deepEqual(preTool.response, { decision: "allow" });
    assert.equal(queue.length, 1);

    const preInv = applyHookTransition({ hookEventName: "PreInvocation" }, queue);
    assert.equal(preInv.status, "working");
    assert.deepEqual(preInv.response, {
      injectSteps: [{ systemMessage: { systemMessage: "Hello from Pi" } }],
    });
    assert.equal(queue.length, 0);

    queue.enqueue("msg-2", "Queued before stop");
    const stopContinue = applyHookTransition(
      { hookEventName: "Stop", terminationReason: "NO_TOOL_CALL" },
      queue,
    );
    assert.equal(stopContinue.status, "working");
    assert.deepEqual(stopContinue.response, { decision: "continue", reason: "Queued before stop" });

    queue.enqueue("msg-3", "Canceled turn should not continue");
    const stopCanceled = applyHookTransition(
      { hookEventName: "Stop", terminationReason: "USER_CANCELED" },
      queue,
    );
    assert.equal(stopCanceled.status, "idle");
    assert.deepEqual(stopCanceled.response, {});
    assert.equal(queue.length, 1);
  },
);
