import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl } from "../../shared/artifacts.ts";
import { saveRunStatus } from "../shared/supervisor-questions.ts";
import { parseSubagentRunConfig } from "./run-schemas.ts";
import type { SubagentRunConfig } from "./runner-contract.ts";
import { createRunnerStatus } from "./runner-initial-status.ts";
import { RunnerMonitor } from "./runner-monitor.ts";
import { RunnerLifecycle } from "./runner-lifecycle.ts";
import { RunnerWorkflow } from "./runner-workflow.ts";
import { completeRunner } from "./runner-completion.ts";

async function runSubagent(config: ReadonlyDeep<SubagentRunConfig>): Promise<void> {
  const startedAt = Date.now();
  const status = createRunnerStatus(config, startedAt);
  fs.mkdirSync(config.asyncDir, { recursive: true });
  writeAtomicJson(path.join(config.asyncDir, "status.json"), status);
  if (config.runtimeVersion !== 2) {
    saveRunStatus(config.id, status);
  }
  const monitor = new RunnerMonitor(config, status, startedAt);
  const lifecycle = new RunnerLifecycle(config, status, monitor);
  lifecycle.start(startedAt);
  appendJsonl(
    path.join(config.asyncDir, "events.jsonl"),
    JSON.stringify({
      type: "subagent.run.started",
      ts: startedAt,
      runId: config.id,
      mode: status.mode,
      cwd: config.cwd,
      pid: process.pid,
    }),
  );
  try {
    const evidence = await new RunnerWorkflow(config, monitor, lifecycle).run(startedAt);
    await completeRunner(config, evidence, monitor, lifecycle);
  } finally {
    lifecycle.dispose();
  }
}

function runnerError(error: unknown): void {
  console.error("Subagent runner error:", error);
  process.exit(1);
}

function launchConfig(text: string, file?: string): void {
  const value: unknown = JSON.parse(text);
  const config = parseSubagentRunConfig(value);
  if (file !== undefined && config.runtimeVersion !== 2) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* Legacy temporary configuration cleanup is best effort. */
    }
  }
  runSubagent(config).catch(runnerError);
}

const configArg = process.argv.at(2);
if (configArg !== undefined && configArg.length > 0) {
  try {
    launchConfig(fs.readFileSync(configArg, "utf-8"), configArg);
  } catch (error) {
    runnerError(error);
  }
} else {
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: unknown) => {
    if (typeof chunk === "string") {
      input += chunk;
    }
  });
  process.stdin.on("end", () => {
    try {
      launchConfig(input);
    } catch (error) {
      runnerError(error);
    }
  });
}
