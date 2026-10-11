import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildModelCandidates,
  isRecoverableSameModelFailure,
  isRetryableModelFailure,
  resolveModelCandidate,
} from "../../src/runs/shared/model-fallback.ts";

describe("model fallback helpers", () => {
  const availableModels = [
    { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
    { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  ];

  it("keeps explicit provider/model ids unchanged", () => {
    const ambiguous = [
      ...availableModels,
      { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
    ];
    for (const [input, models, provider, expected] of [
      ["openai/gpt-5-mini", availableModels, undefined, "openai/gpt-5-mini"],
      ["gpt-5-mini", availableModels, undefined, "openai/gpt-5-mini"],
      ["gpt-5-mini:high", availableModels, undefined, "openai/gpt-5-mini:high"],
      ["gpt-5-mini", ambiguous, undefined, "gpt-5-mini"],
      ["gpt-5-mini", ambiguous, "github-copilot", "github-copilot/gpt-5-mini"],
      ["claude-sonnet-4", availableModels, "github-copilot", "anthropic/claude-sonnet-4"],
    ] as const) {
      assert.equal(resolveModelCandidate(input, models, provider), expected);
    }
  });

  it("builds a deduplicated ordered candidate list", () => {
    const ambiguous = [
      ...availableModels,
      { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
    ];
    for (const [fallbacks, models, provider, expected] of [
      [
        ["openai/gpt-5-mini", "anthropic/claude-sonnet-4", "gpt-5-mini"],
        availableModels,
        undefined,
        ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
      ],
      [
        ["gpt-5-mini", "anthropic/claude-sonnet-4"],
        ambiguous,
        "github-copilot",
        ["github-copilot/gpt-5-mini", "anthropic/claude-sonnet-4"],
      ],
    ] as const) {
      assert.deepEqual(buildModelCandidates("gpt-5-mini", fallbacks, models, provider), expected);
    }
  });

  it("detects retryable provider/model failures", () => {
    assert.equal(isRetryableModelFailure("rate limit exceeded for provider"), true);
    assert.equal(isRetryableModelFailure("Codex error: The usage limit has been reached"), true);
    assert.equal(isRetryableModelFailure("model unavailable"), true);
    assert.equal(isRetryableModelFailure("authentication failed"), true);
    assert.equal(isRetryableModelFailure("database is locked"), true);
  });

  it("detects same-model transport recovery failures without retrying auth or quota loops", () => {
    assert.equal(
      isRecoverableSameModelFailure("WebSocket closed before response completed", 1),
      true,
    );
    assert.equal(isRecoverableSameModelFailure("provider transport timed out", 1), true);
    assert.equal(isRecoverableSameModelFailure("terminated", 1), true);
    assert.equal(
      isRecoverableSameModelFailure(
        "worker exited with code 7.\nloaded /w/retry-terminated/x.ts",
        7,
      ),
      false,
    );
    assert.equal(isRecoverableSameModelFailure("database is locked", 1), true);
    assert.equal(isRecoverableSameModelFailure("SQLITE_BUSY: database is locked", 1), true);
    assert.equal(isRecoverableSameModelFailure(undefined, 143), true);
    assert.equal(isRecoverableSameModelFailure("429 quota exceeded", 1), false);
    assert.equal(
      isRecoverableSameModelFailure("Codex error: The usage limit has been reached", 1),
      false,
    );
    assert.equal(isRecoverableSameModelFailure("authentication failed", 1), false);
  });

  it("does not treat ordinary task/tool failures as retryable model failures", () => {
    assert.equal(isRetryableModelFailure("bash failed (exit 1): command not found"), false);
    assert.equal(isRetryableModelFailure("read failed (exit 1): no such file or directory"), false);
    assert.equal(isRetryableModelFailure(undefined), false);
  });
});
