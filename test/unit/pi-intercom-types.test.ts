import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Assert } from "../../src/agent/typebox.ts";
import { isLastMessageResult } from "../../src/pi-intercom/broker/last.ts";
import { getSanitizedAssistantError } from "../../src/pi-intercom/message-format.ts";
import { intercomSchema } from "../../src/pi-intercom/tool-schemas.ts";
import {
  isAttachment,
  isMessage,
  isSessionRegistration,
  normalizeSessionInfo,
} from "../../src/pi-intercom/types.ts";
import { MAX_TURN_ERROR_LENGTH, MAX_WORKING_ON_LENGTH } from "../../src/pi-intercom/validation.ts";

const message = { id: "m1", timestamp: 1, content: { text: "hello" } };

nodeDescribe("pi-intercom wire validation", () => {
  nodeIt("accepts the current session registration shape", () => {
    assert.equal(
      isSessionRegistration({
        cwd: "/repo",
        model: "model",
        projectId: "a".repeat(64),
        gitRepo: "pi-subagents",
        gitBranch: "feat/psa-203",
        workingOn: "PSA-203 session visibility",
        startedAt: 1,
        lastSeen: 1,
        lastIntercomActivity: 2,
        pendingAsks: 0,
        acceptsAsks: true,
        lastTurnError: "401 Unauthorized",
      }),
      true,
    );
    assert.equal(
      normalizeSessionInfo({
        id: "session-1",
        cwd: "/repo",
        model: "model",
        startedAt: 1_700_000_000_000,
      })?.startedAt,
      1_700_000_000_000,
    );
    assert.equal(isSessionRegistration({ cwd: "/repo", model: 1 }), false);
    assert.equal(
      isSessionRegistration({ cwd: "/repo", model: "model", projectId: "not-a-project-id" }),
      false,
    );
    assert.equal(isSessionRegistration({ cwd: "/repo", model: "model", pendingAsks: "0" }), false);
    assert.equal(isSessionRegistration({ cwd: "/repo", model: "model", startedAt: "1" }), false);
  });

  nodeIt("drops malformed project ids from older broker session info", () => {
    assert.deepEqual(
      normalizeSessionInfo({
        id: "session-1",
        cwd: "/repo",
        model: "model",
        projectId: "malformed",
      }),
      { id: "session-1", cwd: "/repo", model: "model" },
    );
    assert.equal(
      normalizeSessionInfo({ id: "session-1", cwd: 1, model: "model", projectId: "malformed" }),
      null,
    );
  });

  nodeIt("rejects control characters and non-finite numbers", () => {
    assert.equal(isMessage({ ...message, id: "m\n1" }), false);
    assert.equal(isMessage({ ...message, timestamp: Number.NaN }), false);
    assert.equal(isMessage({ ...message, content: { text: "bad\u0000text" } }), false);
    assert.equal(
      isMessage({ ...message, delivery: "queue", queueMode: "replace", threadId: "bad\nthread" }),
      false,
    );
    assert.equal(isAttachment({ type: "file", name: "bad\nname", content: "ok" }), false);
  });

  nodeIt("rejects invalid session counters and labels", () => {
    assert.equal(isSessionRegistration({ cwd: "/tmp", model: "test", pendingAsks: -1 }), false);
    assert.equal(
      isSessionRegistration({ cwd: "/tmp", model: "test", lastSeen: Number.POSITIVE_INFINITY }),
      false,
    );
    assert.equal(
      isSessionRegistration({ cwd: "/tmp", model: "test", startedAt: Number.NaN }),
      false,
    );
    assert.equal(isSessionRegistration({ cwd: "/tmp", model: "bad\nmodel" }), false);
    assert.equal(isSessionRegistration({ cwd: "/tmp", model: "test", lastTurnError: "" }), false);
    assert.equal(
      isSessionRegistration({ cwd: "/tmp", model: "test", lastTurnError: "bad\nline" }),
      false,
    );
    assert.equal(
      isSessionRegistration({
        cwd: "/tmp",
        model: "test",
        lastTurnError: "x".repeat(MAX_TURN_ERROR_LENGTH + 1),
      }),
      false,
    );
    assert.equal(isSessionRegistration({ cwd: "/tmp", model: "test", gitRepo: "" }), false);
    assert.equal(
      isSessionRegistration({ cwd: "/tmp", model: "test", gitRepo: "bad\nrepo" }),
      false,
    );
    assert.equal(isSessionRegistration({ cwd: "/tmp", model: "test", gitBranch: "" }), false);
    assert.equal(
      isSessionRegistration({ cwd: "/tmp", model: "test", gitBranch: "bad\nbranch" }),
      false,
    );
    assert.equal(isSessionRegistration({ cwd: "/tmp", model: "test", workingOn: "" }), false);
    assert.equal(
      isSessionRegistration({ cwd: "/tmp", model: "test", workingOn: "bad\nline" }),
      false,
    );
    assert.equal(
      isSessionRegistration({
        cwd: "/tmp",
        model: "test",
        workingOn: "x".repeat(MAX_WORKING_ON_LENGTH + 1),
      }),
      false,
    );
  });

  nodeIt(
    "sanitizes assistant turn errors and validates latestTurnError on last-message results",
    () => {
      assert.equal(
        getSanitizedAssistantError({
          role: "assistant",
          stopReason: "error",
          errorMessage: "  2009\n\tUnauthorized\u001b[31m  ",
        }),
        "2009 Unauthorized [31m",
      );
      assert.equal(
        getSanitizedAssistantError({
          role: "assistant",
          stopReason: "error",
          errorMessage: "\u0007\n\t ",
        }),
        "assistant turn failed",
      );
      const truncated = getSanitizedAssistantError({
        role: "assistant",
        stopReason: "error",
        errorMessage: `${"a".repeat(MAX_TURN_ERROR_LENGTH - 2)}😀tail`,
      });
      assert.ok(truncated !== undefined);
      assert.equal(truncated.isWellFormed(), true);
      assert.ok(truncated.length <= MAX_TURN_ERROR_LENGTH);
      assert.equal(
        getSanitizedAssistantError({
          role: "assistant",
          stopReason: "stop",
          errorMessage: "ignored",
        }),
        undefined,
      );

      const base = {
        session: { id: "pi-1", cwd: "/repo", model: "fixture" },
        entryId: null,
        text: "",
        offset: 0,
        totalLength: 0,
      };
      assert.equal(
        isLastMessageResult({
          ...base,
          latestTurnError: { entryId: "entry-1", error: "401 Unauthorized" },
        }),
        true,
      );
      assert.equal(
        isLastMessageResult({ ...base, latestTurnError: { entryId: "", error: "401" } }),
        false,
      );
      assert.equal(
        isLastMessageResult({
          ...base,
          latestTurnError: { entryId: "entry-1", error: "bad\nline" },
        }),
        false,
      );
    },
  );
});

