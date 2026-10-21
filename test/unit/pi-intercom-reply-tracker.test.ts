import "../support/isolated-home.ts";
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

test("queueTurnContext ignores a second enqueue of the same ask", () => {
  const tracker = new ReplyTracker();
  const context = tracker.recordIncomingMessage(
    createSession("planner-id", "planner"),
    createMessage("ask-1", "Need a decision"),
    1000,
  );
  tracker.queueTurnContext(context);
  tracker.queueTurnContext(context);
  tracker.beginTurn(1001);
  assert.equal(tracker.currentTurn()?.message.id, "ask-1");
  tracker.endAgent();
  tracker.beginTurn(1002);
  assert.equal(tracker.currentTurn(), null);
});

test("non-ask trigger context does not override a pending ask reply target", () => {
  const tracker = new ReplyTracker();
  const ask = tracker.recordIncomingMessage(
    createSession("planner-id", "planner"),
    createMessage("ask-1", "Need a decision"),
    1000,
  );
  const result = tracker.recordIncomingMessage(
    createSession("result-id", "subagent-result"),
    createMessage("result-1", "Done", false),
    1001,
  );

  tracker.queueTurnContext(result);
  tracker.beginTurn(1002);

  assert.equal(tracker.currentTurn(), null);
  assert.equal(tracker.resolveReplyTarget({}, 1003).message.id, ask.message.id);
  assert.equal(tracker.resolveReplyTarget({}, 1003).from.id, "planner-id");
});

test("reply targets and errors keep exact sender and ask correlation", () => {
  for (const { name, senders, checks, now = 1002 } of [
    {
      name: "matching name and full ID",
      senders: [
        ["planner-id", "planner"],
        ["reviewer-id", "reviewer"],
      ],
      checks: [
        { params: { to: "reviewer" }, expected: "ask-2" },
        { params: { to: "planner-id" }, expected: "ask-1" },
        {
          params: { to: "review" },
          expected: /too short.*reviewer: to: "reviewer-" or replyTo: "ask-2"/,
        },
      ],
    },
    {
      name: "explicit recipient cannot fall back to a sole ask",
      senders: [["planner-id", "planner"]],
      checks: [{ params: { to: "reviewer" }, expected: /No pending ask from "reviewer"/ }],
    },
    {
      name: "no context or pending asks",
      senders: [],
      now: 1000,
      checks: [{ params: {}, expected: /No active intercom context to reply to/ }],
    },
    {
      name: "multiple pending asks require a target",
      senders: [
        ["planner-id", "planner"],
        ["reviewer-id", "reviewer"],
      ],
      checks: [{ params: {}, expected: /Multiple pending asks — specify `to`/ }],
    },
    {
      name: "duplicate sender names offer copyable targets",
      senders: [
        ["planner-11111111", "planner"],
        ["planner-22222222", "planner"],
      ],
      checks: [
        {
          params: { to: "planner" },
          expected:
            /use one of: planner: to: "planner-1" or replyTo: "ask-1", planner: to: "planner-2" or replyTo: "ask-2"/,
        },
      ],
    },
    {
      name: "replyTo disambiguates one sender but cannot spoof another",
      senders: [
        ["planner-id", "planner"],
        ["planner-id", "planner"],
      ],
      checks: [
        { params: { to: "planner", replyTo: "ask-2" }, expected: "ask-2" },
        { params: { to: "reviewer", replyTo: "ask-2" }, expected: /is not from "reviewer"/ },
      ],
    },
    {
      name: "exact full sender ID wins over a longer prefix match",
      senders: [
        ["abcdefgh", "first"],
        ["abcdefghi", "second"],
      ],
      checks: [
        { params: { to: "abcdefgh" }, expected: "ask-1" },
        { params: { to: "abcdefgh", replyTo: "ask-2" }, expected: /is not from "abcdefgh"/ },
      ],
    },
    {
      name: "short prefixes fail with and without replyTo",
      senders: [["abcdefgh", "first"]],
      checks: [
        {
          params: { to: "abcdefg" },
          expected: /too short.*first: to: "abcdefgh" or replyTo: "ask-1"/,
        },
        {
          params: { to: "abcdefg", replyTo: "ask-1" },
          expected: /too short.*first: to: "abcdefgh" or replyTo: "ask-1"/,
        },
      ],
    },
    {
      name: "duplicate sender suggestions avoid name and prefix collisions",
      senders: [
        ["abcdefgh1111", "planner"],
        ["abcdefgi2222", "planner"],
        ["other-id", "abcdefgh"],
      ],
      now: 1003,
      checks: [
        {
          params: { to: "planner" },
          expected:
            /planner: to: "abcdefgh1" or replyTo: "ask-1", planner: to: "abcdefgi" or replyTo: "ask-2"/,
        },
      ],
    },
  ]) {
    const tracker = new ReplyTracker();
    for (const [index, [id, senderName]] of senders.entries()) {
      tracker.recordIncomingMessage(
        createSession(id, senderName),
        createMessage(`ask-${index + 1}`, ["First", "Second", "Third"][index]),
        1000 + index,
      );
    }
    for (const { params, expected } of checks) {
      if (typeof expected === "string") {
        assert.equal(tracker.resolveReplyTarget(params, now).message.id, expected, name);
      } else {
        assert.throws(() => tracker.resolveReplyTarget(params, now), expected, name);
      }
    }
  }
});

