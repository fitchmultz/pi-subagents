import test from "node:test";
import assert from "node:assert/strict";
import { ReplyTracker } from "../../src/pi-intercom/reply-tracker.ts";
import type { Message, SessionInfo } from "../../src/pi-intercom/types.ts";

function createSession(id: string, name: string): SessionInfo {
  return {
    id,
    name,
    cwd: "/tmp/project",
    model: "test-model",
  };
}

function createMessage(id: string, text: string, expectsReply = true): Message {
  return {
    id,
    timestamp: 1,
    expectsReply,
    content: { text },
  };
}

test("reply resolves from current triggered message context", () => {
  const tracker = new ReplyTracker();
  const from = createSession("planner-id", "planner");
  const message = createMessage("ask-1", "Need a decision");

  const context = tracker.recordIncomingMessage(from, message, 1000);
  tracker.queueTurnContext(context);
  tracker.beginTurn(1001);

  assert.equal(tracker.resolveReplyTarget({}, 1002).message.id, "ask-1");
  assert.equal(tracker.resolveReplyTarget({}, 1002).from.id, "planner-id");
});

test("non-ask trigger context does not override a pending ask reply target", () => {
  const tracker = new ReplyTracker();
  const ask = tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);
  const result = tracker.recordIncomingMessage(createSession("result-id", "subagent-result"), createMessage("result-1", "Done", false), 1001);

  tracker.queueTurnContext(result);
  tracker.beginTurn(1002);

  assert.equal(tracker.currentTurn(), null);
  assert.equal(tracker.resolveReplyTarget({}, 1003).message.id, ask.message.id);
  assert.equal(tracker.resolveReplyTarget({}, 1003).from.id, "planner-id");
});

test("reply resolves from single pending ask without current turn context", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  assert.equal(tracker.resolveReplyTarget({}, 1001).message.id, "ask-1");
});

test("reply with to resolves matching pending ask", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.equal(tracker.resolveReplyTarget({ to: "reviewer" }, 1002).message.id, "ask-2");
  assert.equal(tracker.resolveReplyTarget({ to: "planner-id" }, 1002).message.id, "ask-1");
  assert.throws(() => tracker.resolveReplyTarget({ to: "review" }, 1002), /too short.*reviewer: to: "reviewer-" or replyTo: "ask-2"/);
});

test("reply with explicit to must match even when only one pending ask exists", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);

  assert.throws(() => tracker.resolveReplyTarget({ to: "reviewer" }, 1002), /No pending ask from "reviewer"/);
});

test("reply errors when no context and no pending asks", () => {
  const tracker = new ReplyTracker();

  assert.throws(() => tracker.resolveReplyTarget({}, 1000), /No active intercom context to reply to/);
});

test("reply errors when multiple pending asks and no to", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.throws(() => tracker.resolveReplyTarget({}, 1002), /Multiple pending asks — specify `to`/);
});

test("reply errors for duplicate sender names include copyable targets", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-11111111", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("planner-22222222", "planner"), createMessage("ask-2", "Second"), 1001);

  assert.throws(
    () => tracker.resolveReplyTarget({ to: "planner" }, 1002),
    /use one of: planner: to: "planner-1" or replyTo: "ask-1", planner: to: "planner-2" or replyTo: "ask-2"/,
  );
});

test("reply can disambiguate multiple pending asks with replyTo", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-2", "Second"), 1001);

  assert.equal(tracker.resolveReplyTarget({ to: "planner", replyTo: "ask-2" }, 1002).message.id, "ask-2");
  assert.throws(() => tracker.resolveReplyTarget({ to: "reviewer", replyTo: "ask-2" }, 1002), /is not from "reviewer"/);
});

test("reply exact full sender ID wins over prefix matches", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("abcdefgh", "first"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("abcdefghi", "second"), createMessage("ask-2", "Second"), 1001);

  assert.equal(tracker.resolveReplyTarget({ to: "abcdefgh" }, 1002).message.id, "ask-1");
  assert.throws(
    () => tracker.resolveReplyTarget({ to: "abcdefgh", replyTo: "ask-2" }, 1002),
    /is not from "abcdefgh"/,
  );
});

test("reply rejects too-short sender ID prefixes with a helpful target hint", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("abcdefgh", "first"), createMessage("ask-1", "First"), 1000);

  assert.throws(
    () => tracker.resolveReplyTarget({ to: "abcdefg" }, 1002),
    /too short.*first: to: "abcdefgh" or replyTo: "ask-1"/,
  );
  assert.throws(
    () => tracker.resolveReplyTarget({ to: "abcdefg", replyTo: "ask-1" }, 1002),
    /too short.*first: to: "abcdefgh" or replyTo: "ask-1"/,
  );
});

test("reply duplicate sender options avoid name and prefix collisions", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("abcdefgh1111", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("abcdefgi2222", "planner"), createMessage("ask-2", "Second"), 1001);
  tracker.recordIncomingMessage(createSession("other-id", "abcdefgh"), createMessage("ask-3", "Third"), 1002);

  assert.throws(
    () => tracker.resolveReplyTarget({ to: "planner" }, 1003),
    /planner: to: "abcdefgh1" or replyTo: "ask-1", planner: to: "abcdefgi" or replyTo: "ask-2"/,
  );
});

test("reply removes pending ask after successful reply", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  tracker.markReplied("ask-1");

  assert.deepEqual(tracker.listPending(1001), []);
});

test("reply expires pending and active asks when sender disconnects", () => {
  const tracker = new ReplyTracker();
  const planner = createSession("planner-id", "planner");
  const reviewer = createSession("reviewer-id", "reviewer");
  const current = tracker.recordIncomingMessage(planner, createMessage("ask-1", "Need a decision"), 1000);
  const queued = tracker.recordIncomingMessage(planner, createMessage("ask-2", "Queued decision"), 1001);
  tracker.recordIncomingMessage(reviewer, createMessage("ask-3", "Still connected"), 1002);
  tracker.queueTurnContext(current);
  tracker.queueTurnContext(queued);
  tracker.beginTurn(1003);

  tracker.expireSender("planner-id");

  assert.deepEqual(tracker.listPending(1004).map((context) => context.message.id), ["ask-3"]);
  assert.throws(() => tracker.resolveReplyTarget({ replyTo: "ask-1" }, 1004), /No pending ask/);
  assert.throws(() => tracker.resolveReplyTarget({ replyTo: "ask-2" }, 1004), /No pending ask/);
  assert.equal(tracker.resolveReplyTarget({}, 1004).message.id, "ask-3");
});
