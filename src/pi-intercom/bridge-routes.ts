import type { IncomingMessage } from "node:http";
import { isUnknownArray } from "../shared/unknown.ts";
import { Fault, INBOX_COUNT, label, object, text } from "./bridge-protocol.ts";
import { body } from "./bridge-http.ts";

export type Operation =
  | { readonly route: "GET /v1/list" | "POST /v1/register" }
  | {
      readonly route: "GET /v1/inbox";
      readonly after: number;
      readonly limit: number;
      readonly waitMs: number;
    }
  | { readonly route: "POST /v1/ack"; readonly ids: readonly string[] }
  | {
      readonly route: "POST /v1/send";
      readonly to: string;
      readonly message: string;
      readonly passive?: boolean | undefined;
      readonly messageId?: string | undefined;
      readonly replyTo?: string | undefined;
      readonly expectsReply?: boolean | undefined;
    };
type Route = Operation["route"];
const fields = {
  "GET /v1/list": [],
  "GET /v1/inbox": [],
  "POST /v1/register": [],
  "POST /v1/ack": ["ids"],
  "POST /v1/send": ["to", "message", "passive", "messageId", "replyTo", "expectsReply"],
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
  const route = `${req.method ?? ""} ${(req.url ?? "").split("?")[0] ?? ""}`;
  if (!isRoute(route)) {
    throw new Fault(404, "not_found", "Unknown method or path.");
  }
  if (req.url?.includes("?") === true && route !== "GET /v1/inbox") {
    throw new Fault(400, "invalid_input", "Query parameters are only supported for inbox.");
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
function queryFor(req: IncomingMessage): URLSearchParams {
  const query = new URL(req.url ?? "", "https://127.0.0.1").searchParams;
  if (
    [...query.keys()].some(
      (key) => !["after", "limit", "waitMs"].includes(key) || query.getAll(key).length !== 1,
    )
  ) {
    throw new Fault(400, "invalid_input", "Unknown or repeated query parameter.");
  }
  return query;
}
function inboxQuery(req: IncomingMessage): Extract<Operation, { readonly route: "GET /v1/inbox" }> {
  const query = queryFor(req);
  const after = query.get("after") ?? "0";
  const limit = query.get("limit") ?? String(INBOX_COUNT);
  const waitMs = query.get("waitMs") ?? "0";
  if (
    !/^(0|[1-9]\d{0,15})$/.test(after) ||
    !Number.isSafeInteger(Number(after)) ||
    !/^[1-9]\d{0,2}$/.test(limit) ||
    Number(limit) > INBOX_COUNT ||
    !/^(0|[1-9]\d{0,3}|10000)$/.test(waitMs)
  ) {
    throw new Fault(
      400,
      "invalid_input",
      "after must be a nonnegative safe integer cursor; limit must be 1..256; waitMs must be 0..10000.",
    );
  }
  return {
    route: "GET /v1/inbox",
    after: Number(after),
    limit: Number(limit),
    waitMs: Number(waitMs),
  };
}
export async function operationFor(
  req: IncomingMessage,
  route: Route,
  signal: AbortSignal,
): Promise<Operation> {
  const input = req.method === "POST" ? object(await body(req, signal), fields[route]) : {};
  switch (route) {
    case "GET /v1/list":
    case "POST /v1/register":
      return { route };
    case "GET /v1/inbox":
      return inboxQuery(req);
    case "POST /v1/ack":
      if (!isUnknownArray(input.ids) || input.ids.length > INBOX_COUNT) {
        throw new Fault(400, "invalid_input", "ids must be an array of at most 256 message IDs.");
      }
      return { route, ids: [...new Set(input.ids.map((id) => label(id, "message ID")))] };
    case "POST /v1/send":
      return send(input);
  }
}
function send(
  input: Readonly<Record<string, unknown>>,
): Extract<Operation, { readonly route: "POST /v1/send" }> {
  if (
    (input.passive !== undefined && typeof input.passive !== "boolean") ||
    (input.expectsReply !== undefined && typeof input.expectsReply !== "boolean")
  ) {
    throw new Fault(400, "invalid_input", "passive and expectsReply must be booleans.");
  }
  return {
    route: "POST /v1/send",
    to: label(input.to, "to").trim(),
    message: text(input.message),
    passive: input.passive,
    messageId: input.messageId === undefined ? undefined : label(input.messageId, "message ID"),
    replyTo: input.replyTo === undefined ? undefined : label(input.replyTo, "replyTo"),
    expectsReply: input.expectsReply,
  };
}
