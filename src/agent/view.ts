import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readOutputPage } from "../shared/output-page.ts";
import { actor, alive, observeAlive } from "./process.ts";
import {
  admissionSchema,
  commandMetadataSchema,
  exitSchema,
  waitingSchema,
  wakeFailureSchema,
  type Launch,
  type Result,
  type Waiting,
} from "./contracts.ts";
import type { RunsInput } from "./tool-schemas.ts";
import { conversation, read, runDirectory } from "./storage.ts";
import { published } from "./notifications.ts";
import { accountingFields, accountingState, readCanonicalResult, readResult } from "./usage.ts";
import { runAdmission, runState, runStatus } from "./run-state.ts";
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
  /** What a codemode script receives in place of the model text. */
  structuredContent?: string;
  isError?: boolean;
}
interface RunSummary {
  id: string;
  owner: string;
  rootId: string;
  predecessor?: string | undefined;
  name?: string | undefined;
  cwd: string;
  model: string;
  thinking: string;
  context: string;
  admission: string;
  status: string;
  completed: boolean;
  result?: Pick<Result, "status" | "endedAt" | "error"> | undefined;
  /** A running run that stays open for its child's own unfinished background work. */
  waiting?: Waiting | undefined;
  nativeReceipt: string | null;
  process: ReturnType<typeof processView>;
  lastWakeFailure?: { at: number; reason: string } | undefined;
  sessionId: string;
  sessionFile: string;
  outputFile: string;
  guidance: Guidance[];
}
interface RunView extends Omit<RunSummary, "result"> {
  result?: Result | undefined;
  output: ReturnType<typeof outputView>;
}
type Receipt =
  | { readonly receipt: "launch"; readonly note: string }
  | { readonly receipt: "continuation" | "existing-successor" }
  | { readonly receipt: "guidance"; readonly command: string; readonly note: string }
  | {
      readonly stopRequest?: string | undefined;
      readonly stopAcknowledged: false;
      readonly note: string;
    };

