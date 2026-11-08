import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { loadNativeAI } from "../support/native-host.ts";
import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import { traceReadSync, traceReaddirSync } from "../support/strict-fixture-fs.ts";

// Observe the actual runner's synchronous command scans, not a replacement Actor.
function commandIO(/** @type {string} */ root) {
  const original = { open: fs.openSync, close: fs.closeSync };
  /** @type {Map<number, { file: string, opens: number, bytes: number }>} */
  const descriptors = new Map();
  /** @type {{ file: string, opens: number, bytes: number }[]} */ let reads = [];
  /** @type {typeof fs.openSync} */
  const tracedOpen = (file, flags, mode) => {
    const fd = original.open(file, flags, mode);
    if (typeof file === "string" && file.endsWith("/attachment.json") && flags === "r") {
      // The actor's parent liveness check witnesses elapsed loop iterations.
      fs.appendFileSync(
        path.join(root, "actor-ticks.jsonl"),
        JSON.stringify({ pid: process.pid }) + "\n",
      );
    }
    if (typeof file === "string" && file.includes("/commands/") && flags === "r") {
      const count = { file: path.basename(file), opens: 1, bytes: 0 };
      reads.push(count);
      descriptors.set(fd, count);
    }
    return fd;
  };
  traceReadSync((fd, bytes) => {
    const count = descriptors.get(fd);
    if (count !== undefined) {
      count.bytes += bytes;
    }
  });
  /** @param {number} fd */
  const tracedClose = (fd) => {
    descriptors.delete(fd);
    original.close(fd);
  };
  traceReaddirSync((directory) => {
    if (typeof directory === "string" && directory.endsWith("/commands")) {
      // pending() and admission finish synchronously before this microtask runs.
      queueMicrotask(() => {
        fs.appendFileSync(
          path.join(root, "command-polls.jsonl"),
          JSON.stringify({ pid: process.pid, reads }) + "\n",
        );
        reads = [];
      });
    }
  });
  fs.openSync = tracedOpen;
  fs.closeSync = tracedClose;
  syncBuiltinESMExports();
}

// Observe the byte ranges the actual actor reads from its native child journal.
function journalIO(/** @type {string} */ root) {
  const original = { open: fs.openSync, close: fs.closeSync };
  /** @type {Map<number, string>} */
  const journals = new Map();
  /** @type {typeof fs.openSync} */
  const tracedOpen = (file, flags, mode) => {
    const fd = original.open(file, flags, mode);
    if (typeof file === "string" && file.includes("/agent-runs/") && file.endsWith(".jsonl")) {
      journals.set(fd, file);
    }
    return fd;
  };
  traceReadSync((fd, count, position) => {
    const file = journals.get(fd);
    if (file !== undefined) {
      fs.appendFileSync(
        path.join(root, "journal-reads.jsonl"),
        JSON.stringify({ pid: process.pid, file, position: position ?? null, count }) + "\n",
      );
    }
  });
  /** @param {number} fd */
  const tracedClose = (fd) => {
    journals.delete(fd);
    original.close(fd);
  };
  fs.openSync = tracedOpen;
  fs.closeSync = tracedClose;
  syncBuiltinESMExports();
}

function shellIO(/** @type {string} */ root) {
  const open = fs.openSync;
  /** @type {{ opens: string[], scans: number } | undefined} */ let pending;
  const observe = () => {
    if (!pending) {
      pending = { opens: [], scans: 0 };
      queueMicrotask(() => {
        fs.appendFileSync(path.join(root, "shell-polls.jsonl"), JSON.stringify(pending) + "\n");
        pending = undefined;
      });
    }
    return pending;
  };
  /** @type {typeof fs.openSync} */
  const tracedOpen = (file, flags, mode) => {
    const fd = open(file, flags, mode);
    if (typeof file === "string" && file.includes("/shells/") && flags === "r") {
      observe().opens.push(path.basename(file));
    }
    return fd;
  };
  traceReaddirSync((directory) => {
    if (typeof directory === "string" && directory.includes("/shells/")) {
      observe().scans++;
    }
  });
  fs.openSync = tracedOpen;
  syncBuiltinESMExports();
}

