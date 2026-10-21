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
    ["async true", "async"],
    ["CALIBRATION_FACT", "fork"],
  ];
  return markers.find(([marker]) => prompt.includes(marker))?.[1] ?? "foreground";
}
function promptTool(kind) {
  if (kind === "intercom") {
    return "intercom";
  }
  if (kind === "list") {
    return "agent_runs";
  }
  return "delegate";
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
    writeFileSync(join(asyncDir, "output.txt"), "real-pi-smoke async ok\n");
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
    const writeAt = Date.now() + 6000;
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
      }, 6000);
    }
  } else {
    const { brokerPidRecord } = await import("../../src/pi-intercom/broker/pid.ts");
    save(join(evidence, "broker-ready"), { pid: process.pid });
    if (scenario.startsWith("startup-")) {
      await delay(10000);
    } // Detached before publishing broker.pid, like slow module startup.
    mkdirSync(process.env.PI_INTERCOM_RUNTIME_DIR, { recursive: true });
    writeFileSync(join(process.env.PI_INTERCOM_RUNTIME_DIR, "broker.pid"), brokerPidRecord());
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
} else if (args.includes("rpc")) {
  writeFileSync(
    join(root, "resources.json"),
    JSON.stringify(["delegate", "agent_runs", "intercom"]),
  );
  console.log(
    JSON.stringify({
      type: "response",
      id: "commands",
      success: true,
      data: {
        commands: ["skill:pi-intercom", "skill:pi-subagents"].map((name) => ({ name })),
      },
    }),
  );
} else {
  const prompt = args.at(-1);
  const kind = promptKind(prompt);
  record("prompt", { kind });
  mkdirSync(sessions, { recursive: true });
  if (!existsSync(sessionFile)) {
    appendFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  }
  if (kind === "intercom") {
    launch("broker").unref();
    while (!existsSync(join(evidence, "broker-ready"))) {
      // Child/broker readiness is published before the parent may emit its wire result.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
  }
  if (
    kind === "async" ||
    (kind === "intercom" && !["success", "async-failure", "async-timeout"].includes(scenario))
  ) {
    const launcher = launch("launcher");
    launcher.unref();
    while (!existsSync(join(evidence, "runner-ready"))) {
      // Child/broker readiness is published before the parent may emit its wire result.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    save(join(evidence, "parent-ready"), resourcesPresent());
    if (scenario === "startup-failure") {
      await delay(600);
    } // Parent's broker startup wait fails before PID publication.
    if (scenario === "failure" || scenario === "startup-failure") {
      process.exit(19);
    }
    if (["timeout", "startup-timeout", "SIGINT", "SIGTERM"].includes(scenario)) {
      setInterval(() => {
        // Keep the controlled process alive so smoke cleanup must signal and reap it.
      }, 1000);
      await new Promise(() => {
        // Deliberately never settle: the smoke controller must cancel or time out this parent.
      });
    }
  }
  const text = `real-pi-smoke ${kind === "async" ? "async launched ok" : `${kind} ok`}`;
  const message = {
    role: "assistant",
    provider: "fixture",
    model: "smoke",
    content: [{ type: "text", text }],
  };
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message })}\n`);
  const toolName = promptTool(kind);
  const details =
    kind === "fork"
      ? {
          id: runId,
          status: "completed",
          context: "fresh",
          sessionFile,
          output: { text: "CALIBRATION_FACT=packed-otter-7319" },
        }
      : {
          id: runId,
          sessionFile: join(asyncDir, "child.jsonl"),
          receipt: "launch",
          status: "completed",
          output: { text: "real-pi-smoke foreground ok" },
        };
  for (const event of [
    { type: "tool_execution_start", toolName },
    {
      type: "tool_execution_end",
      toolName,
      isError: false,
      result: {
        details,
      },
    },
    ...(kind === "fork"
      ? [
          {
            type: "tool_execution_end",
            toolName: "delegate",
            isError: false,
            result: { details: { ...details, context: "fork" } },
          },
          {
            type: "tool_execution_end",
            toolName: "agent_runs",
            isError: false,
            result: { details: { ...details, predecessor: runId } },
          },
        ]
      : []),
    { type: "message_end", message },
    { type: "agent_settled" },
  ]) {
    console.log(JSON.stringify(event));
  }
}