test("reply preserves every pending ask and queued turn context beyond 100 messages", () => {
  const tracker = new ReplyTracker();
  const sender = createSession("sender-id", "sender");
  for (let index = 1; index <= 150; index++) {
    const context = tracker.recordIncomingMessage(
      sender,
      createMessage(`ask-${index}`, `Question ${index}`),
      index,
    );
    tracker.queueTurnContext(context);
  }

  assert.equal(tracker.listPending(151).length, 150);
  assert.equal(tracker.listPending(151)[0]?.message.id, "ask-1");
  const queued: string[] = [];
  for (let index = 0; index < 150; index++) {
    tracker.beginTurn(151);
    const current = tracker.currentTurn();
    assert.ok(current);
    queued.push(current.message.id);
    tracker.endAgent();
  }
  tracker.beginTurn(151);
  assert.equal(tracker.currentTurn(), null);
  assert.equal(queued[0], "ask-1");
  assert.equal(queued.at(-1), "ask-150");
});

test("reply expires pending and queued contexts together", () => {
  const tracker = new ReplyTracker(10);
  const context = tracker.recordIncomingMessage(
    createSession("planner-id", "planner"),
    createMessage("ask-old", "Old"),
    1000,
  );
  tracker.queueTurnContext(context);
  tracker.beginTurn(1011);
  assert.equal(tracker.currentTurn(), null);
  assert.deepEqual(tracker.listPending(1011), []);
});

test("message text cannot grant an ordinary ask a disconnect or timeout exemption", () => {
  const sender = createSession("peer-id", "peer");
  const message = createMessage(
    "question",
    "Subagent needs a supervisor decision.\nQuestion ID: question\nContinue?",
  );
  for (const transition of ["disconnect", "timeout"]) {
    const tracker = new ReplyTracker(10);
    tracker.queueTurnContext(tracker.recordIncomingMessage(sender, message, 1000));
    tracker.beginTurn(1001);
    if (transition === "disconnect") {
      tracker.expireSender(sender.id);
    }
    assert.deepEqual(tracker.listPending(5000), []);
    assert.equal(tracker.currentTurn(), null);
    assert.throws(() => tracker.resolveReplyTarget({}, 5001), /No active intercom context/);
  }
});

test("reply expires pending and active asks when sender disconnects", () => {
  const tracker = new ReplyTracker();
  const planner = createSession("planner-id", "planner");
  const reviewer = createSession("reviewer-id", "reviewer");
  const current = tracker.recordIncomingMessage(
    planner,
    createMessage("ask-1", "Need a decision"),
    1000,
  );
  const queued = tracker.recordIncomingMessage(
    planner,
    createMessage("ask-2", "Queued decision"),
    1001,
  );
  tracker.recordIncomingMessage(reviewer, createMessage("ask-3", "Still connected"), 1002);
  tracker.queueTurnContext(current);
  tracker.queueTurnContext(queued);
  tracker.beginTurn(1003);

  tracker.expireSender("planner-id");

  assert.deepEqual(
    tracker.listPending(1004).map((context) => context.message.id),
    ["ask-3"],
  );
  assert.throws(() => tracker.resolveReplyTarget({ replyTo: "ask-1" }, 1004), /No pending ask/);
  assert.throws(() => tracker.resolveReplyTarget({ replyTo: "ask-2" }, 1004), /No pending ask/);
  assert.equal(tracker.resolveReplyTarget({}, 1004).message.id, "ask-3");
});