export default async function fixture(
  /** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ pi,
) {
  const packageDir = process.env.PI_PACKAGE_DIR;
  if (packageDir === undefined) {
    throw new Error("PI_PACKAGE_DIR is required");
  }
  const { fauxProvider, fauxAssistantMessage } = await loadNativeAI(packageDir);
  const root = process.env.SINGLE_AGENT_TEST_ROOT;
  if (root === undefined) {
    throw new Error("SINGLE_AGENT_TEST_ROOT is required");
  }
  if (process.env.SINGLE_AGENT_COMMAND_IO === "1") {
    commandIO(root);
  }
  if (process.env.SINGLE_AGENT_JOURNAL_IO === "1") {
    journalIO(root);
  }
  if (
    process.env.SINGLE_AGENT_PARK_CLOCK === "park-shells" &&
    /runner\.[jt]s$/.test(process.argv[1] ?? "")
  ) {
    shellIO(root);
  }
  const parkClock = process.env.SINGLE_AGENT_PARK_CLOCK;
  if (
    parkClock !== undefined &&
    parkClock.startsWith("park") &&
    /runner\.[jt]s$/.test(process.argv[1] ?? "")
  ) {
    /**
     * The fork's working-session save participation event; official Pi types do not
     * export it yet, so the handler below is registered through a narrowed on().
     * @typedef {object} OfficialHostSaveShape
     * @property {AbortSignal} signal
     * @property {unknown} boundary
     * @property {(message: string) => void} invalidate
     * @property {(name: string, details: unknown) => void} appendEntry
     */
    /** @typedef {Extract<import("@earendil-works/pi-coding-agent").ExtensionEvent, { type: "working_session_save" }>} NativeSaveEvent */
    /** @typedef {[NativeSaveEvent] extends [never] ? OfficialHostSaveShape : NativeSaveEvent} ParkSaveEvent */
    const onParkSave =
      /** @type {(name: "working_session_save", handler: (event: ParkSaveEvent) => Promise<void> | void) => void} */ (
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-006: the selected fork implements this native save participation event.
        /** @type {unknown} */ (pi.on.bind(pi))
      );
    // Parking scenarios accelerate the runner's clock; park-shells pins exact idle boundaries.
    const now = performance.now.bind(performance);
    const advanced = path.join(root, "advance-clock");
    /** @type {number | undefined} */ let from;
    /** @type {number | undefined} */ let pinned;
    // A real save participant appends during preparation, changing the leaf being captured.
    let saves = 0;
    onParkSave("working_session_save", async (event) => {
      saves += 1;
      if (saves === 1 && /^park-(orphan|command)$/.test(parkClock)) {
        // The first save blocks until the test releases it or the acquisition is cancelled.
        fs.writeFileSync(path.join(root, "save-held"), "");
        while (!event.signal.aborted && !fs.existsSync(path.join(root, "release-save"))) {
          await delay(20);
        }
        return;
      }
      if (saves > 1 && parkClock === "park-failed") {
        // Fail only the final capture, after the actor committed to exit.
        event.invalidate("fixture final capture refused");
      }
      // Real saved states span many native 64 KiB read chunks.
      event.appendEntry("park-fixture-save", {
        boundary: event.boundary,
        padding: "x".repeat(96 * 1024),
      });
    });
    performance.now = () => {
      if (parkClock === "park-shells" && fs.existsSync(advanced)) {
        from ??= now();
        const elapsed = fs.readFileSync(advanced, "utf8");
        if (elapsed !== "") {
          // Integer origins keep pinned idle intervals exact across floating-point boundaries.
          pinned ??= Math.ceil(from + (now() - from) * 1000);
          queueMicrotask(() => {
            fs.writeFileSync(path.join(root, "clock-advanced"), elapsed);
          });
          return pinned + Number(elapsed);
        }
      }
      from ??= fs.existsSync(advanced) ? now() : undefined;
      if (from !== undefined && now() - from > 1200) {
        // The runner itself has now read a clock 20 accelerated minutes past the request.
        fs.writeFileSync(path.join(root, "clock-advanced"), "");
      }
      return from === undefined ? now() : from + (now() - from) * 1000;
    };
  }
  if (process.env.SINGLE_AGENT_DROP_HINTS === "1") {
    const watch = fs.watch;
    mock.method(
      fs,
      "watch",
      (
        /** @type {import("node:fs").PathLike} */ target,
        /** @type {import("node:fs").WatchOptions | BufferEncoding | "buffer" | null | undefined} */ options,
      ) => {
        fs.appendFileSync(path.join(root, "lost-hint-watches.jsonl"), `${process.pid}\n`);
        if (options === undefined) {
          return watch(target);
        }
        return watch(target, options, () => {
          // Intentionally drop native change hints; the actor must recover by polling.
        });
      },
    );
    syncBuiltinESMExports();
  }
  pi.on("session_start", (_event, ctx) => {
    fs.appendFileSync(
      path.join(root, "native-actor-starts.jsonl"),
      JSON.stringify({
        pid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(),
      }) + "\n",
    );
  });
  const provider = fauxProvider({
    provider: "single-agent-fixture",
    models: [
      { id: "literal-model", reasoning: true },
      { id: "literal-model:high", reasoning: true },
      { id: "literal-model:exacto", reasoning: true },
      { id: "nested/model", reasoning: true },
    ],
  });
  const publishRequest = async (
    /** @type {{ prompt?: string | undefined } & Record<string, unknown>} */ request,
    /** @type {AbortSignal | undefined} */ signal,
  ) => {
    const body = JSON.stringify(request);
    if (request.prompt === "HOLD:second") {
      const split = Math.floor(body.length / 2);
      /** @type {[string, string][]} */
      const stages = [
        ["prefix", body.slice(0, split)],
        ["body", body.slice(split)],
      ];
      for (const [stage, chunk] of stages) {
        fs.appendFileSync(path.join(root, "requests.jsonl"), chunk);
        fs.writeFileSync(path.join(root, `request-${stage}`), "written");
        while (!fs.existsSync(path.join(root, `release-request-${stage}`))) {
          if (signal?.aborted === true) {
            return;
          }
          // Hold actual request bytes on disk until the parent observes this publication stage.
          await delay(15);
        }
      }
      fs.appendFileSync(path.join(root, "requests.jsonl"), "\n");
    } else {
      fs.appendFileSync(path.join(root, "requests.jsonl"), body + "\n");
    }
  };
  const respond = async (
    /** @type {import("@earendil-works/pi-ai").TranscriptContext} */ context,
    /** @type {import("@earendil-works/pi-ai").SimpleStreamOptions | undefined} */ options,
    /** @type {import("@earendil-works/pi-ai").FauxProviderState} */ state,
    /** @type {import("@earendil-works/pi-ai").Model<string>} */ model,
  ) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const prompt =
      typeof user?.content === "string"
        ? user.content
        : user?.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    await publishRequest(
      {
        pid: process.pid,
        cwd: process.cwd(),
        sessionId: process.env.PI_SESSION_ID,
        root: process.env.PI_INTERCOM_ROOT_SESSION_ID,
        parent: process.env.PI_INTERCOM_PARENT_SESSION_ID,
        prompt,
        context: context.messages,
        thinking: options?.reasoning,
        nativeThinking: pi.getThinkingLevel(),
        model: model.id,
      },
      options?.signal,
    );
    const hold = /^HOLD:([a-z]+)/.exec(prompt ?? "");
    if (prompt === "DELAYED_LF_LITERAL") {
      const append = fs.appendFileSync;
      /** @param {Parameters<typeof fs.appendFileSync>} args */
      const delayedAppend = (...args) => {
        if (
          typeof args[1] === "string" &&
          args[1].includes("CHILD_LITERAL_RESULT:DELAYED_LF_LITERAL")
        ) {
          append(args[0], args[1].slice(0, -1), args[2]);
          fs.appendFileSync = append;
          syncBuiltinESMExports();
          fs.writeFileSync(path.join(root, "delayed-lf.json"), JSON.stringify({ file: args[0] }));
          return;
        }
        append(...args);
      };
      fs.appendFileSync = delayedAppend;
      syncBuiltinESMExports();
    }
    if (hold) {
      while (!fs.existsSync(path.join(root, `release-${hold[1] ?? ""}`))) {
        if (options?.signal?.aborted === true) {
          return fauxAssistantMessage("PARTIAL_BEFORE_ABORT", { stopReason: "aborted" });
        }
        // The test releases only after observing a real provider request.
        await delay(15);
      }
    }
    return answer(context, prompt);
  };
  const cwdAnswer = (
    /** @type {import("@earendil-works/pi-ai").TranscriptContext} */ context,
    /** @type {string} */ prompt,
  ) => {
    const results = context.messages
      .filter((message) => message.role === "toolResult")
      .filter((message) => message.toolCallId.startsWith(prompt));
    if (results.length === 0) {
      return fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: `${prompt}-first`,
            name: prompt === "CWD_CHANGE_AND_READ" ? "change_dir" : "read",
            arguments:
              prompt === "CWD_CHANGE_AND_READ"
                ? { path: path.join(root, "changed") }
                : { path: "marker.txt" },
          },
        ],
        { stopReason: "toolUse" },
      );
    }
    if (prompt !== "CWD_READ_FIRST" && !results.some((m) => m.toolName === "bash")) {
      return fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: `${prompt}-bash`,
            name: "bash",
            arguments: { command: "pwd; cat marker.txt" },
          },
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(JSON.stringify(results));
  };
  const usageAnswer = (
    /** @type {import("@earendil-works/pi-ai").TranscriptContext} */ context,
  ) => {
    const steps = context.messages.filter(
      (message) => message.role === "toolResult" && message.toolCallId.startsWith("usage-step-"),
    ).length;
    return steps < 34
      ? fauxAssistantMessage(
          [
            {
              type: "toolCall",
              id: `usage-step-${steps}`,
              name: "read",
              arguments: { path: "AGENTS.md" },
            },
          ],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage("CHILD_LITERAL_RESULT:USAGE_LITERAL");
  };
  const customBashAnswer = (
    /** @type {import("@earendil-works/pi-ai").TranscriptContext} */ context,
  ) => {
    const result = context.messages.findLast(
      (m) => m.role === "toolResult" && m.toolName === "bash",
    );
    return fauxAssistantMessage(
      result
        ? JSON.stringify(result)
        : [
            {
              type: "toolCall",
              id: "custom-bash",
              name: "bash",
              arguments: { command: "CUSTOM_UNTOUCHED_COMMAND" },
            },
          ],
      result ? {} : { stopReason: "toolUse" },
    );
  };
  const answer = (
    /** @type {import("@earendil-works/pi-ai").TranscriptContext} */ context,
    /** @type {string | undefined} */ prompt,
  ) => {
    if (prompt !== undefined && prompt.startsWith("CWD_")) {
      return cwdAnswer(context, prompt);
    }
    if (prompt === "CUSTOM_BASH_LITERAL") {
      return customBashAnswer(context);
    }
    if (
      prompt === "BASH_HOLD_LITERAL" &&
      !context.messages.some(
        (message) => message.role === "toolResult" && message.toolName === "bash",
      )
    ) {
      return fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "owned-native-shell",
            name: "bash",
            arguments: {
              command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "ticker.mjs"))}`,
            },
          },
        ],
        { stopReason: "toolUse" },
      );
    }
    if (prompt === "USAGE_LITERAL") {
      return usageAnswer(context);
    }
    if (prompt === "FAIL_LITERAL") {
      return fauxAssistantMessage("ERROR_PARTIAL_LITERAL", {
        stopReason: "error",
        errorMessage: "CONTROLLED_MODEL_FAILURE",
      });
    }
    if (prompt === "LONG_LITERAL") {
      return fauxAssistantMessage("😀雪".repeat(20000) + "END_LITERAL");
    }
    if (
      prompt === "NESTED_LITERAL" &&
      !context.messages.some(
        (message) => message.role === "toolResult" && message.toolName === "nested_probe",
      )
    ) {
      return fauxAssistantMessage(
        [{ type: "toolCall", name: "nested_probe", id: "nested-probe", arguments: {} }],
        { stopReason: "toolUse" },
      );
    }
    if (prompt === "RECALL_LITERAL") {
      const found = context.messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "delegate" &&
          JSON.stringify(message.content).includes("CALIBRATION_7391"),
      );
      return fauxAssistantMessage(found ? "RECALLED_CALIBRATION_7391" : "CALIBRATION_MISSING");
    }
    return fauxAssistantMessage(`CHILD_LITERAL_RESULT:${prompt ?? ""}`);
  };
  const inheritedProvider = fauxProvider({
    provider: "single-agent-parent",
    models: [{ id: "parent-model", reasoning: true }],
  });
  for (const selected of [provider, inheritedProvider]) {
    selected.setResponses(Array.from({ length: 100 }, () => respond));
    pi.registerProvider(selected.provider);
  }
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") {
      return;
    }
    return {
      message: {
        ...event.message,
        usage: {
          input: 3,
          output: 5,
          cacheRead: 13,
          cacheWrite: 1,
          totalTokens: 22,
          reasoning: 2,
          cacheWrite1h: 1,
          cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
        },
      },
    };
  });
  pi.registerTool({
    name: "nested_probe",
    label: "Nested probe",
    description: "Exercise the actual nested native tool boundary",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_id, _args, _signal, _onUpdate, toolContext) => {
      const result = await toolContext.executeTool("delegate", {
        prompt: "UNAUTHORIZED_NESTED_CHILD",
      });
      fs.writeFileSync(path.join(root, "nested-result.json"), JSON.stringify(result));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  });
}
