import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactForegroundResult, extractToolArgsPreview } from "../../src/shared/utils.ts";
import { formatToolCall } from "../../src/shared/formatters.ts";

describe("foreground tool-call compaction", () => {
  it("keeps expanded generic tool-call previews bounded", () => {
    const collapsed = formatToolCall("custom", { payload: "x".repeat(500) });
    const expanded = formatToolCall("custom", { payload: "x".repeat(500) }, true);

    assert.ok(expanded.length > collapsed.length);
    assert.ok(expanded.length < 200);
  });

  it("does not keep an empty toolCalls array after compaction", () => {
    const result = compactForegroundResult({
      agent: "tester",
      task: "run checks",
      exitCode: 0,
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    });

    assert.equal(result.toolCalls, undefined);
  });

  it("formats search, fetch and generic array previews clearly", () => {
    assert.equal(
      extractToolArgsPreview({
        queries: [
          "Chrome native messaging manifest path macOS",
          "Chromium native messaging path macOS",
        ],
        workflow: "none",
      }),
      "Chrome native messaging manifest path macOS (+1 more)",
    );
    assert.equal(
      extractToolArgsPreview({
        urls: [
          "https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging",
          "https://example.com/backup",
        ],
      }),
      "https://developer.chrome.com/docs/extensions/develop/conc...",
    );
    assert.equal(
      extractToolArgsPreview({ ids: ["run-a", "run-b", "run-c"] }),
      "ids=run-a (+2 more)",
    );
  });
});
