import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test as nodeTest, type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { writeFrame } from "../../src/pi-intercom/broker/framing.ts";
import { agentObservationSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { observationText, SIZES } from "../fixtures/observation-content.ts";
import { record } from "../support/assertions.ts";
import { nativeSdkRoot } from "../support/native-sdk.ts";
import {
  dead,
  ObservedChild,
  until,
  type ObservedChildOptions,
} from "../support/observation-child.ts";
import { ObservationViewer } from "../support/observation-viewer.ts";

const sdk = nativeSdkRoot(process.env.PI_OBSERVATION_TEST_SDK);
// Unix socket paths are short; the suite's nested temporary home is not.
const runtime = fs.mkdtempSync("/tmp/pao-ic-");
process.env.PI_INTERCOM_RUNTIME_DIR = path.join(runtime, "ic");
process.on("exit", () => {
  fs.rmSync(runtime, { recursive: true, force: true });
});
const FINAL = observationText(SIZES.finalText, "f");

async function child(t: TestContext, options: Omit<ObservedChildOptions, "sdk">) {
  const started = await ObservedChild.start({ sdk, ...options });
  t.after(async () => {
    try {
      await started.stop();
    } finally {
      started.cleanup();
    }
  });
  return started;
}
async function viewer(
  started: ObservedChild,
  level: "detail" | "activity" = "detail",
): Promise<ObservationViewer> {
  const observed = await ObservationViewer.connect({ ...started.identity(), level });
  // The snapshot proves the actor registered this viewer before any negative check.
  await observed.until(() => observed.snapshot !== undefined, "snapshot");
  return observed;
}
function messages(started: ObservedChild, after: unknown) {
  const journal = started.journal();
  const start = journal.findIndex((entry) => entry.id === after);
  return journal.slice(start + 1).filter((entry) => entry.type === "message");
}
function textOf(entry: Record<string, unknown>, type = "text"): string {
  const content = record(entry.message).content;
  assert.ok(Array.isArray(content));
  return content
    .map((block) => record(block))
    .filter((block) => block.type === type)
    .map((block) => block[type === "text" ? "text" : "thinking"])
    .filter((text) => typeof text === "string")
    .join("");
}
function errorText(value: unknown): string {
  return typeof value === "string" ? value : assert.fail(`Expected an error, got ${typeof value}`);
}
function handedOver(started: ObservedChild, observed: ObservationViewer): () => boolean {
  return () =>
    observed.message === undefined &&
    observed.tools.size === 0 &&
    observed.settled.length === messages(started, observed.snapshot?.leafId).length;
}
/** Every native message published after the viewer's snapshot is handed over exactly once. */
function assertHandover(started: ObservedChild, observed: ObservationViewer, resyncs = 0): void {
  assert.deepEqual(observed.errors, []);
  assert.equal(observed.resyncs, resyncs);
  const published = messages(started, observed.snapshot?.leafId);
  assert.deepEqual(
    observed.settled.map((item) => item.entry),
    published.map((entry) => entry.id),
  );
  for (const [index, item] of observed.settled.entries()) {
    const message = record(published[index]?.message);
    assert.equal(item.tool, message.role === "toolResult" ? message.toolCallId : null);
    assert.equal(item.key !== null, message.role === "assistant");
  }
  assert.equal(observed.message, undefined);
  assert.equal(observed.tools.size, 0);
  assert.ok(Math.max(...observed.frameSizes) <= 256 * 1024);
}
/** At the tools gate A is mid-progress while B, C and D have ended unpublished. */
function gatedTools(observed: ObservationViewer): boolean {
  const progress = {
    json: {
      content: [
        {
          type: "text",
          text: observationText(SIZES.progress, `p${String(SIZES.progressUpdates / 2)}`),
        },
      ],
      details: { update: SIZES.progressUpdates / 2 },
    },
  };
  const [a, b, c, d] = ["tool-a", "tool-b", "tool-c", "tool-d"].map((id) => observed.tools.get(id));
  return (
    a !== undefined &&
    isDeepStrictEqual(a.partial, progress) &&
    a.end === undefined &&
    b?.end !== undefined &&
    c?.end !== undefined &&
    d?.end !== undefined
  );
}
const TOOLS_DONE = `TOOLS_DONE tool-a:A=${String(SIZES.progressUpdates)} tool-b:B=${String(SIZES.growingStep * SIZES.growingSteps)} tool-c:C=ok tool-d:D=${String(SIZES.bigArgs)}`;
function assertUnobserved(started: ObservedChild, shutdown: Record<string, unknown>): void {
  // Viewers never write commands: only the parent's run command was admitted.
  assert.deepEqual(started.listing("commands"), [`${started.launch.id}.json`]);
  assert.deepEqual(started.listing("admissions"), [`${started.launch.id}.json`]);
  assert.equal(fs.existsSync(agentObservationSocketPath(started.identity().token)), false);
  assert.equal(record(shutdown.observation).error, undefined);
}

nodeTest(
  "live text reconstructs exactly, survives reopen and hands over to durable entries",
  {
    timeout: 180_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_TEXT", gates: ["text"] });
    const first = await viewer(started);
    started.run();
    const { chars } = await started.gate("text");
    assert.equal(typeof chars, "number");
    const expected = observationText(SIZES.text).slice(0, Number(chars));
    const live = (observed: ObservationViewer) => (): boolean => {
      const text = observed.liveText();
      assert.ok(expected.startsWith(text), "live text is always a prefix of native output");
      return text === expected;
    };
    await first.until(live(first), "gated live text");
    assert.equal(first.liveText("thinking"), observationText(SIZES.thinking, "k"));
    first.close();

    const reopened = await viewer(started);
    await reopened.until(live(reopened), "reopened live text");
    started.release("text");
    const result = await started.result();
    assert.equal(result.status, "completed");
    assert.equal(started.output(), observationText(SIZES.text));
    await reopened.until(handedOver(started, reopened), "handover");
    assertHandover(started, reopened);

    const [key, shown] = [...reopened.shown].at(0) ?? [];
    const settled = reopened.settled.find((item) => item.key === key);
    const entry = started.journal().find((item) => item.id === settled?.entry);
    assert.ok(entry !== undefined && shown !== undefined);
    const durable = textOf(entry);
    const shownText = shown.find((block) => block.type === "text")?.text ?? "";
    assert.equal(durable, observationText(SIZES.text));
    assert.ok(shownText.length >= expected.length && durable.startsWith(shownText));
    await reopened.until(
      () => record(reopened.activity).phase === "idle",
      "idle activity after completion",
    );
    const shutdown = await started.stop();
    assertUnobserved(started, shutdown);
    assert.ok(Number(record(shutdown.observation).viewers) >= 2);
  },
);

nodeTest(
  "concurrent tool progress stays bounded across reopen and reverse completion",
  {
    timeout: 180_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_TOOLS", gates: ["tools"] });
    const first = await viewer(started);
    started.run();
    const { update } = await started.gate("tools");
    assert.equal(update, SIZES.progressUpdates / 2);
    await first.until(() => gatedTools(first), "gated tool progress");
    first.close();

    const reopened = await viewer(started);
    await reopened.until(() => gatedTools(reopened), "reopened tool progress");
    const tools = reopened.tools;
    assert.deepEqual(tools.get("tool-a")?.args, { json: { label: "A" } });
    assert.deepEqual(tools.get("tool-d")?.args, { unavailable: "oversize" });
    assert.deepEqual(tools.get("tool-b")?.partial, { unavailable: "oversize" });
    assert.deepEqual(tools.get("tool-c")?.partial, { unavailable: "unsupported" });
    const ended = { B: SIZES.growingStep * SIZES.growingSteps, C: "ok", D: SIZES.bigArgs };
    for (const [label, value] of Object.entries(ended)) {
      const end = tools.get(`tool-${label.toLowerCase()}`)?.end;
      assert.equal(end?.isError, false);
      assert.deepEqual(record(record(end.result).json).content, [
        { type: "text", text: `${label}=${String(value)}` },
      ]);
    }
    started.release("tools");
    const result = await started.result();
    assert.equal(result.status, "completed");
    assert.equal(started.output(), `${TOOLS_DONE} ${FINAL}`);
    await reopened.until(handedOver(started, reopened), "tool and final handovers");
    assertHandover(started, reopened);
    assert.deepEqual([...reopened.finishedTools.keys()].sort(), [
      "tool-a",
      "tool-b",
      "tool-c",
      "tool-d",
    ]);
    assertUnobserved(started, await started.stop());
  },
);

nodeTest(
  "a paused viewer never changes native output and catches up after resuming",
  {
    timeout: 180_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_BENCH", gates: ["text"] });
    const paused = await viewer(started);
    paused.pause();
    const probe = await viewer(started);
    started.run();
    const { chars } = await started.gate("text");
    const expected = observationText(SIZES.text).slice(0, Number(chars));
    // Each flush writes to every writable viewer; the probe proves the paused one was written.
    await probe.until(() => probe.liveText() === expected, "live text reached the probe");
    probe.close();
    started.release("text");
    const result = await started.result();
    assert.equal(result.status, "completed");
    assert.ok(started.output().startsWith("TOOLS_DONE tool-a:A=40"));
    assert.ok(started.output().endsWith(FINAL));
    paused.resume();
    await paused.until(handedOver(started, paused), "paused viewer convergence");
    assertHandover(started, paused);
    const shutdown = await started.stop();
    assertUnobserved(started, shutdown);
    const stats = record(shutdown.observation);
    assert.ok(Number(stats.backpressured) > 0, "the paused viewer exerted real backpressure");
    assert.ok(Number(stats.largestBuffered) <= 1024 * 1024 + 256 * 1024);
  },
);

nodeTest(
  "a viewer that misses retained handovers resynchronizes from a durable baseline",
  {
    timeout: 180_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_MANY", gates: ["text"] });
    const paused = await viewer(started);
    paused.pause();
    const probe = await viewer(started);
    started.run();
    const { chars } = await started.gate("text");
    const expected = observationText(SIZES.text).slice(0, Number(chars));
    await probe.until(() => probe.liveText() === expected, "live text reached the probe");
    probe.close();
    started.release("text");
    assert.equal((await started.result()).status, "completed");
    assert.ok(started.output().endsWith(FINAL));
    assert.ok(messages(started, paused.snapshot?.leafId).length > SIZES.echoes);
    paused.resume();
    await paused.until(handedOver(started, paused), "resynchronized convergence");
    assertHandover(started, paused, 1);
    assertUnobserved(started, await started.stop());
  },
);

nodeTest(
  "live blocks that shrink or change type in place are resent, never stitched",
  {
    timeout: 120_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_REWRITE", gates: ["rewrite", "rewritten"] });
    const observed = await viewer(started);
    started.run();
    await started.gate("rewrite");
    const full = observationText(SIZES.text);
    await observed.until(() => observed.liveText() === full, "original live text");
    started.release("rewrite");
    await started.gate("rewritten");
    const rewritten = [
      { type: "text", text: observationText(SIZES.rewrite, "r") },
      { type: "text", text: full.slice(0, SIZES.rewrite) },
    ];
    await observed.until(
      () => isDeepStrictEqual(observed.message?.blocks, rewritten),
      "rewritten live blocks",
    );
    started.release("rewritten");
    assert.equal((await started.result()).status, "completed");
    assert.equal(started.output(), full);
    await observed.until(handedOver(started, observed), "handover");
    assertHandover(started, observed);
    assertUnobserved(started, await started.stop());
  },
);

nodeTest(
  "a crashed generation's endpoint is removed before its replacement starts",
  {
    timeout: 120_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_TEXT" });
    const orphaned = await viewer(started);
    const leftover = agentObservationSocketPath(started.identity().token);
    const { pid } = started.actor();
    process.kill(-pid, "SIGKILL");
    await until(() => dead(pid), "actor death");
    await orphaned.until(() => orphaned.closed, "viewer disconnect");
    assert.equal(fs.lstatSync(leftover).isSocket(), true, "a killed actor cannot unlink");
    await started.ensure();
    assert.equal(fs.existsSync(leftover), false);
    const observed = await viewer(started);
    started.run();
    assert.equal((await started.result()).status, "completed");
    assert.equal(started.output(), observationText(SIZES.text));
    await observed.until(handedOver(started, observed), "handover");
    assertHandover(started, observed);
    assertUnobserved(started, await started.stop());
  },
);

nodeTest(
  "a connected viewer of an idle actor arms no recurring flush",
  {
    timeout: 60_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_TEXT" });
    const observed = await viewer(started);
    // A measurement window, not a readiness wait: the snapshot already proved registration.
    await delay(1500);
    assert.equal(observed.frames, 1);
    const stats = record((await started.stop()).observation);
    assert.ok(Number(stats.flushes) <= 1, `idle flushes: ${JSON.stringify(stats.flushes)}`);
  },
);

nodeTest(
  "foreign viewers are refused and an unsafe endpoint only disables observation",
  {
    timeout: 120_000,
  },
  async (t) => {
    const elsewhere = fs.mkdtempSync("/tmp/pao-elsewhere-");
    t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    // The actor copies the runtime directory at spawn; plant a fresh one for this actor only.
    const shared = process.env.PI_INTERCOM_RUNTIME_DIR;
    process.env.PI_INTERCOM_RUNTIME_DIR = path.join(runtime, "unsafe");
    const planted = `${process.env.PI_INTERCOM_RUNTIME_DIR}-agents`;
    fs.symlinkSync(elsewhere, planted);
    const unsafe = await child(t, { prompt: "OBS_TEXT" }).finally(() => {
      process.env.PI_INTERCOM_RUNTIME_DIR = shared;
    });
    unsafe.run();
    assert.equal((await unsafe.result()).status, "completed");
    assert.equal(unsafe.output(), observationText(SIZES.text));
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    const disabled = record((await unsafe.stop()).observation);
    assert.match(errorText(disabled.error), /Unsafe intercom socket directory/);
    fs.unlinkSync(planted);

    const started = await child(t, { prompt: "OBS_TEXT" });
    const socketPath = agentObservationSocketPath(started.identity().token);
    const refused = async (hello: Record<string, unknown>, extra?: unknown): Promise<number> => {
      const socket = net.createConnection(socketPath);
      await once(socket, "connect");
      let bytes = 0;
      socket.on("data", (data: Buffer) => {
        bytes += data.length;
      });
      writeFrame(socket, JSON.stringify(hello));
      if (extra !== undefined) {
        writeFrame(socket, JSON.stringify(extra));
      }
      await once(socket, "close");
      return bytes;
    };
    const identity = started.identity();
    const hello = { t: "hello", v: 1, ...identity, level: "detail" };
    assert.equal(await refused({ ...hello, token: identity.token.replace(/.$/, "x") }), 0);
    assert.equal(await refused({ ...hello, sessionId: "other" }), 0);
    assert.equal(await refused({ ...hello, level: "control" }), 0);
    // A valid viewer that sends anything after its hello is disconnected, not obeyed, and its
    // slot is reclaimed: twice the four-viewer detail capacity, then a healthy viewer.
    for (let attempt = 0; attempt < 8; attempt++) {
      // oxlint-disable-next-line no-await-in-loop
      assert.ok((await refused(hello, { t: "stop" })) > 0, `post-hello viewer ${String(attempt)}`);
    }
    (await viewer(started)).close();
    started.run();
    assert.equal((await started.result()).status, "completed");
    assertUnobserved(started, await started.stop());
  },
);

nodeTest(
  "an observer fault whose teardown cannot remove the endpoint never touches native work",
  {
    timeout: 120_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_FAULT", gates: ["fault", "hostile"] });
    const observed = await viewer(started);
    const socketPath = agentObservationSocketPath(started.identity().token);
    const directory = path.dirname(socketPath);
    t.after(() => fs.chmodSync(directory, 0o700));
    started.run();
    await started.gate("fault");
    const expected = observationText(SIZES.text);
    await observed.until(() => observed.liveText() === expected, "caught up before the fault");
    // Teardown's unlink now fails at the real filesystem boundary.
    fs.chmodSync(directory, 0o500);
    started.release("fault");
    await started.gate("hostile");
    await observed.until(() => observed.closed, "observation disabled by the fault");
    fs.chmodSync(directory, 0o700);
    started.release("hostile");
    const result = await started.result();
    assert.equal(result.status, "completed");
    assert.equal(started.output(), expected);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true, "the failed unlink left the endpoint");
    const shutdown = await started.stop();
    assert.match(errorText(record(shutdown.observation).error), /hostile partial block/);
    assert.deepEqual(started.listing("commands"), [`${started.launch.id}.json`]);
    fs.rmSync(socketPath);
  },
);

