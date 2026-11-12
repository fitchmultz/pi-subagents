import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AccountingState, Launch, Result } from "./contracts.ts";
import { errorText } from "./host.ts";
import { runDirectory, write } from "./storage.ts";
import { accountingFields, type UsageIndex } from "./usage.ts";

function completionStatus(
  stopping: boolean,
  message: AssistantMessage | undefined,
  error: string | undefined,
): Result["status"] {
  if (stopping || message?.stopReason === "aborted") {
    return "stopped";
  }
  if (error !== undefined || !message || message.stopReason === "error") {
    return "failed";
  }
  return "completed";
}
/** The recorded failure: the launch error, the model's error, or the missing terminal message. */
const failureReason = (
  error: string | undefined,
  message: AssistantMessage | undefined,
): string | undefined =>
  error ??
  message?.errorMessage ??
  (message ? undefined : "Native run produced no terminal assistant message.");
/** The run's last assistant message: every entry after `baseline` belongs to the run. */
function response(session: AgentSession, baseline: ReadonlySet<string>) {
  const terminal = session.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        !baseline.has(entry.id) && entry.type === "message" && entry.message.role === "assistant",
    );
  if (terminal?.type !== "message" || terminal.message.role !== "assistant") {
    return;
  }
  return { id: terminal.id, message: terminal.message };
}
function output(message: AssistantMessage | undefined): string {
  return (
    message?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}
export interface EndedRun {
  readonly session: AgentSession;
  readonly baseline: ReadonlySet<string>;
  /** Every run of this conversation shares one native journal; later runs read only its suffix. */
  readonly accounting: UsageIndex;
  readonly stopping: boolean;
  readonly error?: string | undefined;
}
function usage(launch: Launch, run: EndedRun, terminal: string | undefined): AccountingState {
  try {
    return {
      kind: "verified",
      contributions: run.accounting.read(launch, run.baseline, terminal),
      terminalEntryId: terminal,
    };
  } catch (error) {
    return terminal === undefined
      ? { kind: "unavailable", error: errorText(error), terminalEntryId: undefined }
      : {
          kind: "pending",
          error: errorText(error),
          pending: { terminalCandidate: terminal, baseline: [...run.baseline] },
        };
  }
}
/**
 * The run's terminal fallback result, written only when nothing canonical exists yet.
 * The result publishes first; an existing output.txt is never destroyed: a failed save can
 * leave real output on disk with no canonical result beside it.
 */
export function saveTerminalResult(
  base: string,
  launch: Launch,
  stopping: boolean,
  error: string,
): void {
  const directory = runDirectory(base, launch.id);
  if (fs.existsSync(path.join(directory, "result.json"))) {
    return;
  }
  write(path.join(directory, "result.json"), {
    id: launch.id,
    owner: launch.owner,
    status: stopping ? "stopped" : "failed",
    endedAt: Date.now(),
    error,
  });
  if (!fs.existsSync(path.join(directory, "output.txt"))) {
    fs.writeFileSync(path.join(directory, "output.txt"), "", { mode: 0o600 });
  }
}
/** Publishes the run's canonical result and the text of its last assistant message. */
export function saveResult(base: string, launch: Launch, run: EndedRun): void {
  const terminal = response(run.session, run.baseline);
  const message = terminal?.message;
  const failure = failureReason(run.error, message);
  const result: Result = {
    id: launch.id,
    owner: launch.owner,
    status: completionStatus(run.stopping, message, run.error),
    endedAt: Date.now(),
    ...accountingFields(usage(launch, run, terminal?.id)),
    ...(failure !== undefined ? { error: failure } : {}),
  };
  fs.writeFileSync(path.join(runDirectory(base, launch.id), "output.txt"), output(message), {
    mode: 0o600,
  });
  write(path.join(runDirectory(base, launch.id), "result.json"), result);
}
