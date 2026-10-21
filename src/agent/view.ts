import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readOutputPage } from "../shared/output-page.ts";
import { actor, alive } from "./process.ts";
import {
  admissionSchema,
  commandSchema,
  exitSchema,
  successorSchema,
  type Launch,
  type RunsInput,
  type Result,
} from "./contracts.ts";
import { conversation, read, runDirectory } from "./storage.ts";
import { published } from "./notifications.ts";
import { readCanonicalResult, readResult } from "./usage.ts";

interface ToolReply {
  content: { type: "text"; text: string }[];
  details: unknown;
  isError?: boolean;
}
interface RunSummary {
  id: string;
  owner: string;
  rootId: string;
  predecessor?: string;
  name?: string;
  cwd: string;
  model: string;
  thinking: string;
  context: string;
  admission: string;
  status: string;
  completed: boolean;
  result?: Pick<Result, "status" | "endedAt" | "error">;
  nativeReceipt: string | null;
  process: ReturnType<typeof processView>;
  sessionId: string;
  sessionFile: string;
  outputFile: string;
  guidance: ReturnType<typeof guidanceView>;
}
interface RunView extends Omit<RunSummary, "result"> {
  result?: Result;
  output: ReturnType<typeof outputView>;
}
export function toolResult(value: unknown, text = JSON.stringify(value, null, 2)): ToolReply {
  return { content: [{ type: "text" as const, text }], details: value };
}
function processView(base: string, launch: Launch) {
  const identity = actor(base, launch);
  const exit = identity
    ? read(path.join(conversation(base, launch), `exit-${identity.token}.json`), exitSchema)
    : undefined;
  return {
    live: identity !== undefined && alive(identity),
    exit: exit ?? null,
    exitKnown: exit !== undefined,
  };
}
function outputView(file: string, input: Pick<RunsInput, "offset" | "length">) {
  return fs.existsSync(file)
    ? readOutputPage(file, { offset: input.offset ?? 0, length: input.length ?? 32768 })
    : undefined;
}
function guidanceView(base: string, launch: Launch) {
  const dir = path.join(conversation(base, launch), "commands");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const command = read(path.join(dir, file), commandSchema);
      if (command?.action !== "steer" || command.runId !== launch.id) {
        return [];
      }
      const admission = read(
        path.join(conversation(base, launch), "admissions", `${command.id}.json`),
        admissionSchema,
      );
      return [
        {
          id: command.id,
          runId: launch.id,
          action: command.action,
          state: admission ? (admission.state ?? "accepted") : "pending",
          at: admission?.at ?? command.createdAt,
        },
      ];
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
}
function metadata(
  base: string,
  launch: Launch,
  result: Result | undefined,
  ctx?: ExtensionContext,
): Omit<RunView, "output"> {
  const directory = runDirectory(base, launch.id);
  const process = processView(base, launch);
  const outputFile = path.join(directory, "output.txt");
  const admission = read(
    path.join(conversation(base, launch), "admissions", `${launch.id}.json`),
    admissionSchema,
  );
  const status =
    result?.status ??
    (process.live && read(path.join(directory, "successor.json"), successorSchema) === undefined
      ? "running"
      : "interrupted");
  return {
    id: launch.id,
    owner: launch.owner,
    rootId: launch.rootId,
    predecessor: launch.predecessor,
    name: launch.name,
    cwd: launch.cwd,
    model: `${launch.provider}/${launch.model}`,
    thinking: launch.thinking,
    context: launch.context,
    admission: admission ? "admitted" : "pending",
    status,
    completed: result !== undefined,
    result,
    nativeReceipt: ctx ? (published(ctx, launch) ?? null) : null,
    process,
    sessionId: launch.sessionId,
    sessionFile: launch.sessionFile,
    outputFile,
    guidance: guidanceView(base, launch),
  };
}
export function summary(base: string, launch: Launch, ctx?: ExtensionContext): RunSummary {
  const view = metadata(base, launch, readCanonicalResult(base, launch), ctx);
  return {
    ...view,
    name: view.name?.slice(0, 256),
    result: view.result
      ? {
          status: view.result.status,
          endedAt: view.result.endedAt,
          error: view.result.error?.slice(0, 2048),
        }
      : undefined,
  };
}
export function projection(
  base: string,
  launch: Launch,
  ctx?: ExtensionContext,
  input: Pick<RunsInput, "offset" | "length"> = {},
): RunView {
  const view = metadata(base, launch, readResult(base, launch), ctx);
  return {
    ...view,
    output: outputView(view.outputFile, input),
  };
}
function receiptText(details: RunView): string {
  return details.nativeReceipt !== null
    ? `Native completion receipt: published (${details.nativeReceipt}); publication does not prove model consumption.`
    : "Native completion receipt: not observed published; queue admission is not publication or model consumption.";
}
function exitText(details: RunView): string {
  return details.process.exit
    ? `Process exit observed: code ${details.process.exit.code ?? "unknown"}, signal ${details.process.exit.signal ?? "none"}.`
    : "Process exit: unknown; run completion does not imply process exit.";
}
function resultText(details: RunView): string {
  const page = details.output;
  const suffix =
    page?.nextOffset !== undefined
      ? `\n[Output continues: agent_runs inspect id=${details.id} offset=${page.nextOffset}; ${page.size} bytes total.]`
      : "";
  const guidance = details.guidance
    .map((command) => `  ${command.id}: ${command.state}`)
    .join("\n");
  return [
    `Agent run ${details.id}: ${details.status}; admission ${details.admission}; process ${details.process.live ? "live" : "not observed live"}.`,
    receiptText(details),
    exitText(details),
    `Guidance (latest 20):\n${guidance.length > 0 ? guidance : "  none"}`,
    "Guidance states: pending = not yet admitted; accepted = native queue admission, not journal publication or model consumption; stale = rejected, no new work was started (retry the entire prompt as a continuation).",
    details.result?.error ?? "",
    `${page?.text ?? ""}${suffix}`,
    `Native journal: ${details.sessionFile}`,
  ].join("\n");
}
export function render(
  base: string,
  launch: Launch,
  ctx?: ExtensionContext,
  input: Pick<RunsInput, "offset" | "length"> & { receivedResult?: boolean } = {},
): ToolReply {
  const view = projection(base, launch, ctx, input);
  const details = {
    ...view,
    receivedResult: input.receivedResult === true,
    ...(input.receivedResult === true && view.result?.contributions !== undefined
      ? { agentUsage: view.result.contributions }
      : {}),
  };
  return {
    ...toolResult(details, resultText(details)),
    isError: details.result?.status === "failed",
  };
}
