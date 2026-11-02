// Live model smoke for scripts/real-pi-smoke.mjs: persistent native RPC mains, launch
// receipts, completion notifications, and saved child evidence. Credentials stay isolated.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { isChildTreeAlive } from "../src/shared/post-exit-stdio-guard.ts";
import { filesIn, processRef } from "./real-pi-processes.mjs";

/**
 * One JSON record decoded from the RPC main's stdout stream.
 * @typedef {Record<string, unknown> & { type?: string }} RpcEvent
 */
/**
 * A message record projected from a message_end event.
 * @typedef {object} StreamedMessage
 * @property {string | undefined} customType
 * @property {string | undefined} role
 * @property {{ type?: string, text?: string }[] | undefined} content
 * @property {string | undefined} stopReason
 * @property {SessionNotice | undefined} details
 */
/**
 * A completion notification saved from a custom agent-completion message.
 * @typedef {object} SessionNotice
 * @property {string | undefined} id
 * @property {number | undefined} index
 * @property {{ status?: string } | undefined} result
 * @property {{ text?: string } | undefined} page
 */
/**
 * A launch/continuation receipt projected from a tool_execution_end event.
 * @typedef {object} SessionReceipt
 * @property {string | undefined} tool
 * @property {string | undefined} receipt
 * @property {string | undefined} name
 * @property {string | undefined} id
 * @property {string | undefined} sessionFile
 * @property {string | undefined} context
 * @property {number | undefined} index
 * @property {string | undefined} predecessor
 */
/**
 * The verified view of one live RPC session.
 * @typedef {object} SessionView
 * @property {RpcEvent[]} events
 * @property {SessionReceipt[]} receipts
 * @property {Map<string | undefined, SessionNotice>} notices
 * @property {{ index: number, text: string, stopReason: string | undefined }[]} replies
 */
/**
 * The shared smoke runner options (built by scripts/real-pi-smoke.mjs).
 * @typedef {object} LiveSmokeOptions
 * @property {string} root
 * @property {boolean | undefined} [llmFull]
 * @property {{ PI_CODING_AGENT_DIR: string }} env
 * @property {number} timeoutMs
 * @property {AbortSignal} signal
 * @property {{ run: (label: string, command: string, args: string[], input: string | ((child: import("node:child_process").ChildProcess) => void)) => Promise<string> }} processes
 */

const authAgentDir =
  process.env.PI_REAL_SMOKE_AUTH_AGENT_DIR ??
  (process.env.HOME !== undefined ? join(process.env.HOME, ".pi", "agent") : undefined);

function copyLiveAuth(/** @type {string} */ agentDir) {
  if (authAgentDir === undefined || !existsSync(authAgentDir)) {
    return [];
  }
  mkdirSync(agentDir, { recursive: true });
  const copied = [];
  for (const filename of ["auth.json", "models.json"]) {
    const source = join(authAgentDir, filename);
    if (!existsSync(source)) {
      continue;
    }
    copyFileSync(source, join(agentDir, filename));
    copied.push(filename);
  }
  return copied;
}

function modelArgs() {
  const args = [];
  if (process.env.PI_REAL_SMOKE_PROVIDER !== undefined) {
    args.push("--provider", process.env.PI_REAL_SMOKE_PROVIDER);
  }
  if (process.env.PI_REAL_SMOKE_MODEL !== undefined) {
    args.push(
      "--model",
      process.env.PI_REAL_SMOKE_MODEL,
      "--models",
      process.env.PI_REAL_SMOKE_MODEL,
    );
  }
  return args;
}

function addMessage(
  /** @type {SessionView} */ view,
  /** @type {StreamedMessage | undefined} */ message,
  /** @type {number} */ index,
) {
  if (message?.customType === "agent-completion" && message.details !== undefined) {
    view.notices.set(message.details.id, { ...message.details, index });
  } else if (message?.role === "assistant") {
    const text = (message.content ?? []).filter((part) => part.type === "text");
    view.replies.push({
      index,
      text: text.map((part) => part.text).join("\n"),
      stopReason: message.stopReason,
    });
  }
}

