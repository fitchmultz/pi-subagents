import * as fs from "node:fs";
import { Session } from "node:inspector";
import * as path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type FauxContentBlock,
  type StreamFunction,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { errorMessage } from "../../src/shared/unknown.ts";
import { observationText, SIZES } from "./observation-content.ts";

const CHUNK = 160;
// Benchmarks pace native events like a network stream; tests yield one macrotask per event.
const PACE_MS = Number(process.env.OBSERVATION_PACE_MS ?? 0);
const yieldTurn = (): Promise<unknown> => (PACE_MS > 0 ? delay(PACE_MS) : setImmediate());
type Update =
  | ((value: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void)
  | undefined;

function promptOf(context: TranscriptContext): string {
  const user = context.messages.find((message) => message.role === "user");
  if (typeof user?.content === "string") {
    return user.content;
  }
  return (user?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
}
function responseFor(context: TranscriptContext): FauxContentBlock[] {
  const results = context.messages.flatMap((message) =>
    message.role === "toolResult" ? [message] : [],
  );
  if (results.length > 0) {
    const summary = results.map((result) => {
      const first = result.content.at(0);
      return `${result.toolCallId}:${first?.type === "text" ? first.text : ""}`;
    });
    return [fauxText(`TOOLS_DONE ${summary.join(" ")} ${observationText(SIZES.finalText, "f")}`)];
  }
  const prompt = promptOf(context);
  const blocks: FauxContentBlock[] = [fauxThinking(observationText(SIZES.thinking, "k"))];
  if (["OBS_TEXT", "OBS_BENCH", "OBS_FAULT", "OBS_REWRITE", "OBS_MANY"].includes(prompt)) {
    blocks.push(fauxText(observationText(SIZES.text)));
  }
  if (prompt === "OBS_MANY") {
    for (let index = 0; index < SIZES.echoes; index++) {
      blocks.push(fauxToolCall("obs_echo", { index }, { id: `echo-${String(index)}` }));
    }
  }
  if (prompt === "OBS_TOOLS" || prompt === "OBS_BENCH") {
    blocks.push(
      fauxToolCall("obs_progress", { label: "A" }, { id: "tool-a" }),
      fauxToolCall("obs_growing", { label: "B" }, { id: "tool-b" }),
      fauxToolCall("obs_hostile", { label: "C" }, { id: "tool-c" }),
      fauxToolCall("obs_bigargs", { blob: observationText(SIZES.bigArgs, "a") }, { id: "tool-d" }),
    );
  }
  if (prompt === "OBS_NESTED") {
    blocks.push(fauxToolCall("obs_parent", {}, { id: "tool-e" }));
  }
  return blocks;
}

type Gate = (name: string, detail: object, signal?: AbortSignal) => Promise<void>;
/** A gate publishes what was already produced, then holds the native producer until released. */
function gateFor(root: string): Gate {
  const enabled = (process.env.OBSERVATION_GATES ?? "").split(",");
  return async (name, detail, signal) => {
    if (!enabled.includes(name)) {
      return;
    }
    fs.writeFileSync(path.join(root, `gate-${name}.json`), JSON.stringify(detail));
    while (!fs.existsSync(path.join(root, `release-${name}`))) {
      if (signal?.aborted === true) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
  };
}

/** A diagnostic CPU profile bracketing exactly the timed workload, never module or actor setup. */
function workloadProfiler(file: string | undefined): (running: boolean) => void {
  const session = new Session();
  let started = false;
  return (running) => {
    if (file === undefined || running === started) {
      return;
    }
    started = running;
    if (running) {
      session.connect();
      session.post("Profiler.enable");
      session.post("Profiler.setSamplingInterval", { interval: 250 });
      session.post("Profiler.start");
      return;
    }
    session.post("Profiler.stop", (error, result) => {
      fs.writeFileSync(file, JSON.stringify(error ?? result.profile), { flag: "wx" });
      session.disconnect();
    });
  };
}

/** A partial-only block whose text cannot be read: only observers ever read partial content. */
function hostileBlock(): FauxContentBlock {
  return Object.defineProperty(fauxText(""), "text", {
    enumerable: true,
    get(): string {
      throw new Error("hostile partial block");
    },
  });
}

/** Prompt-specific native partials after normal streaming, each held live at a gate. */
async function epilogue(
  prompt: string,
  outer: AssistantMessageEventStream,
  partial: AssistantMessage,
  gate: Gate,
  signal?: AbortSignal,
): Promise<void> {
  if (prompt === "OBS_FAULT") {
    await gate("fault", {}, signal);
    const content = [...partial.content, hostileBlock()];
    const contentIndex = content.length - 1;
    outer.push({ type: "text_delta", contentIndex, delta: "", partial: { ...partial, content } });
    // Hold the hostile partial live until the test observes the observer fault.
    await gate("hostile", {}, signal);
  } else if (prompt === "OBS_REWRITE") {
    await gate("rewrite", {}, signal);
    const [thinking, text] = [partial.content.at(0), partial.content.at(1)];
    if (thinking?.type !== "thinking" || text?.type !== "text") {
      throw new Error("Unexpected rewrite input");
    }
    // A provider correcting its own partial in place: the same block objects shrink or retype.
    text.text = text.text.slice(0, SIZES.rewrite);
    Object.assign(thinking, { type: "text", text: observationText(SIZES.rewrite, "r") });
    Reflect.deleteProperty(thinking, "thinking");
    outer.push({ type: "text_delta", contentIndex: 1, delta: "", partial: { ...partial } });
    await gate("rewritten", {}, signal);
  }
}

export default function observationFixture(pi: ExtensionAPI): void {
  const root = process.env.OBSERVATION_TEST_ROOT;
  if (root === undefined) {
    throw new Error("OBSERVATION_TEST_ROOT required");
  }
  const gate = gateFor(root);
  // Benchmark evidence measured inside the actor: the window starts at the first request.
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  let timed = false;
  const profile = workloadProfiler(process.env.OBSERVATION_PROFILE);
  const milestone = (name: string): void => {
    if (!timed) {
      timed = true;
      loop.reset();
      profile(true);
    }
    const at = performance.timeOrigin + performance.now();
    const { user, system } = process.cpuUsage();
    const { idle, active } = performance.eventLoopUtilization();
    const { rss, heapUsed } = process.memoryUsage();
    const sample = {
      name,
      at,
      // Monotonic microseconds, the clock of V8 CPU-profile timestamps.
      hrUs: Number(process.hrtime.bigint() / 1000n),
      cpuUs: user + system,
      elu: { idle, active },
      loop: { p50: loop.percentile(50), p99: loop.percentile(99), max: loop.max },
      rss,
      heapUsed,
      maxRssKb: process.resourceUsage().maxRSS,
    };
    fs.appendFileSync(path.join(root, "milestones.jsonl"), `${JSON.stringify(sample)}\n`);
  };

  // Faux partial semantics with one native event per macrotask, like a network stream.
  const play = async (
    outer: AssistantMessageEventStream,
    message: AssistantMessage,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const partial: AssistantMessage = { ...message, content: [], stopReason: "stop" };
    outer.push({ type: "start", partial: { ...partial } });
    for (const [index, block] of message.content.entries()) {
      if (block.type === "toolCall") {
        const live = { ...block, arguments: {} };
        partial.content = [...partial.content, live];
        outer.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
        // oxlint-disable-next-line no-await-in-loop
        await yieldTurn();
        // oxlint-disable-next-line no-await-in-loop
        await gate("call", { id: block.id }, signal);
        live.arguments = block.arguments;
        outer.push({
          type: "toolcall_end",
          contentIndex: index,
          toolCall: block,
          partial: { ...partial },
        });
        continue;
      }
      const full = block.type === "text" ? block.text : block.thinking;
      const live = block.type === "text" ? fauxText("") : fauxThinking("");
      partial.content = [...partial.content, live];
      outer.push({ type: `${block.type}_start`, contentIndex: index, partial: { ...partial } });
      for (let at = 0; at < full.length; at += CHUNK) {
        if (signal?.aborted === true) {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop
        await yieldTurn();
        const delta = full.slice(at, at + CHUNK);
        if (live.type === "text") {
          live.text += delta;
        } else {
          live.thinking += delta;
        }
        outer.push({
          type: `${block.type}_delta`,
          contentIndex: index,
          delta,
          partial: { ...partial },
        });
        const held = live.type === "text" ? SIZES.textGate : SIZES.thinking / 2;
        if (at < held && at + CHUNK >= held) {
          // oxlint-disable-next-line no-await-in-loop
          await gate(live.type, { chars: full.slice(0, at + CHUNK).length }, signal);
        }
      }
      outer.push({
        type: `${block.type}_end`,
        contentIndex: index,
        content: full,
        partial: { ...partial },
      });
    }
    await epilogue(prompt, outer, partial, gate, signal);
    milestone("response");
    profile(message.stopReason === "toolUse");
    if (
      message.stopReason === "stop" ||
      message.stopReason === "toolUse" ||
      message.stopReason === "length"
    ) {
      outer.push({ type: "done", reason: message.stopReason, message });
    }
    outer.end(message);
  };
  const stream: StreamFunction = (model, context, options) => {
    const outer = createAssistantMessageEventStream();
    const content = responseFor(context);
    const toolUse = content.some((block) => block.type === "toolCall");
    const message: AssistantMessage = {
      ...fauxAssistantMessage(content, { stopReason: toolUse ? "toolUse" : "stop" }),
      api: model.api,
      provider: model.provider,
      model: model.id,
    };
    milestone("request");
    play(outer, message, promptOf(context), options?.signal).catch((error: unknown) => {
      const failed: AssistantMessage = {
        ...message,
        stopReason: "error",
        errorMessage: errorMessage(error),
      };
      outer.push({ type: "error", reason: "error", error: failed });
      outer.end(failed);
    });
    return outer;
  };
  const core = createFauxCore({
    provider: "observation-fixture",
    models: [{ id: "observation-model", reasoning: true }],
  });
  pi.registerProvider(
    createProvider({
      id: core.provider,
      auth: { apiKey: { name: "Observation", resolve: () => Promise.resolve({ auth: {} }) } },
      models: core.models,
      api: { stream, streamSimple: stream },
    }),
  );
  registerTools(pi, gate);
}

/** Parallel tools finish in reverse order: D, C, B, then A after its mid-progress gate. */
function registerTools(pi: ExtensionAPI, gate: Gate): void {
  const barriers = new Map<string, PromiseWithResolvers<null>>();
  const barrier = (label: string): PromiseWithResolvers<null> => {
    const entry = barriers.get(label) ?? Promise.withResolvers<null>();
    barriers.set(label, entry);
    return entry;
  };
  const text = (value: string) => ({
    content: [{ type: "text" as const, text: value }],
    details: undefined,
  });
  const parameters = Type.Object({}, { additionalProperties: true });
  const tool = (
    name: string,
    execute: (
      params: object,
      signal: AbortSignal | undefined,
      update: Update,
    ) => Promise<ReturnType<typeof text>>,
  ): void => {
    pi.registerTool<typeof parameters>({
      name,
      label: name,
      description: `Observation fixture ${name}`,
      parameters,
      execute: (_id, params, signal, onUpdate) => execute(params, signal, onUpdate),
    });
  };
  pi.registerTool<typeof parameters>({
    name: "obs_parent",
    label: "obs_parent",
    description: "Observation fixture obs_parent",
    parameters,
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const outcome = await ctx.executeTool("obs_nested", {});
      const first = outcome.result.content.at(0);
      return text(`E=${first?.type === "text" ? first.text : "none"}`);
    },
  });
  tool("obs_nested", async (_params, signal, update) => {
    update?.({ content: [{ type: "text", text: "nested" }], details: { nested: 1 } });
    await yieldTurn();
    await gate("nested", {}, signal);
    return text("nested-done");
  });
  tool("obs_echo", async (params) => {
    await yieldTurn();
    const index = "index" in params && typeof params.index === "number" ? params.index : -1;
    return text(`E${String(index)}`);
  });
  tool("obs_bigargs", async (params) => {
    await yieldTurn();
    barrier("D").resolve(null);
    return text(
      `D=${"blob" in params && typeof params.blob === "string" ? params.blob.length : -1}`,
    );
  });
  tool("obs_hostile", async (_params, signal, update) => {
    await barrier("D").promise;
    const cyclic: Record<string, unknown> = { name: "cyclic" };
    cyclic.self = cyclic;
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const throwing = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    for (const details of [cyclic, proxy, throwing, { big: 1n }, new Uint8Array(1024)]) {
      update?.({ content: [{ type: "text", text: "hostile" }], details });
      // oxlint-disable-next-line no-await-in-loop
      await yieldTurn();
    }
    barrier("C").resolve(null);
    return text(signal?.aborted === true ? "C=aborted" : "C=ok");
  });
  tool("obs_growing", async (_params, _signal, update) => {
    await barrier("C").promise;
    // One mutable native object, replaced in place and growing far past every viewer budget.
    const first = { type: "text" as const, text: "" };
    const progress = { content: [first], details: { step: 0 } };
    for (let step = 1; step <= SIZES.growingSteps; step++) {
      first.text += observationText(SIZES.growingStep, `g${step}`);
      progress.details.step = step;
      update?.(progress);
      // oxlint-disable-next-line no-await-in-loop
      await yieldTurn();
    }
    barrier("B").resolve(null);
    return text(`B=${String(first.text.length)}`);
  });
  tool("obs_progress", async (_params, signal, update) => {
    await barrier("B").promise;
    for (let index = 1; index <= SIZES.progressUpdates; index++) {
      const value = observationText(SIZES.progress, `p${index}`);
      update?.({ content: [{ type: "text", text: value }], details: { update: index } });
      if (index === SIZES.progressUpdates / 2) {
        // oxlint-disable-next-line no-await-in-loop
        await gate("tools", { update: index }, signal);
      }
      // oxlint-disable-next-line no-await-in-loop
      await yieldTurn();
    }
    return text(`A=${SIZES.progressUpdates}`);
  });
}
