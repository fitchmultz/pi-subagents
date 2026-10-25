// Credential-free CLI double: real detached launcher, runner, child, and broker processes.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(import.meta.url);
const evidence = process.env.SMOKE_CLEANUP_EVIDENCE;
const scenario = process.env.SMOKE_CLEANUP_SCENARIO;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const root = dirname(agentDir);
const runId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const asyncDir = join(agentDir, "sessions", "agent-runs", sessionId, runId);
const sessions = join(root, "sessions");
const sessionFile = join(sessions, "parent.jsonl");
const args = process.argv.slice(2);
const role = args[0];
const record = (event, extra = {}) =>
  appendFileSync(
    join(evidence, "events.jsonl"),
    `${JSON.stringify({ event, role, pid: process.pid, time: Date.now(), ...extra })}\n`,
  );
const resourcesPresent = () => ({
  auth: existsSync(join(agentDir, "auth.json")),
  models: existsSync(join(agentDir, "models.json")),
  artifacts: existsSync(asyncDir),
});
const launch = (kind, detached = true) =>
  spawn(process.execPath, [fixture, kind], { detached, stdio: "ignore", env: process.env });
const save = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  // Readers use existence as readiness; publish only a complete JSON record.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
};

function scenarioState() {
  if (scenario === "success") {
    return "completed";
  }
  return scenario === "async-failure" ? "failed" : "running";
}
function promptKind(prompt) {
  const markers = [
    ["intercom tool", "intercom"],
    ["action list", "list"],
    ["CALIBRATION_FACT", "fork"],
  ];
  return markers.find(([marker]) => prompt.includes(marker))?.[1] ?? "delegate";
}
if (["launcher", "runner", "child", "broker"].includes(role)) {
  record("started");
  process.on("SIGTERM", () => {
    record("stopping", resourcesPresent());
    if (role !== "child") {
      setTimeout(() => process.exit(0), 150);
    }
  });
  process.on("exit", () => record("exiting", resourcesPresent()));
  if (role === "launcher") {
    const runner = launch("runner", false);
    runner.on("exit", () => process.exit(0));
  } else if (role === "runner") {
    mkdirSync(asyncDir, { recursive: true });
    launch("child");
    save(join(asyncDir, "actor.lock", "process.json"), { pid: process.pid });
    while (!existsSync(join(evidence, "child-ready"))) {
      // Child/broker readiness is published before the parent may emit its wire result.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    const state = scenarioState();
    writeFileSync(join(asyncDir, "output.txt"), "real-pi-smoke delegate ok\n");
    if (state !== "running") {
      save(join(asyncDir, "result.json"), { id: runId, status: state });
    }
    writeFileSync(join(evidence, "runner-ready"), "ready");
    if (scenario === "success") {
      await delay(1200); // Terminal status is published before the runner's final artifact write.
      record("finalizing", resourcesPresent());
      writeFileSync(join(asyncDir, "final-result.json"), "{}\n");
      process.exit(0);
    }
  } else if (role === "child") {
    // Beyond the 5-second command deadline and 3-second SIGKILL escalation.
    const writeDelayMs = 10_000;
    const writeAt = Date.now() + writeDelayMs;
    save(join(evidence, "child-ready"), { writeAt });
    if (scenario === "success") {
      setTimeout(() => process.exit(0), 200);
    } else {
      setTimeout(() => {
        record("delayed-write", resourcesPresent());
        writeFileSync(
          join(evidence, "delayed-child-write"),
          "orphan wrote after the smoke ended\n",
        );
      }, writeDelayMs);
    }
  } else {
    const { brokerPidRecord } = await import("../../src/pi-intercom/broker/pid.ts");
    if (!scenario.startsWith("startup-")) {
      mkdirSync(process.env.PI_INTERCOM_RUNTIME_DIR, { recursive: true });
      writeFileSync(join(process.env.PI_INTERCOM_RUNTIME_DIR, "broker.pid"), brokerPidRecord());
    }
    // Startup cases stay detached without publishing broker.pid for the whole cleanup,
    // rather than racing a second timer against the controller's command deadline.
    save(join(evidence, "broker-ready"), { pid: process.pid });
  }
  setInterval(() => {
    // Keep the controlled process alive so smoke cleanup must signal and reap it.
  }, 1000);
} else if (role === "install") {
  save(join(evidence, "install.json"), { repo: args[1], root });
} else if (role === "list") {
  console.log(JSON.parse(readFileSync(join(evidence, "install.json"), "utf8")).repo);
} else if (role === "--version") {
  console.log("credential-free-fixture");
} else {
  // RPC transport double: answers get_commands, or keeps one prompted main open until stdin closes.
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const fact = "CALIBRATION_FACT=packed-otter-7319";
  const toolEvents = (toolName, details) => [
    { type: "tool_execution_start", toolName },
    { type: "tool_execution_end", toolName, isError: false, result: { details } },
  ];
  const notice = (id, status, text) => ({
    type: "message_end",
    message: {
      role: "custom",
      customType: "agent-completion",
      details: { id, result: { status }, page: { text } },
    },
  });
  const reply = (text) => {
    const message = {
      role: "assistant",
      provider: "fixture",
      model: "smoke",
      stopReason: "stop",
      content: [{ type: "text", text }],
    };
    appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message })}\n`);
    return { type: "message_end", message };
  };
  const forkRun = (id, extra) => ({
    id: `00000000-0000-4000-8000-00000000000${id}`,
    sessionFile: join(sessions, "fact.jsonl"),
    ...extra,
  });
  const startOwned = async (kind) => {
    if (kind === "intercom") {
      launch("broker").unref();
      while (!existsSync(join(evidence, "broker-ready"))) {
        // Child/broker readiness is published before the parent may emit its wire result.
        // oxlint-disable-next-line no-await-in-loop
        await delay(10);
      }
    }
    if (
      kind === "delegate" ||
      (kind === "intercom" && !["success", "async-failure", "async-timeout"].includes(scenario))
    ) {
      const launcher = launch("launcher");
      launcher.unref();
      while (!existsSync(join(evidence, "runner-ready"))) {
        // Child/broker readiness is published before the parent may emit its wire result.
        // oxlint-disable-next-line no-await-in-loop
        await delay(10);
      }
      save(join(evidence, "parent-ready"), {
        ...resourcesPresent(),
        brokerPublished: existsSync(join(process.env.PI_INTERCOM_RUNTIME_DIR, "broker.pid")),
      });
      if (scenario === "startup-failure") {
        await delay(600);
      } // Parent's broker startup wait fails before PID publication.
      if (scenario === "failure" || scenario === "startup-failure") {
        process.exit(19);
      }
      if (["timeout", "startup-timeout", "SIGINT", "SIGTERM"].includes(scenario)) {
        await new Promise(() => {
          // Deliberately never settle: the smoke controller must cancel or time out this parent.
        });
      }
    }
  };
  const prompted = async (command) => {
    const kind = promptKind(command.message);
    record("prompt", { kind });
    mkdirSync(sessions, { recursive: true });
    if (!existsSync(sessionFile)) {
      appendFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
    }
    await startOwned(kind);
    emit({ id: command.id, type: "response", command: "prompt", success: true });
    if (kind === "intercom" || kind === "list") {
      const toolName = kind === "list" ? "agent_runs" : "intercom";
      for (const event of [...toolEvents(toolName, {}), reply(`real-pi-smoke ${kind} ok`)]) {
        emit(event);
      }
    } else if (kind === "delegate") {
      const details = { id: runId, name: "smoke-delegate", receipt: "launch" };
      for (const event of [
        ...toolEvents("delegate", { ...details, sessionFile: join(asyncDir, "child.jsonl") }),
        { type: "agent_settled" },
      ]) {
        emit(event);
      }
      const result = join(asyncDir, "result.json");
      while (!existsSync(result)) {
        // The double reports completion only after its detached runner publishes a result.
        // oxlint-disable-next-line no-await-in-loop
        await delay(10);
      }
      const { status } = JSON.parse(readFileSync(result, "utf8"));
      emit(notice(runId, status, readFileSync(join(asyncDir, "output.txt"), "utf8")));
      emit(reply("real-pi-smoke delegate ok"));
    } else {
      const [first, forked, continued] = [
        forkRun(3, { receipt: "launch", context: "fresh" }),
        forkRun(4, { receipt: "launch", context: "fork" }),
        forkRun(5, { receipt: "continuation", context: "fresh", predecessor: forkRun(3).id }),
      ];
      for (const event of [
        ...toolEvents("delegate", first),
        notice(first.id, "completed", fact),
        ...toolEvents("delegate", forked),
        ...toolEvents("agent_runs", continued),
        notice(forked.id, "completed", fact),
        notice(continued.id, "completed", fact),
        reply("real-pi-smoke fork ok"),
      ]) {
        emit(event);
      }
    }
    emit({ type: "agent_settled" });
  };
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    for (let end = input.indexOf("\n"); end >= 0; end = input.indexOf("\n")) {
      const command = JSON.parse(input.slice(0, end));
      input = input.slice(end + 1);
      if (command.type === "get_commands") {
        writeFileSync(
          join(root, "resources.json"),
          JSON.stringify(["delegate", "agent_runs", "intercom"]),
        );
        emit({
          type: "response",
          id: command.id,
          success: true,
          data: {
            commands: ["skill:pi-intercom", "skill:pi-subagents"].map((name) => ({ name })),
          },
        });
      } else {
        void prompted(command);
      }
    }
  });
}