function sessionView(/** @type {RpcEvent[]} */ events) {
  /** @type {SessionView} */
  const view = { events, receipts: [], notices: new Map(), replies: [] };
  for (const [index, event] of events.entries()) {
    // oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion -- RpcEvent carries unknown payloads
    const details = /** @type {SessionReceipt | undefined} */ (
      /** @type {{ details?: SessionReceipt } | undefined} */ (event.result)?.details
    );
    // oxlint-enable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion
    if (event.type === "message_end") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RpcEvent carries unknown payloads
      addMessage(view, /** @type {StreamedMessage} */ (event.message), index);
    } else if (
      event.type === "tool_execution_end" &&
      details !== undefined &&
      (details.receipt === "launch" || details.receipt === "continuation")
    ) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RpcEvent carries unknown payloads
      view.receipts.push({ ...details, index, tool: /** @type {string} */ (event.toolName) });
    }
  }
  return view;
}

// Persistent RPC main: launch/continuation receipts are not completion, so the main stays
// alive until every receipt's native completion notification has resumed and settled it.
function rpcSession(
  /** @type {import("node:child_process").ChildProcess} */ child,
  /** @type {string} */ prompt,
) {
  /** @type {RpcEvent[]} */ const events = [];
  let buffer = "";
  /** @type {{ promise: Promise<SessionView>, resolve: (view: SessionView) => void, reject: (error: Error) => void }} */
  const settle = Promise.withResolvers();
  const quiescent = settle.promise;
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (stdout === null || stdin === null) {
    throw new Error("RPC child is missing piped stdio streams");
  }
  stdout.on("data", (/** @type {Buffer | string} */ chunk) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      /** @type {RpcEvent} */ let record;
      try {
        // oxlint-disable-next-line typescript/no-unsafe-assignment
        record = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(record);
      if (record.type === "response" && record.id === "smoke" && record.success !== true) {
        settle.reject(new Error(`RPC prompt was rejected: ${JSON.stringify(record.error)}`));
      }
      if (record.type === "agent_settled") {
        if (record.aborted === true) {
          settle.reject(new Error("RPC main was aborted before the live smoke completed."));
          continue;
        }
        const view = sessionView(events);
        if (view.receipts.every(({ id }) => view.notices.has(id))) {
          settle.resolve(view);
        }
      }
    }
  });
  stdin.write(`${JSON.stringify({ id: "smoke", type: "prompt", message: prompt })}\n`);
  return { events, quiescent, close: () => stdin.end() };
}

async function runLiveSession(
  /** @type {LiveSmokeOptions} */ options,
  /** @type {{ label: string, prompt: string, tool: string, verify: (view: SessionView) => void | Promise<void> }} */
  { label, prompt, tool, verify },
) {
  /** @type {ReturnType<typeof rpcSession> | undefined} */ let session;
  /** @type {SessionView | undefined} */ let view;
  const args = ["--mode", "rpc", "--session-dir", join(options.root, "sessions"), "--approve"];
  const exited = options.processes.run(
    label,
    "pi",
    [...args, ...modelArgs()],
    (/** @type {import("node:child_process").ChildProcess} */ child) => {
      session = rpcSession(child, prompt);
    },
  );
  if (session === undefined) {
    throw new Error(`${label} RPC session never started`);
  }
  try {
    view = await Promise.race([
      session.quiescent,
      exited.then((output) => {
        throw new Error(`${label} main exited before settling every receipt:\n${output}`);
      }),
    ]);
    if (
      !view.events.some((event) => event.type === "tool_execution_start" && event.toolName === tool)
    ) {
      throw new Error(
        `${label} never invoked ${tool}; a matching final sentence is not execution evidence.`,
      );
    }
    const errors = view.events.filter(
      (event) => event.type === "tool_execution_end" && event.isError === true,
    );
    if (errors.length > 0) {
      throw new Error(
        `${label} had ${errors.length} failed tool call(s); inspect its saved wire log.`,
      );
    }
    // Verify while the main is alive; only then request its orderly shutdown.
    await verify(view);
  } finally {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the finally also runs when startup failed
    session?.close();
    writeFileSync(
      join(options.root, `${label.replace(/ /g, "-")}.jsonl`),
      // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- the finally also runs when startup failed
      session ? session.events.map((event) => JSON.stringify(event)).join("\n") : "",
    );
  }
  await exited;
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- flow analysis misses the race failure path
  if (view === undefined) {
    throw new Error(`${label} settled without a session view`);
  }
  return view;
}

