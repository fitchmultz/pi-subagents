import * as path from "node:path";
import {
  admissionSchema,
  resultSchema,
  successorSchema,
  type Launch,
  type Result,
} from "./contracts.ts";
import { conversation, read, runDirectory } from "./storage.ts";

type Admission = "pending" | "admitted";
export type RunState =
  | { readonly kind: "saved-unadmitted" | "admitted" }
  | { readonly kind: "settled"; readonly result: Result };

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

export function runStatus(base: string, launch: Launch, state: RunState, live: boolean): string {
  if (state.kind === "settled") {
    return state.result.status;
  }
  return live &&
    read(path.join(runDirectory(base, launch.id), "successor.json"), successorSchema) === undefined
    ? "running"
    : "interrupted";
}
