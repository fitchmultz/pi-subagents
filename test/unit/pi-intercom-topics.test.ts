import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IntercomTopics } from "../../src/pi-intercom/topics.ts";

function host(id, entries = []) {
  const statuses = new Map<string, string>();
  const ctx = {
    mode: "tui",
    ui: {
      setStatus: (key, text) =>
        text === undefined ? statuses.delete(key) : statuses.set(key, text),
    },
    sessionManager: { getSessionId: () => id, getEntries: () => entries },
  };
  const topics = new IntercomTopics(
    {
      appendEntry: (customType, data) =>
        entries.push({ type: "custom", customType, data: structuredClone(data) }),
    },
    () => ctx,
  );
  topics.start(ctx);
  return { topics, entries, statuses };
}

test("resource ownership stays inspectable without a footer across publication, disconnect and restoration", () => {
  const owner = host("owner"),
    subscriber = host("subscriber");
  const from = { id: "owner", name: "QA", cwd: "/fixture", model: "fixture" };
  const held = {
    topic: "browser/shared",
    text: "Checking login",
    event: "update",
    resource: "tab/login",
    ownership: "held",
    revision: 1,
    updatedAt: 1,
  };
  subscriber.topics.subscribe(held.topic, true);
  owner.topics.publish(held, from);
  subscriber.topics.refresh([{ ...from, topics: [held] }]);
  assert.match(subscriber.topics.inspect(), /Resource: tab\/login · declared held/);
  assert.equal(owner.statuses.size, 0, "publishing ownership must not add footer text");
  assert.equal(subscriber.statuses.size, 0, "observing ownership must not add footer text");
  subscriber.topics.disconnected(from.id);
  assert.match(subscriber.topics.inspect(), /disconnected \/ unavailable/);
  assert.match(subscriber.topics.inspect(), /disconnect is not release/);
  assert.equal(subscriber.statuses.size, 0);
  const restored = host("subscriber", subscriber.entries);
  assert.match(restored.topics.inspect(), /declared held; disconnect is not release/);
  assert.equal(restored.statuses.size, 0);
  const released = {
    ...held,
    text: "Tab is available",
    event: "release",
    ownership: "released",
    revision: 2,
    updatedAt: 2,
  };
  owner.topics.publish(released, from);
  assert.equal(
    restored.topics.receive(from, {
      id: "release",
      timestamp: 2,
      delivery: "steer",
      content: { text: released.text },
      topic: released,
    }),
    false,
    "awaited release still needs conversation delivery",
  );
  assert.match(restored.topics.inspect(), /declared released/);
  assert.match(host("owner", owner.entries).topics.inspect(), /Tab is available/);
  assert.equal(owner.statuses.size, 0);
  assert.equal(restored.statuses.size, 0);
});

for (const event of ["blocker", "decision", "release"] as const) {
  test(`presence refresh cannot swallow the first live topic ${event}`, () => {
    const topic = "browser/shared",
      from = { id: "publisher", name: "QA", cwd: "/fixture", model: "fixture" };
    const subscriber = host("subscriber"),
      late = host("late");
    const previous = {
      topic,
      text: "Checking login",
      event: "update",
      resource: "tab/login",
      ownership: "held",
      revision: 1,
      updatedAt: 1,
    };
    subscriber.topics.subscribe(topic, true);
    subscriber.topics.refresh([{ ...from, topics: [previous] }]);
    const update = {
      ...previous,
      text: "Current action",
      event,
      ownership: event === "release" ? "released" : "held",
      revision: 2,
      updatedAt: 2,
    };
    const presence = [{ ...from, topics: [update] }];
    const message = {
      id: "live",
      timestamp: 2,
      delivery: "steer",
      content: { text: update.text },
      topic: update,
    };
    subscriber.topics.refresh(presence); // A list/inspect can observe presence before broker delivery.
    assert.equal(
      subscriber.topics.receive(from, message),
      false,
      "first live action needs conversation delivery",
    );
    assert.equal(subscriber.topics.receive(from, message), true, "duplicate actions are quiet");
    assert.match(subscriber.topics.inspect(topic), /Current action/);
    assert.doesNotMatch(subscriber.topics.inspect(topic), /Checking login/);
    late.topics.subscribe(topic, true);
    late.topics.refresh(presence);
    assert.equal(
      late.topics.receive(from, message),
      true,
      "initial subscription never replays an old action",
    );
    const restored = host("subscriber", subscriber.entries);
    restored.topics.refresh(presence);
    assert.equal(
      restored.topics.receive(from, message),
      true,
      "reload never replays a handled action",
    );
    const next = { ...update, text: "Next action", revision: 3, updatedAt: 3 };
    restored.topics.refresh([{ ...from, topics: [next] }]);
    assert.equal(
      restored.topics.receive(from, { ...message, id: "next", topic: next }),
      false,
      "live delivery after restoration still interrupts",
    );
  });
}