function* savedAssistantModels(/** @type {string} */ file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    /** @type {{ type?: string, message?: { role?: string, provider?: string, model?: string } }} */
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const entry = JSON.parse(line);
    if (entry.type === "message" && entry.message?.role === "assistant") {
      yield `${entry.message.provider ?? ""}/${entry.message.model ?? ""}`;
    }
  }
}

function auditSavedModels(
  /** @type {string[]} */ directories,
  /** @type {string | undefined} */ expectedModel,
) {
  const models = new Set();
  let responses = 0;
  for (const file of directories.flatMap((dir) => [...filesIn(dir)])) {
    if (!file.endsWith(".jsonl")) {
      continue;
    }
    for (const model of savedAssistantModels(file)) {
      responses++;
      models.add(model);
    }
  }
  if (responses === 0) {
    throw new Error("No saved assistant messages found for model audit.");
  }
  if (
    expectedModel?.includes("/") === true &&
    [...models].some((model) => model !== expectedModel)
  ) {
    throw new Error(`Unexpected model in saved parent/child sessions: ${[...models].join(", ")}`);
  }
  console.log(
    `[real-pi-smoke] audited ${responses} saved parent/child responses: ${[...models].join(", ")}`,
  );
}

function requireOutput(
  /** @type {string} */ label,
  /** @type {string} */ output,
  /** @type {RegExp} */ pattern,
) {
  if (!pattern.test(output)) {
    throw new Error(
      `${label} did not include expected evidence ${pattern.toString()}.\nOutput:\n${output}`,
    );
  }
  const compact = output.trim().split(/\r?\n/).slice(-8).join("\n");
  console.log(`[real-pi-smoke] ${label} output evidence:\n${compact}`);
}

function asyncCompletion(/** @type {string} */ dir, /** @type {string} */ runId) {
  const resultPath = join(dir, "result.json");
  if (!existsSync(resultPath)) {
    return { status: "missing" };
  }
  /** @type {{ id: string, status: string, error?: string }} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.id !== runId) {
    throw new Error("Async completion belongs to another saved run");
  }
  if (result.status !== "completed") {
    throw new Error(`async run ${runId} ended ${result.status}: ${result.error ?? ""}`);
  }
  const processPath = join(dir, "actor.lock", "process.json");
  if (!existsSync(processPath)) {
    return { status: "completed; actor exit unconfirmed" };
  }
  /** @type {{ pid: number }} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const actor = JSON.parse(readFileSync(processPath, "utf8"));
  return {
    status: result.status,
    output: isChildTreeAlive(processRef(actor.pid))
      ? undefined
      : readFileSync(join(dir, "output.txt"), "utf8"),
  };
}

async function waitForAsyncCompletion(
  /** @type {SessionReceipt} */ run,
  /** @type {RegExp} */ pattern,
  /** @type {LiveSmokeOptions} */ { env, timeoutMs, signal },
) {
  if (run.sessionFile === undefined || run.id === undefined) {
    throw new Error("Async receipt did not identify this smoke's saved run");
  }
  const dir = dirname(run.sessionFile);
  const within = relative(join(env.PI_CODING_AGENT_DIR, "sessions", "agent-runs"), dir);
  if (isAbsolute(within) || within.startsWith("..") || !/^[a-zA-Z0-9_-]{1,128}$/.test(run.id)) {
    throw new Error("Async receipt did not identify this smoke's private saved run");
  }
  const deadline = Date.now() + timeoutMs;
  /** @type {string} */
  let lastState = "missing";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const completion = asyncCompletion(dir, run.id);
    lastState = completion.status;
    if (completion.output !== undefined) {
      requireOutput(`async run ${run.id} completed and actor exited`, completion.output, pattern);
      return;
    }
    // Result publication is not process exit; retain resources until final actor writes finish.
    // oxlint-disable-next-line no-await-in-loop
    await delay(100, undefined, { signal });
  }
  throw new Error(
    `async run ${run.id} did not complete and exit after ${timeoutMs}ms (last state: ${lastState}).`,
  );
}

