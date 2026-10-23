// Live model smoke for scripts/real-pi-smoke.mjs: persistent native RPC mains, launch
// receipts, completion notifications, and saved child evidence. Credentials stay isolated.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { isChildTreeAlive } from "../src/shared/post-exit-stdio-guard.ts";
import { filesIn, processRef } from "./real-pi-processes.mjs";

const authAgentDir =
  process.env.PI_REAL_SMOKE_AUTH_AGENT_DIR ??
  (process.env.HOME ? join(process.env.HOME, ".pi", "agent") : undefined);

function copyLiveAuth(agentDir) {
  if (!authAgentDir || !existsSync(authAgentDir)) {
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
  if (process.env.PI_REAL_SMOKE_PROVIDER) {
    args.push("--provider", process.env.PI_REAL_SMOKE_PROVIDER);
  }
  if (process.env.PI_REAL_SMOKE_MODEL) {
    args.push(
      "--model",
      process.env.PI_REAL_SMOKE_MODEL,
      "--models",
      process.env.PI_REAL_SMOKE_MODEL,
    );
  }
  return args;
}

function addMessage(view, message, index) {
  if (message?.customType === "agent-completion") {
    view.notices.set(message.details?.id, { ...message.details, index });
  } else if (message?.role === "assistant") {
    const text = message.content.filter((part) => part.type === "text");
    view.replies.push({
      index,
      text: text.map((part) => part.text).join("\n"),
      stopReason: message.stopReason,
    });
  }
}

function sessionView(events) {
  const view = { events, receipts: [], notices: new Map(), replies: [] };
  for (const [index, event] of events.entries()) {
    const details = event.result?.details;
    if (event.type === "message_end") {
      addMessage(view, event.message, index);
    } else if (
      event.type === "tool_execution_end" &&
      ["launch", "continuation"].includes(details?.receipt)
    ) {
      view.receipts.push({ ...details, index, tool: event.toolName });
    }
  }
  return view;
}

// Persistent RPC main: launch/continuation receipts are not completion, so the main stays
// alive until every receipt's native completion notification has resumed and settled it.
function rpcSession(child, prompt) {
  const events = [];
  let buffer = "";
  let settle;
  const quiescent = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(record);
      if (record.type === "response" && record.id === "smoke" && record.success !== true) {
        settle.reject(new Error(`RPC prompt was rejected: ${record.error}`));
      }
      if (record.type === "agent_settled") {
        if (record.aborted) {
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
  child.stdin.write(`${JSON.stringify({ id: "smoke", type: "prompt", message: prompt })}\n`);
  return { events, quiescent, close: () => child.stdin.end() };
}

async function runLiveSession(options, { label, prompt, tool, verify }) {
  let session;
  let view;
  const args = ["--mode", "rpc", "--session-dir", join(options.root, "sessions"), "--approve"];
  const exited = options.processes.run(label, "pi", [...args, ...modelArgs()], (child) => {
    session = rpcSession(child, prompt);
  });
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
      (event) => event.type === "tool_execution_end" && event.isError,
    );
    if (errors.length) {
      throw new Error(
        `${label} had ${errors.length} failed tool call(s); inspect its saved wire log.`,
      );
    }
    // Verify while the main is alive; only then request its orderly shutdown.
    await verify(view);
  } finally {
    session?.close();
    writeFileSync(
      join(options.root, `${label.replace(/ /g, "-")}.jsonl`),
      session ? session.events.map((event) => JSON.stringify(event)).join("\n") : "",
    );
  }
  await exited;
  return view;
}

function* savedAssistantModels(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line);
    if (entry.type === "message" && entry.message?.role === "assistant") {
      yield `${entry.message.provider}/${entry.message.model}`;
    }
  }
}

function auditSavedModels(directories, expectedModel) {
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
  if (!responses) {
    throw new Error("No saved assistant messages found for model audit.");
  }
  if (expectedModel?.includes("/") && [...models].some((model) => model !== expectedModel)) {
    throw new Error(`Unexpected model in saved parent/child sessions: ${[...models].join(", ")}`);
  }
  console.log(
    `[real-pi-smoke] audited ${responses} saved parent/child responses: ${[...models].join(", ")}`,
  );
}

