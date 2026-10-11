import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistant as assistantContent } from "../support/runtime-messages.ts";
import { getFinalOutput } from "../../src/shared/utils.ts";

describe("getFinalOutput", () => {
  it("prefers final text over progress text in a multi-part assistant message", () => {
    const messages = [
      assistantContent([
        { type: "text", text: "Working on the fix..." },
        { type: "thinking", thinking: "Cursor shell: shell $ npm test" },
        { type: "text", text: "Implemented: patch applied." },
      ]),
    ];

    assert.equal(getFinalOutput(messages), "Implemented: patch applied.");
  });

  it("falls back to an older assistant message when the latest message has no non-empty text", () => {
    for (const latest of [
      assistantContent([{ type: "text", text: " \n\t " }]),
      assistantContent([
        { type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } },
      ]),
    ]) {
      assert.equal(
        getFinalOutput([assistantContent([{ type: "text", text: "Earlier" }]), latest]),
        "Earlier",
      );
    }
  });

  it("returns empty output when all assistant text is empty or whitespace-only", () => {
    const messages = [
      assistantContent([{ type: "text", text: "" }]),
      assistantContent([{ type: "text", text: "\n\t " }]),
    ];

    assert.equal(getFinalOutput(messages), "");
  });

  it("does not use provider-error assistant text as fallback output", () => {
    const messages = [
      {
        ...assistantContent([{ type: "text", text: "temporary provider failure" }]),
        stopReason: "error" as const,
        errorMessage: "provider transport failed",
      },
      assistantContent([{ type: "text", text: "" }]),
    ];

    assert.equal(getFinalOutput(messages), "");
  });

  it("preserves surrounding whitespace on the selected non-empty text", () => {
    const messages = [assistantContent([{ type: "text", text: " \n Summary \n " }])];

    assert.equal(getFinalOutput(messages), " \n Summary \n ");
  });
});
