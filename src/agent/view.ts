import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readOutputPage } from "../shared/output-page.ts";
import { actor, alive, observeAlive } from "./process.ts";
import {
  admissionSchema,
  commandSchema,
  exitSchema,
  successorSchema,
  type Launch,
  type Result,
} from "./contracts.ts";
import type { RunsInput } from "./tool-schemas.ts";
import { conversation, read, runDirectory } from "./storage.ts";
import { published } from "./notifications.ts";
import { readCanonicalResult, readResult } from "./usage.ts";
import { Type } from "./typebox.ts";

const commandMetadataSchema = Type.Pick(commandSchema, ["id", "runId", "action", "createdAt"]);
interface Guidance {
  id: string;
  runId: string;
  action: "steer";
  state: "pending" | "accepted" | "stale";
  at: number;
}

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
  guidance: Guidance[];
}
interface RunView extends Omit<RunSummary, "result"> {
  result?: Result;
  output: ReturnType<typeof outputView>;
}
type Receipt =
  | { readonly receipt: "launch"; readonly note: string }
  | { readonly receipt: "continuation" | "existing-successor" }
  | { readonly receipt: "guidance"; readonly command: string; readonly note: string }
  | { readonly stopRequest?: string; readonly stopAcknowledged: false; readonly note: string };

function toolResult(value: unknown, text: string): ToolReply {
  return { content: [{ type: "text" as const, text }], details: value };
}
function receiptResult(result: Result | undefined) {
  return result === undefined
    ? undefined
    : {
        id: result.id,
        owner: result.owner,
        status: result.status,
        endedAt: result.endedAt,
        terminalEntryId: result.terminalEntryId,
        error: result.error,
        accountingError: result.accountingError,
        accountingPending: result.accountingPending,
      };
}
/** `observed` holds batched liveness by actor token; any other actor gets a fresh check. */
function processView(base: string, launch: Launch, observed?: ReadonlyMap<string, boolean>) {
  const identity = actor(base, launch);
  const exit = identity
    ? read(path.join(conversation(base, launch), `exit-${identity.token}.json`), exitSchema)
    : undefined;
  return {
    live: identity !== undefined && (observed?.get(identity.token) ?? alive(identity)),
    exit: exit ?? null,
    exitKnown: exit !== undefined,
  };
}
function outputView(file: string, input: Pick<RunsInput, "offset" | "length">) {
  return fs.existsSync(file)
    ? readOutputPage(file, { offset: input.offset ?? 0, length: input.length ?? 32768 })
    : undefined;
}
function guidanceView(base: string, launches: readonly Launch[]): Map<string, Guidance[]> {
  const runs = new Map<string, Guidance[]>(launches.map((launch) => [launch.id, []]));
  for (const rootId of new Set(launches.map((launch) => launch.rootId))) {
    const runIds = new Set(
      launches.filter((launch) => launch.rootId === rootId).map((launch) => launch.id),
    );
    const directory = runDirectory(base, rootId);
    const dir = path.join(directory, "commands");
    if (!fs.existsSync(dir)) {
      continue;
    }
    fs.readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .forEach((file) => {
        const command = read(
          path.join(dir, file),
          commandMetadataSchema,
          (keys) =>
            keys.length === 0 ||
            (keys.length === 1 && Object.hasOwn(commandMetadataSchema.properties, String(keys[0]))),
        );
        const guidance = command && runIds.has(command.runId) ? runs.get(command.runId) : undefined;
        if (command?.action !== "steer" || !guidance) {
          return;
        }
        const admission = read(
          path.join(directory, "admissions", `${command.id}.json`),
          admissionSchema,
        );
        guidance.push({
          id: command.id,
          runId: command.runId,
          action: command.action,
          state: admission ? (admission.state ?? "accepted") : "pending",
          at: admission?.at ?? command.createdAt,
        });
        guidance.sort((a, b) => b.at - a.at).splice(20);
      });
  }
  return runs;
}
function metadata(
  base: string,
  launch: Launch,
  result: Result | undefined,
  options: {
    ctx?: ExtensionContext;
    guidance: Guidance[];
    observed?: ReadonlyMap<string, boolean>;
  },
): Omit<RunView, "output"> {
  const directory = runDirectory(base, launch.id);
  const process = processView(base, launch, options.observed);
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
    nativeReceipt: options.ctx ? (published(options.ctx, launch) ?? null) : null,
    process,
    sessionId: launch.sessionId,
    sessionFile: launch.sessionFile,
    outputFile,
    guidance: options.guidance,
  };
}
async function summaries(
  base: string,
  launches: readonly Launch[],
  ctx?: ExtensionContext,
): Promise<RunSummary[]> {
  const guidance = guidanceView(base, launches);
  const identities = [
    ...new Map(launches.map((launch) => [launch.rootId, actor(base, launch)])).values(),
  ].filter((identity) => identity !== undefined);
  const verdicts = await observeAlive(identities);
  const observed = new Map(identities.map((identity, index) => [identity.token, verdicts[index]]));
  return launches.map((launch) => {
    const view = metadata(base, launch, readCanonicalResult(base, launch), {
      ctx,
      guidance: guidance.get(launch.id) ?? [],
      observed,
    });
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
  });
}
function projection(
  base: string,
  launch: Launch,
  ctx?: ExtensionContext,
  input: Pick<RunsInput, "offset" | "length"> = {},
): RunView {
  const view = metadata(base, launch, readResult(base, launch), {
    ctx,
    guidance: guidanceView(base, [launch]).get(launch.id) ?? [],
  });
  return {
    ...view,
    output: outputView(view.outputFile, input),
  };
}
export function renderReceipt(
  base: string,
  launch: Launch,
  ctx: ExtensionContext | undefined,
  receipt: Receipt,
): ToolReply {
  const details = { ...projection(base, launch, ctx), ...receipt };
  const model = { ...details, result: receiptResult(details.result) };
  return toolResult(details, JSON.stringify(model, null, 2));
}
export async function renderInventory(
  base: string,
  launches: readonly Launch[],
  ctx: ExtensionContext | undefined,
  input: Pick<RunsInput, "offset">,
): Promise<ToolReply> {
  const offset = input.offset ?? 0;
  const runs = await summaries(base, launches.slice(offset, offset + 50), ctx);
  const details = {
    runs,
    offset,
    nextOffset: offset + runs.length < launches.length ? offset + runs.length : undefined,
    total: launches.length,
  };
  return toolResult(details, JSON.stringify(details, null, 2));
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
export function renderInspection(
  base: string,
  launch: Launch,
  ctx?: ExtensionContext,
  input: Pick<RunsInput, "offset" | "length"> = {},
): ToolReply {
  const details = projection(base, launch, ctx, input);
  return {
    ...toolResult(details, resultText(details)),
    isError: details.result?.status === "failed",
  };
}