function requireOutput(label, output, pattern) {
  if (!pattern.test(output)) {
    throw new Error(`${label} did not include expected evidence ${pattern}.\nOutput:\n${output}`);
  }
  const compact = output.trim().split(/\r?\n/).slice(-8).join("\n");
  console.log(`[real-pi-smoke] ${label} output evidence:\n${compact}`);
}

function asyncCompletion(dir, runId) {
  const resultPath = join(dir, "result.json");
  if (!existsSync(resultPath)) {
    return { status: "missing" };
  }
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
  const actor = JSON.parse(readFileSync(processPath, "utf8"));
  return {
    status: result.status,
    output: isChildTreeAlive(processRef(actor.pid))
      ? undefined
      : readFileSync(join(dir, "output.txt"), "utf8"),
  };
}

async function waitForAsyncCompletion(run, pattern, { env, timeoutMs, signal }) {
  const dir = dirname(run.sessionFile);
  const within = relative(join(env.PI_CODING_AGENT_DIR, "sessions", "agent-runs"), dir);
  if (isAbsolute(within) || within.startsWith("..") || !/^[a-zA-Z0-9_-]{1,128}$/.test(run.id)) {
    throw new Error("Async receipt did not identify this smoke's private saved run");
  }
  const deadline = Date.now() + timeoutMs;
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

export async function runLiveSmoke(options, runOptions, agentDir) {
  const copiedAuthFiles = copyLiveAuth(agentDir);
  if (copiedAuthFiles.length > 0) {
    console.log(
      `[real-pi-smoke] copied ${copiedAuthFiles.join(" and ")} into isolated Pi agent dir for live provider auth`,
    );
  }
  const childModelInstruction = process.env.PI_REAL_SMOKE_MODEL
    ? ` Pass model '${process.env.PI_REAL_SMOKE_MODEL}' to every delegate call.`
    : "";
  await runBasicLiveSmoke(runOptions, childModelInstruction);
  if (options.llmFull) {
    await runFullLiveSmoke(runOptions, childModelInstruction);
  }
  auditSavedModels(
    [join(runOptions.root, "sessions"), join(agentDir, "sessions", "agent-runs")],
    process.env.PI_REAL_SMOKE_MODEL,
  );
}

function requireFinalReply(label, view, pattern) {
  const last = view.replies.at(-1);
  const notified = Math.max(-1, ...[...view.notices.values()].map(({ index }) => index));
  if (last === undefined || last.stopReason !== "stop" || last.index < notified) {
    throw new Error(
      `${label} did not finish a successful reply after its final completion notification.`,
    );
  }
  requireOutput(label, last.text, pattern);
}

function requireCompletion(view, receipt, expected) {
  const notice = view.notices.get(receipt.id);
  if (notice?.result?.status !== "completed" || notice.page?.text?.trim() !== expected) {
    throw new Error(`Run ${receipt.id} completion notification did not report: ${expected}`);
  }
}

async function runBasicLiveSmoke(runOptions, childModelInstruction) {
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
        receipt.receipt !== "launch" ||
        receipt.name !== "smoke-delegate" ||
        !receipt.id ||
        !receipt.sessionFile
      ) {
        throw new Error("Native delegate did not return one named saved launch receipt");
      }
      requireCompletion(view, receipt, expected);
      requireFinalReply(label, view, new RegExp(expected));
    },
  });
  // A completed actor keeps serving its attached main; closing that main must retire it.
  await waitForAsyncCompletion(receipts[0], new RegExp(`^${expected}$`, "m"), runOptions);
}

function requireForkTopology(view) {
  const kinds = view.receipts.map(({ tool, receipt, context }) => `${tool}:${receipt}:${context}`);
  const expected = [
    "agent_runs:continuation:fresh",
    "delegate:launch:fork",
    "delegate:launch:fresh",
  ];
  const [first] = view.receipts;
  const forked = view.receipts.find(({ context }) => context === "fork");
  const continued = view.receipts.find(({ tool }) => tool === "agent_runs");
  if (
    kinds.sort().join() !== expected.join() ||
    first?.context !== "fresh" ||
    !(forked.index > view.notices.get(first.id).index) ||
    continued.predecessor !== first.id ||
    continued.sessionFile !== first.sessionFile
  ) {
    throw new Error(
      "Fork/continuation smoke did not fork after the first completion and continue its saved conversation",
    );
  }
}

async function runFullLiveSmoke(runOptions, childModelInstruction) {
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
