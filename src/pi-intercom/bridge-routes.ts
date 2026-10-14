import type { IncomingMessage } from "node:http";
import { isUnknownArray } from "../shared/unknown.ts";
import { ASK_TIMEOUT, Fault, INBOX_COUNT, label, object, text } from "./bridge-protocol.ts";
import { body } from "./bridge-http.ts";
import type { CatalogQuery } from "./bridge-catalog.ts";
import { groupDefinition, type GroupDefinition } from "./bridge-groups.ts";
import { isControlVerb, type NativeControlVerb } from "./native-control-protocol.ts";
import { transcriptOptions, type TranscriptOptions } from "./transcript.ts";

export type MessagingOperation =
  | { readonly route: "GET /v1/list" | "POST /v1/register" }
  | { readonly route: "GET /v1/inbox"; readonly after: number; readonly limit: number }
  | { readonly route: "POST /v1/ack"; readonly ids: readonly string[] }
  | { readonly route: "POST /v1/send"; readonly to: string; readonly message: string }
  | {
      readonly route: "POST /v1/ask";
      readonly to: string;
      readonly message: string;
      readonly timeoutMs: number;
    }
  | { readonly route: "POST /v1/reply"; readonly replyTo: string; readonly message: string };
export type Operation =
  | MessagingOperation
  | { readonly route: "GET /v1/sessions"; readonly query?: CatalogQuery }
  | { readonly route: "POST /v1/start"; readonly name: string }
  | {
      readonly route: "POST /v1/spawn";
      readonly name: string;
      readonly cwd?: string;
      readonly provider?: string;
      readonly model?: string;
      readonly task?: string;
    }
  | {
      readonly route: "POST /v1/resume";
      readonly sessionId?: string;
      readonly target?: string;
      readonly name?: string;
      readonly task?: string;
    }
  | {
      readonly route: "POST /v1/stop" | "POST /v1/cancel";
      readonly sessionId: string;
      readonly timeoutMs: number;
    }
  | { readonly route: "GET /v1/groups" }
  | { readonly route: "POST /v1/groups"; readonly group: GroupDefinition }
  | { readonly route: "POST /v1/broadcast"; readonly message: string; readonly group?: string }
  | {
      readonly route: "POST /v1/control";
      readonly to: string;
      readonly verb: NativeControlVerb;
      readonly options?: TranscriptOptions;
      readonly timeoutMs: number;
    }
  | {
      readonly route: "GET /v1/transcript";
      readonly target: string;
      readonly options: TranscriptOptions;
      readonly timeoutMs: number;
    };
type Route = Operation["route"] | "POST /v1/transcript" | "POST /v1/capabilities";
type MessagingRoute =
  | MessagingOperation["route"]
  | "GET /v1/groups"
  | "GET /v1/sessions"
  | "GET /v1/transcript"
  | "POST /v1/control"
  | "POST /v1/transcript"
  | "POST /v1/capabilities";
