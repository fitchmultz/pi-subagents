import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectSubagentError } from "../../src/shared/utils.ts";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * Helper to create a tool result message (success or error).
 */
function toolResult(toolName: string, text: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  };
}

function assistantMsg(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    provider: "test",
    model: "test",
  };
}

/** Assistant message with only a tool call, no text content */
function assistantToolCall(toolName: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-fixture", name: toolName, arguments: {} }],
    api: "openai-responses",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    provider: "test",
    model: "test",
  };
}

describe("detectSubagentError", () => {
  // ---- Basic detection (must still work) ----

  it("returns no error for empty messages", () => {
    assert.equal(detectSubagentError([]).hasError, false);
  });

  it("returns no error when all tool results succeed", () => {
    const messages = [
      toolResult("read", "file contents here"),
      toolResult("bash", "ls output"),
      toolResult("read", "more contents"),
    ];
    assert.equal(detectSubagentError(messages).hasError, false);
  });

  it("detects isError tool result as failure (no assistant response)", () => {
    const messages = [
      toolResult("read", "file contents"),
      toolResult("read", "EISDIR: illegal operation on a directory, read", true),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true);
    assert.equal(result.errorType, "read");
    assert.ok(result.details !== undefined);
    assert.match(result.details, /EISDIR/);
  });

  it("does not infer bash failure from benign fatal-looking text", () => {
    const messages = [
      toolResult(
        "bash",
        "log scan: timeout terminated permission denied strings found in fixture text",
      ),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, false);
  });

  it("detects bash exit code in output", () => {
    const messages = [toolResult("bash", "error: process exited with code 127")];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true);
    assert.equal(result.exitCode, 127);
  });

  // Errors after the last assistant text response are still caught.

  it("detects error after agent's last text response", () => {
    const messages = [
      assistantMsg("Here is my analysis..."),
      toolResult("bash", "rm -rf /important", false),
      toolResult("bash", "error: process exited with code 1", false),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true);
    assert.equal(result.exitCode, 1);
  });

  it("detects isError after agent's last text response", () => {
    const messages = [
      toolResult("read", "file ok"),
      assistantMsg("Let me try one more thing..."),
      toolResult("write", "Permission denied", true),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true);
    assert.equal(result.errorType, "write");
  });

  // ---- Edge cases ----

  it("flags explicit tool error when no assistant messages at all", () => {
    const messages = [toolResult("read", "ok"), toolResult("bash", "segmentation fault", true)];
    const result = detectSubagentError(messages);
    assert.equal(
      result.hasError,
      true,
      "no assistant response = no recovery evidence for explicit tool errors",
    );
  });

  it("does not treat tool-call-only assistant message as recovery", () => {
    // Assistant message that only contains a tool call, no text.
    // The error at index 0 should still be detected because the tool-call-only
    // assistant message doesn't count as recovery. The final tool result is
    // successful to ensure this test actually distinguishes correct behavior.
    const messages = [
      toolResult("bash", "process exited with code 1"),
      assistantToolCall("bash"),
      toolResult("bash", "command succeeded"),
    ];
    const result = detectSubagentError(messages);
    assert.equal(
      result.hasError,
      true,
      "tool-call assistant message without text is not a recovery",
    );
  });

  it("does not treat empty/whitespace assistant message as recovery", () => {
    const messages = [
      toolResult("read", "EISDIR: illegal operation on a directory", true),
      assistantMsg("   "),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true, "whitespace-only assistant message is not a recovery");
  });

  it("returns no error when only assistant messages (no tool results)", () => {
    const messages = [
      assistantMsg("Hello, I'm ready to help."),
      assistantMsg("Here's my analysis."),
    ];
    assert.equal(detectSubagentError(messages).hasError, false);
  });

  it("handles multiple errors with recovery between them", () => {
    // Error → recovery → error → recovery
    const messages = [
      toolResult("read", "ENOENT: no such file", true),
      assistantMsg("File not found, trying alternative..."),
      toolResult("read", "file contents"),
      toolResult("read", "EISDIR: illegal operation on a directory", true),
      assistantMsg("Got what I needed. Here's the full review."),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, false, "all errors have recovery — agent completed successfully");
  });
});
