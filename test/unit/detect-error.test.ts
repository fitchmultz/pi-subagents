import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectSubagentError } from "../../src/shared/utils.ts";
import { assistant, toolCall, toolResult } from "../support/runtime-messages.ts";

describe("detectSubagentError", () => {
  it("does not invent errors for empty or successful tool histories", () => {
    for (const messages of [
      [],
      [
        toolResult("file contents here", false, "", "read"),
        toolResult("ls output", false, "", "bash"),
        toolResult("more contents", false, "", "read"),
      ],
      [
        toolResult(
          "log scan: timeout terminated permission denied strings found in fixture text",
          false,
          "",
          "bash",
        ),
      ],
    ]) {
      assert.equal(detectSubagentError(messages).hasError, false);
    }
  });

  it("detects isError tool result as failure (no assistant response)", () => {
    const messages = [
      toolResult("file contents", false, "", "read"),
      toolResult("EISDIR: illegal operation on a directory, read", true, "", "read"),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true);
    assert.equal(result.errorType, "read");
    assert.ok(result.details !== undefined);
    assert.match(result.details, /EISDIR/);
  });

  it("detects error after agent's last text response", () => {
    const messages = [
      assistant([{ type: "text", text: "Here is my analysis..." }]),
      toolResult("rm -rf /important", false, "", "bash"),
      toolResult("error: process exited with code 1", false, "", "bash"),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true);
    assert.equal(result.exitCode, 1);
  });

  it("detects isError after agent's last text response", () => {
    const messages = [
      toolResult("file ok", false, "", "read"),
      assistant([{ type: "text", text: "Let me try one more thing..." }]),
      toolResult("Permission denied", true, "", "write"),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true);
    assert.equal(result.errorType, "write");
  });

  it("does not treat tool-call-only assistant message as recovery", () => {
    const messages = [
      toolResult("process exited with code 1", false, "", "bash"),
      toolCall("bash"),
      toolResult("command succeeded", false, "", "bash"),
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
      toolResult("EISDIR: illegal operation on a directory", true, "", "read"),
      assistant([{ type: "text", text: "   " }]),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, true, "whitespace-only assistant message is not a recovery");
  });

  it("handles multiple errors with recovery between them", () => {
    const messages = [
      toolResult("ENOENT: no such file", true, "", "read"),
      assistant([{ type: "text", text: "File not found, trying alternative..." }]),
      toolResult("file contents", false, "", "read"),
      toolResult("EISDIR: illegal operation on a directory", true, "", "read"),
      assistant([{ type: "text", text: "Got what I needed. Here's the full review." }]),
    ];
    const result = detectSubagentError(messages);
    assert.equal(result.hasError, false, "all errors have recovery — agent completed successfully");
  });
});