const fields = {
  "GET /v1/list": [],
  "GET /v1/inbox": [],
  "POST /v1/register": [],
  "POST /v1/ack": ["ids"],
  "POST /v1/send": ["to", "message"],
  "POST /v1/ask": ["to", "message", "timeoutMs"],
  "POST /v1/reply": ["replyTo", "message"],
  "POST /v1/start": ["name"],
  "POST /v1/spawn": ["name", "cwd", "task", "provider", "model"],
  "POST /v1/resume": ["sessionId", "name", "target", "task"],
  "GET /v1/sessions": [],
  "POST /v1/stop": ["sessionId", "target", "to", "mode", "timeoutMs"],
  "POST /v1/cancel": ["sessionId", "target", "to", "timeoutMs"],
  "GET /v1/groups": [],
  "POST /v1/groups": ["name", "members", "namePattern", "cwdPattern", "match"],
  "POST /v1/broadcast": ["message", "group"],
  "POST /v1/control": ["to", "verb", "options", "timeoutMs"],
  "POST /v1/capabilities": ["to", "timeoutMs"],
  "POST /v1/transcript": ["to", "limit", "maxBytes", "cursor", "timeoutMs"],
  "GET /v1/transcript": ["target", "limit", "maxBytes", "cursor", "timeoutMs"],
};
function isRoute(route: string): route is Route {
  return Object.hasOwn(fields, route);
}
export function routeFor(req: IncomingMessage): Route {
  if (
    req.headers.origin !== undefined ||
    Object.keys(req.headers).some((key) => key.startsWith("sec-fetch-"))
  ) {
    throw new Fault(403, "browser_forbidden", "Browser access is not supported.");
  }
  const route = `${req.method ?? ""} ${(req.url ?? "").split("?")[0]}`;
  if (!isRoute(route)) {
    throw new Fault(404, "not_found", "Unknown method or path.");
  }
  if (
    req.url?.includes("?") === true &&
    !["GET /v1/inbox", "GET /v1/sessions", "GET /v1/transcript"].includes(route)
  ) {
    throw new Fault(
      400,
      "invalid_input",
      "Query parameters are only supported for inbox, sessions and transcript.",
    );
  }
  checkGetBody(req);
  return route;
}
function checkGetBody(req: IncomingMessage): void {
  if (
    req.method === "GET" &&
    (req.headers["transfer-encoding"] !== undefined ||
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0"))
  ) {
    throw new Fault(400, "invalid_input", "GET requests must not have a body.");
  }
}
function queryFor(req: IncomingMessage, allowed: readonly string[]): URLSearchParams {
  const query = new URL(req.url ?? "", "https://127.0.0.1").searchParams;
  if ([...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)) {
    throw new Fault(400, "invalid_input", "Unknown or repeated query parameter.");
  }
  return query;
}
function inboxQuery(req: IncomingMessage): Extract<Operation, { readonly route: "GET /v1/inbox" }> {
  const query = queryFor(req, ["after", "limit"]);
  const after = query.get("after") ?? "0";
  const limit = query.get("limit") ?? String(INBOX_COUNT);
  if (
    !/^(0|[1-9]\d{0,15})$/.test(after) ||
    !Number.isSafeInteger(Number(after)) ||
    !/^[1-9]\d{0,2}$/.test(limit) ||
    Number(limit) > INBOX_COUNT
  ) {
    throw new Fault(
      400,
      "invalid_input",
      "after must be a nonnegative safe integer cursor; limit must be 1..256.",
    );
  }
  return { route: "GET /v1/inbox", after: Number(after), limit: Number(limit) };
}
function pageNumber(value: string | null, fallback: number, min: number, max: number): number {
  const number = value === null ? fallback : Number(value);
  if (value === "" || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Fault(400, "invalid_input", "Invalid catalog pagination.");
  }
  return number;
}
function queryBoolean(value: string | null): boolean {
  if (value !== null && value !== "true" && value !== "false") {
    throw new Fault(400, "invalid_input", "Catalog switches must be true or false.");
  }
  return value === "true";
}
function catalogQuery(req: IncomingMessage): CatalogQuery | undefined {
  if (req.url?.includes("?") !== true) {
    return undefined;
  }
  const params = queryFor(req, ["live", "saved", "q", "offset", "limit"]);
  return {
    live: queryBoolean(params.get("live")),
    saved: queryBoolean(params.get("saved")),
    q: params.has("q") ? label(params.get("q"), "catalog filter", 128) : undefined,
    offset: pageNumber(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
    limit: pageNumber(params.get("limit"), 50, 1, 100),
  };
}
function timeout(value: unknown, control = false): number {
  const defaultMs = control ? 3000 : ASK_TIMEOUT;
  const ms = value === undefined ? defaultMs : value;
  const max = control ? 10000 : ASK_TIMEOUT;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 100 || ms > max) {
    throw new Fault(400, "invalid_input", `timeoutMs must be an integer from 100 to ${max}.`);
  }
  return ms;
}
function resume(
  input: Readonly<Record<string, unknown>>,
): Extract<Operation, { readonly route: "POST /v1/resume" }> {
  if (["sessionId", "name", "target"].filter((key) => input[key] !== undefined).length !== 1) {
    throw new Fault(
      400,
      "invalid_input",
      "Resume requires exactly one of sessionId, name or target.",
    );
  }
  const sessionId =
    input.sessionId === undefined ? undefined : label(input.sessionId, "native session ID", 128);
  if (sessionId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sessionId)) {
    throw new Fault(400, "invalid_input", "Resume takes a native ID, never a journal path.");
  }
  return {
    route: "POST /v1/resume",
    sessionId,
    target:
      input.target === undefined ? undefined : label(input.target, "resume target", 256).trim(),
    name:
      input.name === undefined ? undefined : label(input.name, "saved session name", 256).trim(),
    task: input.task === undefined ? undefined : text(input.task),
  };
}
function stop(
  route: "POST /v1/stop" | "POST /v1/cancel",
  input: Readonly<Record<string, unknown>>,
): Extract<Operation, { readonly route: "POST /v1/stop" | "POST /v1/cancel" }> {
  if (["sessionId", "target", "to"].filter((key) => input[key] !== undefined).length !== 1) {
    throw new Fault(400, "invalid_input", "Control requires exactly one sessionId, target or to.");
  }
  const mode = input.mode ?? "kill";
  if (mode !== "kill" && mode !== "cancel") {
    throw new Fault(400, "invalid_input", "Stop mode must be cancel or kill.");
  }
  return {
    route: mode === "cancel" ? "POST /v1/cancel" : route,
    sessionId: label(input.sessionId ?? input.target ?? input.to, "session target", 256).trim(),
    timeoutMs: timeout(input.timeoutMs, true),
  };
}
function nativeControl(
  route: Route,
  input: Readonly<Record<string, unknown>>,
): Extract<Operation, { readonly route: "POST /v1/control" | "GET /v1/transcript" }> {
  const verb = route === "POST /v1/control" ? input.verb : route.split("/").at(-1);
  if (!isControlVerb(verb)) {
    throw new Fault(400, "invalid_input", "Unknown native control verb.");
  }
  const timeoutMs = timeout(input.timeoutMs, true);
  const to = label(input.to ?? input.target, "session target").trim();
  if (verb === "transcript") {
    const options = transcriptOptions(
      route === "POST /v1/control"
        ? input.options
        : { limit: input.limit, maxBytes: input.maxBytes, cursor: input.cursor },
    );
    return { route: "GET /v1/transcript", target: to, options, timeoutMs };
  }
  if (input.options !== undefined) {
    throw new Fault(400, "invalid_input", "Only transcript accepts options.");
  }
  return { route: "POST /v1/control", verb, to, timeoutMs };
}
async function operationInput(
  req: IncomingMessage,
  route: Route,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (req.method === "POST") {
    return object(await body(req, signal), fields[route]);
  }
  if (route !== "GET /v1/transcript") {
    return {};
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of queryFor(req, fields[route])) {
    input[key] = ["limit", "maxBytes", "timeoutMs"].includes(key) ? Number(value) : value;
  }
  return input;
}
function messagingOperation(
  route: MessagingRoute,
  input: Readonly<Record<string, unknown>>,
  req: IncomingMessage,
): Operation {
  switch (route) {
    case "GET /v1/list":
    case "POST /v1/register":
    case "GET /v1/groups":
      return { route };
    case "GET /v1/inbox":
      return inboxQuery(req);
    case "GET /v1/sessions":
      return { route, query: catalogQuery(req) };
    case "POST /v1/ack":
      if (!isUnknownArray(input.ids) || input.ids.length > INBOX_COUNT) {
        throw new Fault(400, "invalid_input", "ids must be an array of at most 256 message IDs.");
      }
      return { route, ids: [...new Set(input.ids.map((id) => label(id, "message ID")))] };
    case "POST /v1/send":
      return { route, message: text(input.message), to: label(input.to, "to").trim() };
    case "POST /v1/ask":
      return {
        route,
        message: text(input.message),
        to: label(input.to, "to").trim(),
        timeoutMs: timeout(input.timeoutMs),
      };
    case "POST /v1/reply":
      return { route, message: text(input.message), replyTo: label(input.replyTo, "replyTo") };
    case "GET /v1/transcript":
    case "POST /v1/control":
    case "POST /v1/transcript":
    case "POST /v1/capabilities":
      return nativeControl(route, input);
  }
}
export async function operationFor(
  req: IncomingMessage,
  route: Route,
  signal: AbortSignal,
): Promise<Operation> {
  const input = await operationInput(req, route, signal);
  switch (route) {
    case "POST /v1/start":
      return { route, name: label(input.name, "session name", 64).trim() };
    case "POST /v1/spawn":
      return {
        route,
        name: label(input.name, "session name", 64).trim(),
        cwd: input.cwd === undefined ? undefined : label(input.cwd, "cwd", 4096),
        provider: input.provider === undefined ? undefined : label(input.provider, "provider", 128),
        model: input.model === undefined ? undefined : label(input.model, "model reference", 512),
        task: input.task === undefined ? undefined : text(input.task),
      };
    case "POST /v1/resume":
      return resume(input);
    case "POST /v1/stop":
    case "POST /v1/cancel":
      return stop(route, input);
    case "POST /v1/groups":
      return { route, group: groupDefinition(input) };
    case "POST /v1/broadcast":
      return {
        route,
        message: text(input.message),
        group: input.group === undefined ? undefined : label(input.group, "group", 64).trim(),
      };
    case "GET /v1/groups":
    case "GET /v1/inbox":
    case "GET /v1/list":
    case "GET /v1/sessions":
    case "GET /v1/transcript":
    case "POST /v1/ack":
    case "POST /v1/ask":
    case "POST /v1/capabilities":
    case "POST /v1/control":
    case "POST /v1/register":
    case "POST /v1/reply":
    case "POST /v1/send":
    case "POST /v1/transcript":
      return messagingOperation(route, input, req);
  }
}