function toolResult(value: unknown, text: string): ToolReply {
  return { content: [{ type: "text" as const, text }], details: value };
}
function utc(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}
function receiptResult(result: Result | undefined) {
  if (result === undefined) {
    return;
  }
  const { contributions: _contributions, ...accounting } = accountingFields(
    accountingState(result),
  );
  return {
    id: result.id,
    owner: result.owner,
    status: result.status,
    endedAt: result.endedAt,
    error: result.error,
    ...accounting,
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
/** Batched actor liveness by actor token: one check per conversation. */
async function observeActors(
  base: string,
  launches: readonly Launch[],
): Promise<Map<string, boolean>> {
  const identities = [
    ...new Map(launches.map((launch) => [launch.rootId, actor(base, launch)])).values(),
  ].filter((identity) => identity !== undefined);
  const verdicts = await observeAlive(identities);
  return new Map(
    identities.flatMap((identity, index) => {
      const verdict = verdicts[index];
      return verdict === undefined ? [] : ([[identity.token, verdict]] as const);
    }),
  );
}
function metadata(
  base: string,
  launch: Launch,
  result: Result | undefined,
  options: {
    ctx?: ExtensionContext | undefined;
    guidance: Guidance[];
    observed?: ReadonlyMap<string, boolean>;
  },
): Omit<RunView, "output"> {
  const directory = runDirectory(base, launch.id);
  const process = processView(base, launch, options.observed);
  const outputFile = path.join(directory, "output.txt");
  const admission = runAdmission(base, launch);
  const state = runState(result, admission);
  const status = runStatus(base, launch, state, process.live);
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
    admission,
    status,
    completed: result !== undefined,
    result,
    waiting:
      status === "running" ? read(path.join(directory, "waiting.json"), waitingSchema) : undefined,
    nativeReceipt: options.ctx ? (published(options.ctx, launch) ?? null) : null,
    process,
    lastWakeFailure: read(
      path.join(conversation(base, launch), "wake-failure.json"),
      wakeFailureSchema,
    ),
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
  const observed = await observeActors(base, launches);
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
            ...(view.result.error !== undefined ? { error: view.result.error.slice(0, 2048) } : {}),
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
/** Running runs first, then newest first. Only runs without a result need a liveness check. */
async function inventoryOrder(base: string, launches: readonly Launch[]): Promise<Launch[]> {
  const unsettled = launches.filter(
    (launch) => !fs.existsSync(path.join(runDirectory(base, launch.id), "result.json")),
  );
  const observed = await observeActors(base, unsettled);
  const running = new Set(
    unsettled
      .filter(
        (launch) =>
          metadata(base, launch, undefined, { guidance: [], observed }).status === "running",
      )
      .map((launch) => launch.id),
  );
  const newest = launches.toSorted((a, b) => b.createdAt - a.createdAt);
  return [
    ...newest.filter((launch) => running.has(launch.id)),
    ...newest.filter((launch) => !running.has(launch.id)),
  ];
}
interface Inventory {
  runs: RunSummary[];
  offset: number;
  nextOffset: number | undefined;
  total: number;
}
/** The first item in full; inspection lists the rest. */
function waitingMark({ work }: Waiting): string {
  const more = work.length > 1 ? ` +${work.length - 1} more` : "";
  return `[waiting on ${JSON.stringify(work[0]?.description ?? "")}${more}]`;
}
function inventoryRow(run: RunSummary): string {
  return [
    run.id,
    run.status,
    run.result ? utc(run.result.endedAt) : "-",
    run.model,
    run.name === undefined ? "(unnamed)" : JSON.stringify(run.name),
    ...(run.waiting ? [waitingMark(run.waiting)] : []),
    ...(run.lastWakeFailure ? ["[wake failed: inspect]"] : []),
  ].join(" ");
}
function inventoryText({ runs, offset, nextOffset, total }: Inventory): string {
  if (runs.length === 0) {
    return total === 0
      ? "No saved agent runs."
      : `No agent runs at offset ${offset}; ${total} saved.`;
  }
  return [
    `Agent runs ${offset + 1}-${offset + runs.length} of ${total}: running first, then newest first. Columns: id, status, end time (UTC), model, name.`,
    `${nextOffset === undefined ? "" : `Next page: agent_runs list offset=${nextOffset}. `}Every field of one run: agent_runs inspect id=<id>.`,
    ...runs.map(inventoryRow),
  ].join("\n");
}
/** The model reads one line per run. Details and scripts keep every summary field as JSON. */
export async function renderInventory(
  base: string,
  launches: readonly Launch[],
  ctx: ExtensionContext | undefined,
  input: Pick<RunsInput, "offset">,
): Promise<ToolReply> {
  const offset = input.offset ?? 0;
  const ordered = await inventoryOrder(base, launches);
  const runs = await summaries(base, ordered.slice(offset, offset + 50), ctx);
  const details: Inventory = {
    runs,
    offset,
    nextOffset: offset + runs.length < launches.length ? offset + runs.length : undefined,
    total: launches.length,
  };
  return {
    ...toolResult(details, inventoryText(details)),
    structuredContent: JSON.stringify(details, null, 2),
  };
}
function identityText(details: RunView): string {
  return [
    `Name ${details.name === undefined ? "(unnamed)" : JSON.stringify(details.name)}; model ${details.model}; thinking ${details.thinking}; context ${details.context}; ${details.result ? `ended ${utc(details.result.endedAt)}` : "no result yet"}.`,
    `Cwd: ${details.cwd}`,
    `Owner ${details.owner}; root run ${details.rootId}; predecessor ${details.predecessor ?? "none"}; native session ${details.sessionId}.`,
  ].join("\n");
}
function receiptText(details: RunView): string {
  return details.nativeReceipt !== null
    ? `Native completion receipt: published (${details.nativeReceipt}); publication does not prove model consumption.`
    : "Native completion receipt: not observed published; queue admission is not publication or model consumption.";
}
function exitText(details: RunView): string {
  const { exit } = details.process;
  return exit
    ? `Process exit observed: code ${exit.code ?? "unknown"}, signal ${exit.signal ?? "none"}. Pid ${exit.pid} at ${utc(exit.at)}.`
    : "Process exit: unknown; run completion does not imply process exit.";
}
function waitingLines(waiting: Waiting | undefined): string[] {
  return waiting === undefined
    ? []
    : [
        `Waiting since ${utc(waiting.since)} on the child's own background work; the run ends when it does, and stop cancels it:`,
        ...waiting.work.map((item) => `  ${item.id}: ${JSON.stringify(item.description)}`),
      ];
}
function resultText(details: RunView): string {
  const page = details.output;
  const suffix =
    page?.nextOffset !== undefined
      ? `\n[Output continues: agent_runs inspect id=${details.id} offset=${page.nextOffset}; ${page.size} bytes total.]`
      : "";
  const guidance = details.guidance
    .map((command) => `  ${command.id}: ${command.state} at ${utc(command.at)}`)
    .join("\n");
  return [
    `Agent run ${details.id}: ${details.status}; admission ${details.admission}; process ${details.process.live ? "live" : "not observed live"}.`,
    identityText(details),
    ...waitingLines(details.waiting),
    receiptText(details),
    exitText(details),
    details.lastWakeFailure
      ? `Last wake failure at ${new Date(details.lastWakeFailure.at).toISOString()}: ${details.lastWakeFailure.reason} Retained intercom messages may still arrive after a later wake.`
      : "",
    `Guidance (latest 20):\n${guidance.length > 0 ? guidance : "  none"}`,
    "Guidance states: pending = not yet admitted; accepted = native queue admission, not journal publication or model consumption; stale = rejected, no new work was started (retry the entire prompt as a continuation).",
    details.result?.error ?? "",
    `${page?.text ?? ""}${suffix}`,
    `Native journal: ${details.sessionFile}`,
    `Output file: ${details.outputFile}`,
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