nodeDescribe("intercomSchema strict property validation", () => {
  const tool = {
    name: "intercom",
    description: "Intercom tool",
    parameters: intercomSchema,
  };

  nodeIt("accepts valid root and attachment properties", () => {
    const valid = {
      action: "send",
      to: "worker",
      message: "Check this attachment",
      attachments: [
        {
          type: "file",
          name: "src/index.ts",
          content: "export {};",
          language: "ts",
        },
      ],
    };
    Assert(intercomSchema, valid);
    validateToolArguments(tool, {
      type: "toolCall",
      id: "call-valid",
      name: "intercom",
      arguments: valid,
    });
    for (const claim of [
      { action: "claim", message: "PSA-203 session visibility" },
      { action: "claim", message: "" },
    ]) {
      Assert(intercomSchema, claim);
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-claim",
        name: "intercom",
        arguments: claim,
      });
    }
  });

  nodeIt("rejects unexpected properties on the root schema and attachment items", () => {
    const rootExtra = { action: "list", extraField: true };
    assert.throws(() => Assert(intercomSchema, rootExtra));
    assert.throws(() => {
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-root-extra",
        name: "intercom",
        arguments: rootExtra,
      });
    });

    for (const removed of [
      { action: "send", to: "worker", message: "Hi", delivery: "queue" },
      { action: "send", to: "worker", message: "Hi", delivery: "passive" },
      { action: "send", to: "worker", message: "Hi", delivery: "steer" },
      { action: "send", to: "worker", message: "Hi", passive: true },
      { action: "send", to: "worker", message: "Hi", queueMode: "replace", threadId: "t1" },
      { action: "reply", message: "Hi", contract: { scope: ["src"] } },
    ]) {
      assert.throws(() => Assert(intercomSchema, removed));
    }

    const attachmentExtra = {
      action: "send",
      to: "worker",
      message: "Hello",
      attachments: [
        {
          type: "snippet",
          name: "snippet.ts",
          content: "const x = 1;",
          extraAttachmentField: "nope",
        },
      ],
    };
    assert.throws(() => Assert(intercomSchema, attachmentExtra));
    assert.throws(() => {
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-attachment-extra",
        name: "intercom",
        arguments: attachmentExtra,
      });
    });
  });
});
