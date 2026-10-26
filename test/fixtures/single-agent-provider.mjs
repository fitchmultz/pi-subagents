import fs from "node:fs";
import path from "node:path";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Observe the actual runner's synchronous command scans, not a replacement Actor.
function commandIO(root) {
  const original = {
    open: fs.openSync,
    read: fs.readSync,
    close: fs.closeSync,
    readdir: fs.readdirSync,
  };
  const descriptors = new Map();
  let reads = [];
  fs.openSync = (file, ...args) => {
    const fd = original.open(file, ...args);
    if (typeof file === "string" && file.endsWith("/attachment.json") && args[0] === "r") {
      // The actor's parent liveness check witnesses elapsed loop iterations.
      fs.appendFileSync(
        path.join(root, "actor-ticks.jsonl"),
        JSON.stringify({ pid: process.pid }) + "\n",
      );
    }
    if (typeof file === "string" && file.includes("/commands/") && args[0] === "r") {
      const count = { file: path.basename(file), opens: 1, bytes: 0 };
      reads.push(count);
      descriptors.set(fd, count);
    }
    return fd;
  };
  fs.readSync = (fd, ...args) => {
    const bytes = original.read(fd, ...args);
    const count = descriptors.get(fd);
    if (count) {
      count.bytes += bytes;
    }
    return bytes;
  };
  fs.closeSync = (fd) => {
    descriptors.delete(fd);
    return original.close(fd);
  };
  fs.readdirSync = (directory, ...args) => {
    const entries = original.readdir(directory, ...args);
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
    return entries;
  };
  syncBuiltinESMExports();
}

export default async function fixture(pi) {
  const sdkEntry = path.join(process.env.PI_PACKAGE_DIR, "dist/index.js");
  const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdkEntry)));
  const { fauxProvider, fauxAssistantMessage } = await import(
    pathToFileURL(path.join(aiRoot, "dist/index.js")).href
  );
  const root = process.env.SINGLE_AGENT_TEST_ROOT;
  if (process.env.SINGLE_AGENT_COMMAND_IO === "1") {
    commandIO(root);
  }
  if (
    process.env.SINGLE_AGENT_PARK_CLOCK?.startsWith("park") === true &&
    /runner\.[jt]s$/.test(process.argv[1] ?? "")
  ) {
    // Once the test asks, the actual runner's clock runs 1000x faster, so its idle period
    // elapses after whatever settling the runner still does.
    const now = performance.now.bind(performance);
    const advanced = path.join(root, "advance-clock");
    let from;
    // A real save participant appends during preparation, changing the leaf being captured.
    let saves = 0;
    pi.on("working_session_save", async (event) => {
      saves += 1;
      if (process.env.SINGLE_AGENT_PARK_CLOCK === "park-orphan") {
        // Persistence stays blocked until the native acquisition itself is cancelled.
        fs.writeFileSync(path.join(root, "save-held"), "");
        while (!event.signal.aborted) {
          // oxlint-disable-next-line no-await-in-loop
          await delay(20);
        }
        return;
      }
      if (saves > 1 && process.env.SINGLE_AGENT_PARK_CLOCK === "park-failed") {
        // Fail only the final capture, after the actor committed to exit.
        event.invalidate("fixture final capture refused");
      }
      event.appendEntry("park-fixture-save", { boundary: event.boundary });
    });
    performance.now = () => {
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
    fs.watch = (target, options) => {
      fs.appendFileSync(path.join(root, "lost-hint-watches.jsonl"), `${process.pid}\n`);
      return watch(target, options);
    };
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
  const respond = async (context, options, state, model) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const prompt =
      typeof user?.content === "string"
        ? user.content
        : user?.content?.map((block) => block.text ?? "").join("");
    fs.appendFileSync(
      path.join(root, "requests.jsonl"),
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        sessionId: process.env.PI_SESSION_ID,
        root: process.env.PI_INTERCOM_ROOT_SESSION_ID,
        parent: process.env.PI_INTERCOM_PARENT_SESSION_ID,
        prompt,
        context: context.messages,
        thinking: options?.reasoning,
        model: model.id,
      }) + "\n",
    );
    const hold = /^HOLD:([a-z]+)/.exec(prompt ?? "");
    if (prompt === "DELAYED_LF_LITERAL") {
      const append = fs.appendFileSync;
      fs.appendFileSync = (...args) => {
        if (
          typeof args[1] === "string" &&
          args[1].includes("CHILD_LITERAL_RESULT:DELAYED_LF_LITERAL")
        ) {
          append(args[0], args[1].slice(0, -1), ...args.slice(2));
          fs.appendFileSync = append;
          syncBuiltinESMExports();
          fs.writeFileSync(path.join(root, "delayed-lf.json"), JSON.stringify({ file: args[0] }));
          return;
        }
        append(...args);
      };
      syncBuiltinESMExports();
    }
    if (hold) {
      while (!fs.existsSync(path.join(root, `release-${hold[1]}`))) {
        if (options?.signal?.aborted) {
          return fauxAssistantMessage("PARTIAL_BEFORE_ABORT", { stopReason: "aborted" });
        }
        // The test releases only after observing a real provider request.
        // oxlint-disable-next-line no-await-in-loop
        await delay(15);
      }
    }
    return answer(context, prompt);
  };
  const cwdAnswer = (context, prompt) => {
    const results = context.messages.filter(
      (m) => m.role === "toolResult" && m.toolCallId?.startsWith(prompt),
    );
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
  const usageAnswer = (context) => {
    const steps = context.messages.filter(
      (message) => message.role === "toolResult" && message.toolCallId?.startsWith("usage-step-"),
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
  const answer = (context, prompt) => {
    if (prompt?.startsWith("CWD_")) {
      return cwdAnswer(context, prompt);
    }
    if (prompt === "CUSTOM_BASH_LITERAL") {
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
    return fauxAssistantMessage(`CHILD_LITERAL_RESULT:${prompt}`);
  };
  provider.setResponses(Array.from({ length: 100 }, () => respond));
  pi.registerProvider(provider.provider);
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
    execute: async (...args) => {
      const result = await args[4].executeTool("delegate", { prompt: "UNAUTHORIZED_NESTED_CHILD" });
      fs.writeFileSync(path.join(root, "nested-result.json"), JSON.stringify(result));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  });
}
