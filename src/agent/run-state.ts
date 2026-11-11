import * as path from "node:path";
import {
  admissionSchema,
  resultSchema,
  successorSchema,
  waitingSchema,
  type Launch,
  type Result,
  type Waiting,
} from "./contracts.ts";
import { conversation, read, runDirectory } from "./storage.ts";

type Admission = "pending" | "admitted";
export type RunState =
  | { readonly kind: "saved-unadmitted" | "admitted" }
  | { readonly kind: "settled"; readonly result: Result };
/** What a run's status can say; `unavailable` is an unreadable inventory row, not a run. */
export type RunStatus = Result["status"] | "running" | "interrupted";

/** Admission and result publication are separate durable facts. */
export function runAdmission(base: string, launch: Launch): Admission {
  const admission = read(
    path.join(conversation(base, launch), "admissions", `${launch.id}.json`),
    admissionSchema,
  );
  return admission?.id === launch.id && admission.action === "run" ? "admitted" : "pending";
}

export function runState(result: Result | undefined, admission: Admission): RunState {
  return result === undefined
    ? { kind: admission === "admitted" ? "admitted" : "saved-unadmitted" }
    : { kind: "settled", result };
}

export function readRunState(base: string, launch: Launch): RunState {
  const result = read(path.join(runDirectory(base, launch.id), "result.json"), resultSchema);
  return result === undefined
    ? runState(result, runAdmission(base, launch))
    : { kind: "settled", result };
}

export function continuationDecision(
  state: RunState,
  live: boolean,
): "retry" | "guidance" | "successor" {
  switch (state.kind) {
    case "saved-unadmitted":
      return "retry";
    case "admitted":
      return live ? "guidance" : "successor";
    case "settled":
      return "successor";
  }
}

/** A settled result owns the status. Otherwise only a live run without a successor is running. */
export function runStatusOf(
  result: Result | undefined,
  live: boolean,
  superseded: boolean,
): RunStatus {
  if (result !== undefined) {
    return result.status;
  }
  return live && !superseded ? "running" : "interrupted";
}
function hasSuccessor(base: string, launch: Launch): boolean {
  return (
    read(path.join(runDirectory(base, launch.id), "successor.json"), successorSchema) !== undefined
  );
}
export function runStatus(base: string, launch: Launch, state: RunState, live: boolean): RunStatus {
  return runStatusOf(
    state.kind === "settled" ? state.result : undefined,
    live,
    hasSuccessor(base, launch),
  );
}
/** The durable background work that keeps this run open; only a running run can wait. */
export function runWaiting(base: string, launch: Launch, status: RunStatus): Waiting | undefined {
  return status === "running"
    ? read(path.join(runDirectory(base, launch.id), "waiting.json"), waitingSchema)
    : undefined;
}
