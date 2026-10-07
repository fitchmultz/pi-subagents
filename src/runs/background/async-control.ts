import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { readStatus } from "../../shared/utils.ts";
import { readQuestionContract, readRunJson } from "../shared/supervisor-questions.ts";
import { checkPidLiveness } from "./stale-run-reconciler.ts";
import { isDurableRun } from "./async-result-file.ts";
import {
  readChildProcessIdentity,
  trySignalChildTree,
} from "../../shared/post-exit-stdio-guard.ts";
import { errorCode, isRecord } from "./async-value.ts";
import type { AsyncStatus, ReadonlyInput } from "../../shared/types.ts";

interface AsyncControlRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly action: "interrupt" | "cancel" | "extend";
  readonly index?: number;
  readonly extendMs?: number;
}

interface ControlOptions {
  readonly index?: number;
  readonly extendMs?: number;
}

function validExtension(options: ControlOptions): boolean {
  return (
    typeof options.extendMs === "number" &&
    Number.isSafeInteger(options.extendMs) &&
    options.extendMs > 0 &&
    options.index === undefined
  );
}

export function writeAsyncControlRequest(
  asyncDir: string,
  runId: string,
  action: AsyncControlRequest["action"],
  options: ControlOptions = {},
): void {
  if (action === "extend" && !validExtension(options)) {
    throw new Error("extendMs must be a positive integer.");
  }
  const requestId = randomUUID();
  const separateFiles =
    readStatus(asyncDir)?.controlRequestFiles === true ||
    isDurableRun(readRunJson(path.join(asyncDir, "launch.json")));
  const file = separateFiles
    ? path.join(asyncDir, "control-requests", `${requestId}.json`)
    : path.join(asyncDir, "control-request.json");
  writeAtomicJson(file, { requestId, runId, action, ...options, createdAt: Date.now() });
}

function orphanedChild(
  runId: string,
  index: number,
): { readonly pid: number; readonly identity: string } | undefined {
  const contract = readQuestionContract(runId, index, undefined, { readConfiguration: false });
  const pid = contract?.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Cannot verify process ownership for child ${index}.`);
  }
  if (checkPidLiveness(pid) === "dead") {
    return undefined;
  }
  const identity = contract?.processIdentity;
  if (
    identity === undefined ||
    identity.length === 0 ||
    readChildProcessIdentity(pid) !== identity
  ) {
    throw new Error(`Cannot verify process ownership for child ${index}. No stop was sent.`);
  }
  return { pid, identity };
}

function stopOrphan(childIdentity: { readonly pid: number; readonly identity: string }): void {
  const { pid, identity } = childIdentity;
  const child = { pid, kill: (signal?: NodeJS.Signals | number) => process.kill(pid, signal) };
  if (!trySignalChildTree(child, "SIGTERM")) {
    throw new Error(`Could not signal orphaned child process ${pid}. Exit is unconfirmed.`);
  }
  // Match normal Stop escalation, including descendants surviving their group leader.
  setTimeout(() => {
    if (checkPidLiveness(pid) === "dead") {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process group may already have exited after SIGTERM.
      }
    } else if (readChildProcessIdentity(pid) === identity) {
      trySignalChildTree(child, "SIGKILL");
    }
  }, 3000).unref();
}

function deadRunner(status: ReadonlyInput<AsyncStatus> | null, runId: string): boolean {
  return (
    status?.runId === runId &&
    status.state === "running" &&
    status.pid !== undefined &&
    status.pid !== 0 &&
    checkPidLiveness(status.pid) === "dead"
  );
}

function validInterruptIndex(
  status: ReadonlyInput<AsyncStatus> | null,
  index: number | undefined,
): boolean {
  return (
    index === undefined ||
    (Number.isSafeInteger(index) && index >= 0 && status?.steps?.at(index)?.status === "running")
  );
}

export function writeAsyncInterruptRequest(asyncDir: string, runId: string, index?: number): void {
  const status = readStatus(asyncDir);
  if (!deadRunner(status, runId)) {
    writeAsyncControlRequest(asyncDir, runId, "interrupt", { index });
    return;
  }
  if (!validInterruptIndex(status, index)) {
    throw new Error(`No running child at index ${index ?? "unknown"}. No siblings were stopped.`);
  }
  // Validate every target before signaling any: stale PIDs must never stop unrelated work.
  const children = (status?.steps ?? []).flatMap((step, childIndex) => {
    if (step.status !== "running" || (index !== undefined && index !== childIndex)) {
      return [];
    }
    const child = orphanedChild(runId, childIndex);
    return child === undefined ? [] : [child];
  });
  children.forEach(stopOrphan);
}

function isControlIndex(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isControlAction(value: unknown): value is AsyncControlRequest["action"] {
  return value === "interrupt" || value === "cancel" || value === "extend";
}

function parseControlRequest(value: unknown, runId: string): AsyncControlRequest | undefined {
  if (
    !isRecord(value) ||
    value.runId !== runId ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0
  ) {
    return undefined;
  }
  const action = value.action;
  if (!isControlAction(action)) {
    return undefined;
  }
  const index = value.index;
  if (!isControlIndex(index)) {
    return undefined;
  }
  const extendMs = typeof value.extendMs === "number" ? value.extendMs : undefined;
  if (action === "extend" && !validExtension({ index, extendMs })) {
    return undefined;
  }
  return { requestId: value.requestId, runId, action, index, extendMs };
}

function claimRequest(file: string): string | undefined {
  const claimed = `${file}.${randomUUID()}.reading`;
  try {
    // Claim before reading, so a legacy writer's replacement remains for the next poll.
    fs.renameSync(file, claimed);
    return claimed;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      console.error(`Failed to claim async control request '${file}':`, error);
    }
    return undefined;
  }
}

export function readAsyncControlRequests(asyncDir: string, runId: string): AsyncControlRequest[] {
  const directory = path.join(asyncDir, "control-requests");
  const files = fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.join(directory, file))
    : [];
  files.push(path.join(asyncDir, "control-request.json"));
  const requests: AsyncControlRequest[] = [];
  for (const file of files) {
    const claimed = claimRequest(file);
    if (claimed === undefined) {
      continue;
    }
    try {
      if (fs.statSync(claimed).size > 64 * 1024) {
        throw new Error("control request exceeds 64 KiB");
      }
      const value: unknown = JSON.parse(fs.readFileSync(claimed, "utf-8"));
      const request = parseControlRequest(value, runId);
      if (request) {
        requests.push(request);
      }
    } catch (error) {
      console.error(`Failed to read async control request '${file}':`, error);
    } finally {
      fs.rmSync(claimed, { force: true });
    }
  }
  return requests;
}
