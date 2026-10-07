import type { IncomingMessage } from "node:http";
import { isUnknownArray } from "../shared/unknown.ts";
import { ASK_TIMEOUT, Fault, INBOX_COUNT, label, object, text } from "./bridge-protocol.ts";
import { body } from "./bridge-http.ts";

export type Operation =
  | { readonly route: "GET /v1/list" | "GET /v1/inbox" | "POST /v1/register" }
  | { readonly route: "POST /v1/ack"; readonly ids: readonly string[] }
  | { readonly route: "POST /v1/send"; readonly to: string; readonly message: string }
  | {
      readonly route: "POST /v1/ask";
      readonly to: string;
      readonly message: string;
      readonly timeoutMs: number;
    }
  | { readonly route: "POST /v1/reply"; readonly replyTo: string; readonly message: string };
type Route = Operation["route"];

const fields = {
  "GET /v1/list": [],
  "GET /v1/inbox": [],
  "POST /v1/register": [],
  "POST /v1/ack": ["ids"],
  "POST /v1/send": ["to", "message"],
  "POST /v1/ask": ["to", "message", "timeoutMs"],
  "POST /v1/reply": ["replyTo", "message"],
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
  const route = `${req.method ?? ""} ${req.url ?? ""}`;
  if (!isRoute(route)) {
    throw new Fault(404, "not_found", "Unknown method or path.");
  }
  if (
    req.method === "GET" &&
    (req.headers["transfer-encoding"] !== undefined ||
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0"))
  ) {
    throw new Fault(400, "invalid_input", "GET requests must not have a body.");
  }
  return route;
}

function timeout(value: unknown): number {
  const ms = value === undefined ? ASK_TIMEOUT : value;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 100 || ms > ASK_TIMEOUT) {
    throw new Fault(400, "invalid_input", "timeoutMs must be an integer from 100 to 120000.");
  }
  return ms;
}

export async function operationFor(
  req: IncomingMessage,
  route: Route,
  signal: AbortSignal,
): Promise<Operation> {
  const input = req.method === "POST" ? object(await body(req, signal), fields[route]) : {};
  switch (route) {
    case "GET /v1/list":
    case "GET /v1/inbox":
    case "POST /v1/register":
      return { route };
    case "POST /v1/ack": {
      if (!isUnknownArray(input.ids) || input.ids.length > INBOX_COUNT) {
        throw new Fault(400, "invalid_input", "ids must be an array of at most 256 message IDs.");
      }
      return { route, ids: [...new Set(input.ids.map((id) => label(id, "message ID")))] };
    }
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
  }
}