export async function runLiveSmoke(
  /** @type {{ llmFull?: boolean }} */ options,
  /** @type {LiveSmokeOptions} */ runOptions,
  /** @type {string} */ agentDir,
) {
  const copiedAuthFiles = copyLiveAuth(agentDir);
  if (copiedAuthFiles.length > 0) {
    console.log(
      `[real-pi-smoke] copied ${copiedAuthFiles.join(" and ")} into isolated Pi agent dir for live provider auth`,
    );
  }
  const childModelInstruction =
    process.env.PI_REAL_SMOKE_MODEL !== undefined
      ? ` Pass model '${process.env.PI_REAL_SMOKE_MODEL}' to every delegate call.`
      : "";
  await runBasicLiveSmoke(runOptions, childModelInstruction);
  if (options.llmFull === true) {
    await runFullLiveSmoke(runOptions, childModelInstruction);
  }
  auditSavedModels(
    [join(runOptions.root, "sessions"), join(agentDir, "sessions", "agent-runs")],
    process.env.PI_REAL_SMOKE_MODEL,
  );
}

function requireFinalReply(
  /** @type {string} */ label,
  /** @type {SessionView} */ view,
  /** @type {RegExp} */ pattern,
) {
  const last = view.replies.at(-1);
  const notified = Math.max(-1, ...[...view.notices.values()].map(({ index }) => index ?? -1));
  if (last === undefined || last.stopReason !== "stop" || last.index < notified) {
    throw new Error(
      `${label} did not finish a successful reply after its final completion notification.`,
    );
  }
  requireOutput(label, last.text, pattern);
}

function requireCompletion(
  /** @type {SessionView} */ view,
  /** @type {SessionReceipt} */ receipt,
  /** @type {string} */ expected,
) {
  const notice = view.notices.get(receipt.id);
  if (notice?.result?.status !== "completed" || notice.page?.text?.trim() !== expected) {
    throw new Error(`Run ${receipt.id ?? ""} completion notification did not report: ${expected}`);
  }
}

async function runBasicLiveSmoke(
  /** @type {LiveSmokeOptions} */ runOptions,
  /** @type {string} */ childModelInstruction,
) {
  /** @type {[string, string, string][]} */
  const prompts = [
    [
      "intercom",
      "Call the intercom tool with action status. Reply exactly 'real-pi-smoke intercom ok' only if it reports 'Connected: Yes'.",
      "intercom",
    ],
    [
      "list",
      "Call agent_runs with action list. Reply exactly 'real-pi-smoke list ok' only if it successfully returns a saved-run list. There are no profiles to discover.",
      "agent_runs",
    ],
  ];
  for (const [kind, prompt, tool] of prompts) {
    const label = `real Pi ${kind} prompt`;
    // Keep separate native parent sessions so each smoke owns its saved runs.
    // oxlint-disable-next-line no-await-in-loop
    await runLiveSession(runOptions, {
      label,
      prompt,
      tool,
      verify: (view) => requireFinalReply(label, view, new RegExp(`real-pi-smoke ${kind} ok`)),
    });
  }
  const expected = "real-pi-smoke delegate ok";
  const label = "real Pi delegate prompt";
  const { receipts } = await runLiveSession(runOptions, {
    label,
    prompt: `Call delegate once with prompt 'Reply exactly: ${expected}' and name 'smoke-delegate'.${childModelInstruction} It returns only a launch receipt, not completion; never wait, poll, or call agent_runs. When that run's completion notification arrives, reply exactly '${expected}' only if it reports completed with that output.`,
    tool: "delegate",
    verify: (view) => {
      const [receipt] = view.receipts;
      if (
        view.receipts.length !== 1 ||
        !receipt ||
        receipt.receipt !== "launch" ||
        receipt.name !== "smoke-delegate" ||
        receipt.id === undefined ||
        receipt.sessionFile === undefined
      ) {
        throw new Error("Native delegate did not return one named saved launch receipt");
      }
      requireCompletion(view, receipt, expected);
      requireFinalReply(label, view, new RegExp(expected));
    },
  });
  // A completed actor keeps serving its attached main; closing that main must retire it.
  const [asyncReceipt] = receipts;
  if (asyncReceipt === undefined) {
    throw new Error("Native delegate did not return a saved launch receipt");
  }
  await waitForAsyncCompletion(asyncReceipt, new RegExp(`^${expected}$`, "m"), runOptions);
}