nodeTest(
  "a late viewer starts from native state and tools stay exact across unobserved intervals",
  {
    timeout: 180_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_BENCH", gates: ["text", "tools"] });
    started.run();
    const { chars } = await started.gate("text");
    const expected = observationText(SIZES.text).slice(0, Number(chars));
    const late = await viewer(started);
    await late.until(() => late.liveText() === expected, "late live text");
    assert.equal(late.liveText("thinking"), observationText(SIZES.thinking, "k"));
    late.close();
    // Nobody watches while the text finishes and every tool starts, reports and ends.
    started.release("text");
    await started.gate("tools");
    const reopened = await viewer(started);
    await reopened.until(() => gatedTools(reopened), "tool progress after an unobserved interval");
    started.release("tools");
    assert.equal((await started.result()).status, "completed");
    assert.equal(started.output(), `${TOOLS_DONE} ${FINAL}`);
    await reopened.until(handedOver(started, reopened), "handover");
    assertHandover(started, reopened);
    const shutdown = await started.stop();
    assertUnobserved(started, shutdown);
    // Each viewer subscribed afresh: native message events were unobserved in between.
    assert.equal(record(shutdown.observation).subscriptions, 2);
  },
);

nodeTest(
  "an activity peer follows block transitions within one native message",
  {
    timeout: 120_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_BENCH", gates: ["thinking", "text", "call"] });
    const peer = await viewer(started, "activity");
    started.run();
    // A detail viewer subscribes to native events; its exit must not stop activity sampling.
    const detail = await viewer(started, "detail");
    detail.close();
    await delay(50);
    for (const [gate, phase] of [
      ["thinking", "thinking"],
      ["text", "writing"],
      ["call", "calling"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await started.gate(gate);
      // oxlint-disable-next-line no-await-in-loop
      await peer.until(() => record(peer.activity).phase === phase, `${phase} activity`);
      started.release(gate);
    }
    assert.equal((await started.result()).status, "completed");
    assert.equal(started.output(), `${TOOLS_DONE} ${FINAL}`);
    await peer.until(() => record(peer.activity).phase === "idle", "idle activity");
    assert.deepEqual(peer.errors, []);
    assert.equal(peer.message, undefined, "activity peers receive no content");
    assertUnobserved(started, await started.stop());
  },
);

nodeTest(
  "nested tool calls are shown live and retired with their parent's result",
  {
    timeout: 120_000,
  },
  async (t) => {
    const started = await child(t, { prompt: "OBS_NESTED", gates: ["nested"] });
    const observed = await viewer(started);
    started.run();
    await started.gate("nested");
    const nested = (): string | undefined =>
      [...observed.tools.keys()].find((id) => id.startsWith("tool-e/"));
    await observed.until(
      () => observed.tools.get(nested() ?? "")?.partial !== undefined,
      "nested tool progress",
    );
    const id = nested() ?? "";
    assert.equal(observed.tools.get(id)?.name, "obs_nested");
    assert.deepEqual(observed.tools.get(id)?.partial, {
      json: { content: [{ type: "text", text: "nested" }], details: { nested: 1 } },
    });
    assert.equal(observed.tools.get("tool-e")?.end, undefined);
    started.release("nested");
    assert.equal((await started.result()).status, "completed");
    assert.equal(started.output(), `TOOLS_DONE tool-e:E=nested-done ${FINAL}`);
    await observed.until(handedOver(started, observed), "handover");
    assertHandover(started, observed);
    assert.deepEqual([...observed.finishedTools.keys()].sort(), ["tool-e", id]);
    // A fresh baseline proves the actor itself retired the nested call.
    const fresh = await viewer(started);
    assert.deepEqual([...fresh.tools.keys()], []);
    assertUnobserved(started, await started.stop());
  },
);
