import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readOutputPage } from "../shared/output-page.ts";
import { actor, alive } from "./process.ts";
import {
  admissionSchema,
  exitSchema,
  type Launch,
  type RunsInput,
  type Result,
} from "./contracts.ts";
import { conversation, read, runDirectory } from "./storage.ts";
import { published } from "./notifications.ts";
import { readResult } from "./usage.ts";

interface ToolReply {
  content: { type: "text"; text: string }[];
  details: unknown;
  isError?: boolean;
}
interface RunView {
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
  result?: Result;
  nativeReceipt: string | null;
  process: ReturnType<typeof processView>;
  sessionId: string;
  sessionFile: string;
  outputFile: string;
  output: ReturnType<typeof outputView>;
  guidance: ReturnType<typeof guidanceView>;
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
  const dir = path.join(conversation(base, launch), "admissions");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .map((file) => read(path.join(dir, file), admissionSchema))
    .filter((entry) => entry?.action === "steer" && entry.runId === launch.id)
    .sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))
    .slice(0, 20);
}
export function projection(
  base: string,
  launch: Launch,
  ctx?: ExtensionContext,
  input: Pick<RunsInput, "offset" | "length"> = {},
): RunView {
  const directory = runDirectory(base, launch.id);
  const result = readResult(base, launch);
  const process = processView(base, launch);
  const outputFile = path.join(directory, "output.txt");
  const admission = read(
    path.join(conversation(base, launch), "admissions", `${launch.id}.json`),
    admissionSchema,
  );
  const status = process.live ? "running" : "interrupted";
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
    status: result?.status ?? status,
    completed: result !== undefined,
    result,
    nativeReceipt: ctx ? (published(ctx, launch) ?? null) : null,
    process,
    sessionId: launch.sessionId,
    sessionFile: launch.sessionFile,
    outputFile,
    output: outputView(outputFile, input),
    guidance: guidanceView(base, launch),
  };
}
function resultText(details: RunView): string {
  const page = details.output;
  const suffix =
    page?.nextOffset !== undefined
      ? `\n[Output continues: agent_runs inspect id=${details.id} offset=${page.nextOffset}; ${page.size} bytes total.]`
      : "";
  return `Agent run ${details.id}: ${details.status}; admission ${details.admission}; process ${details.process.live ? "live" : "not observed live"}.\n${details.result?.error ?? ""}\n${page?.text ?? ""}${suffix}\nNative journal: ${details.sessionFile}`;
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