/**
 * @param {import("./real-pi-live.mjs").SessionReceipt | undefined} forked
 * @param {import("./real-pi-live.mjs").SessionNotice | undefined} firstNotice
 */
function forkedAfterFirstNotice(forked, firstNotice) {
  return (
    forked?.index !== undefined &&
    firstNotice?.index !== undefined &&
    forked.index > firstNotice.index
  );
}

/**
 * @param {SessionView} view
 * @param {string[]} kinds
 * @param {string[]} expected
 */
function topologyReceiptsComplete(view, kinds, expected) {
  const [first] = view.receipts;
  const forked = view.receipts.find(({ context }) => context === "fork");
  const continued = view.receipts.find(({ tool }) => tool === "agent_runs");
  const firstNotice = first?.id === undefined ? undefined : view.notices.get(first.id);
  return {
    first,
    forked,
    continued,
    complete:
      kinds.sort().join() === expected.join() &&
      first?.context === "fresh" &&
      firstNotice !== undefined &&
      forked !== undefined &&
      continued !== undefined,
  };
}

/**
 * @param {import("./real-pi-live.mjs").SessionReceipt} first
 * @param {import("./real-pi-live.mjs").SessionReceipt} continued
 * @param {import("./real-pi-live.mjs").SessionReceipt | undefined} forked
 * @param {import("./real-pi-live.mjs").SessionNotice | undefined} firstNotice
 */
function topologyLinksPreserved(first, continued, forked, firstNotice) {
  return (
    forkedAfterFirstNotice(forked, firstNotice) &&
    continued.predecessor === first.id &&
    continued.sessionFile === first.sessionFile
  );
}

function requireForkTopology(/** @type {SessionView} */ view) {
  const kinds = view.receipts.map(
    ({ tool, receipt, context }) => `${tool ?? ""}:${receipt ?? ""}:${context ?? ""}`,
  );
  const expected = [
    "agent_runs:continuation:fresh",
    "delegate:launch:fork",
    "delegate:launch:fresh",
  ];
  const { first, forked, continued, complete } = topologyReceiptsComplete(view, kinds, expected);
  const firstNotice = first?.id === undefined ? undefined : view.notices.get(first.id);
  if (
    !complete ||
    first === undefined ||
    continued === undefined ||
    !topologyLinksPreserved(first, continued, forked, firstNotice)
  ) {
    throw new Error(
      "Fork/continuation smoke did not fork after the first completion and continue its saved conversation",
    );
  }
}

async function runFullLiveSmoke(
  /** @type {LiveSmokeOptions} */ runOptions,
  /** @type {string} */ childModelInstruction,
) {
  const fact = "CALIBRATION_FACT=packed-otter-7319";
  const prompt = `First call delegate with prompt 'Reply exactly ${fact}', name 'fact', and context fresh.${childModelInstruction} Delegate and agent_runs return receipts only; never wait or poll, and end your turn after each receipt. When the fact run's completion notification arrives, call delegate with context fork and prompt 'Read the inherited conversation. Without tools, filesystem reads, or guessing, return the CALIBRATION_FACT line from the preceding agent completion notification exactly; return FACT_NOT_VISIBLE if absent.' and call agent_runs with action continue, the fact run id, and prompt 'Without tools, repeat the CALIBRATION_FACT line from your own saved conversation exactly.' After both of those runs' completion notifications arrive, reply exactly 'real-pi-smoke fork ok' only if both report completed with ${fact}. There are no profiles, task prefixes, output settings, or canned role instructions.`;
  const label = "real Pi fork prompt";
  await runLiveSession(runOptions, {
    label,
    prompt,
    tool: "delegate",
    verify: (view) => {
      requireForkTopology(view);
      for (const receipt of view.receipts) {
        requireCompletion(view, receipt, fact);
      }
      requireFinalReply(label, view, /real-pi-smoke fork ok/);
    },
  });
}
