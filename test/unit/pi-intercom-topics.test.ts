import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createNativeSessionFixture,
  type NativeSessionFixture,
} from "../support/native-session.ts";
import type { Message, TopicUpdate } from "../../src/pi-intercom/types.ts";
import { IntercomTopics } from "../../src/pi-intercom/topics.ts";

const hosts: NativeSessionFixture[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((fixture) => fixture.dispose()));
});

async function host(id: string, manager = SessionManager.inMemory("/fixture", { id })) {
  const fixture = await createNativeSessionFixture({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionManager: manager,
  });
  hosts.push(fixture);
  const statuses = new Map<string, string>();
  const ctx: ExtensionContext = {
    ...fixture.context,
    mode: "tui",
    hasUI: true,
    ui: {
      ...fixture.context.ui,
      setStatus(key, text) {
        if (text === undefined) {
          statuses.delete(key);
        } else {
          statuses.set(key, text);
        }
      },
    },
  };
  const topics = new IntercomTopics(fixture.pi, () => ctx);
  topics.start(ctx);
  return { topics, manager, statuses };
}

test("resource ownership stays inspectable without a footer across publication, disconnect and restoration", async () => {
  const owner = await host("owner"),
    subscriber = await host("subscriber");
  const from = { id: "owner", name: "QA", cwd: "/fixture", model: "fixture" };
  const held: TopicUpdate = {
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
  const restored = await host("subscriber", subscriber.manager);
  assert.match(restored.topics.inspect(), /declared held; disconnect is not release/);
  assert.equal(restored.statuses.size, 0);
  const released: TopicUpdate = {
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
  assert.match((await host("owner", owner.manager)).topics.inspect(), /Tab is available/);
  assert.equal(owner.statuses.size, 0);
  assert.equal(restored.statuses.size, 0);
});

for (const event of ["blocker", "decision", "release"] as const) {
  test(`presence refresh cannot swallow the first live topic ${event}`, async () => {
    const topic = "browser/shared",
      from = { id: "publisher", name: "QA", cwd: "/fixture", model: "fixture" };
    const subscriber = await host("subscriber"),
      late = await host("late");
    const previous: TopicUpdate = {
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
    const update: TopicUpdate = {
      ...previous,
      text: "Current action",
      event,
      ownership: event === "release" ? "released" : "held",
      revision: 2,
      updatedAt: 2,
    };
    const presence = [{ ...from, topics: [update] }];
    const message: Message = {
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
    const restored = await host("subscriber", subscriber.manager);
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
