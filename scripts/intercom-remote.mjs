#!/usr/bin/env node
import https from "node:https";
import { lstatSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

function help() {
  console.log(`Usage: node intercom-remote.mjs <register|list|inbox|send|ack> [options] [IDs...]

Environment: INTERCOM_BRIDGE_CA, INTERCOM_BRIDGE_CERT, INTERCOM_BRIDGE_KEY
(owned private regular key, mode 0600), INTERCOM_BRIDGE_URL (HTTPS origin;
default https://127.0.0.1:9443).

send --to PEER --message TEXT [--id ID] [--passive] [--expects-reply] [--reply-to ID]
  Exact peer IDs or existing unambiguous resolver names. --id is preserved unchanged.
  --passive is mailbox-only, never a wake. Replies are ordinary correlated sends.
inbox [--after CURSOR] [--limit 1..256] [--wait-ms 0..10000]
ack ID [ID...] (at most 256)
  ACK transfers durable intake ownership, including any reply obligation.
  Persist the complete sender/message envelope before ACK.

JSON output. Exit: 0 success, 1 API/TLS/transport failure, 2 invalid arguments.
Acceptance is not native journal persistence, model start, or task completion.
No automatic retries: a lost mutation response means UNKNOWN, not unsent.`);
}

const actions = {
  register: [],
  list: [],
  ack: [],
  inbox: ["after", "limit", "wait-ms"],
  send: ["to", "message", "id", "passive", "expects-reply", "reply-to"],
};
function messageId(id) {
  // oxlint-disable-next-line no-control-regex
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  if (id !== undefined && (id.trim() === "" || id.length > 512 || controls.test(id))) {
    throw new Error("Invalid message ID.");
  }
  return id;
}
function requestBody(action, options, ids) {
  if (action === "send") {
    if (!options.to?.trim() || !options.message?.trim()) {
      throw new Error("--to and --message are required.");
    }
    return {
      to: options.to,
      message: options.message,
      messageId: messageId(options.id),
      passive: options.passive,
      expectsReply: options["expects-reply"],
      replyTo: messageId(options["reply-to"]),
    };
  }
  if (action === "ack") {
    if (ids.length < 1 || ids.length > 256) {
      throw new Error("ack requires 1..256 message IDs.");
    }
    return { ids: ids.map(messageId) };
  }
  return {};
}

function tlsFiles() {
  const files = {};
  for (const field of ["CA", "CERT", "KEY"]) {
    const path = process.env[`INTERCOM_BRIDGE_${field}`];
    if (!path) {
      throw new Error(`INTERCOM_BRIDGE_${field} is required.`);
    }
    if (field === "KEY") {
      privateKey(path);
    }
    files[field] = readFileSync(path);
  }
  return files;
}

function privateKey(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077) {
    throw new Error("Client key must be an owned private regular file (0600).");
  }
}

function inboxQuery(options) {
  const after = options.after ?? "0";
  const limit = options.limit ?? "256";
  const waitMs = options["wait-ms"] ?? "0";
  if (
    !/^(0|[1-9]\d{0,15})$/.test(after) ||
    !Number.isSafeInteger(Number(after)) ||
    !/^[1-9]\d{0,2}$/.test(limit) ||
    Number(limit) > 256 ||
    !/^(0|[1-9]\d{0,3}|10000)$/.test(waitMs)
  ) {
    throw new Error(
      "--after must be a nonnegative safe integer cursor; --limit must be 1..256; --wait-ms must be 0..10000.",
    );
  }
  const query = new URLSearchParams({ after, limit });
  if (options["wait-ms"] !== undefined) {
    query.set("waitMs", waitMs);
  }
  return query.toString();
}

let body, action, origin, query;
try {
  const parsed = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: "boolean", short: "h" },
      to: { type: "string" },
      message: { type: "string" },
      id: { type: "string" },
      passive: { type: "boolean" },
      "expects-reply": { type: "boolean" },
      "reply-to": { type: "string" },
      after: { type: "string" },
      "wait-ms": { type: "string" },
      limit: { type: "string" },
    },
  });
  if (parsed.values.help) {
    help();
    process.exit(0);
  }
  const options = parsed.values;
  const names = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") {
      continue;
    }
    if (names.has(token.name)) {
      throw new Error(`--${token.name} must not be repeated.`);
    }
    names.add(token.name);
  }
  [action] = parsed.positionals;
  if (!Object.hasOwn(actions, action)) {
    throw new Error("Choose an action; use --help.");
  }
  if (
    Object.keys(options).some((key) => !actions[action].includes(key)) ||
    (action !== "ack" && parsed.positionals.length !== 1)
  ) {
    throw new Error("Unexpected arguments for this action.");
  }
  body = requestBody(action, options, parsed.positionals.slice(1));
  query = action === "inbox" ? inboxQuery(options) : "";
  origin = new URL(process.env.INTERCOM_BRIDGE_URL || "https://127.0.0.1:9443");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("INTERCOM_BRIDGE_URL must be an HTTPS origin, without credentials or a path.");
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: {
        code: "invalid_arguments",
        message: error instanceof Error ? error.message : "Unexpected failure.",
      },
    }),
  );
  process.exit(2);
}

try {
  const files = tlsFiles();
  origin.pathname = `/v1/${action}`;
  origin.search = query;
  const payload = JSON.stringify(body);
  const get = ["list", "inbox"].includes(action);
  const result = await new Promise((resolve, reject) => {
    const req = https.request(
      origin,
      {
        method: get ? "GET" : "POST",
        ca: files.CA,
        cert: files.CERT,
        key: files.KEY,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        agent: false,
        headers: get
          ? {}
          : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) {
            req.destroy(new Error("Bridge response exceeds 16 MiB."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            reject(new Error("Bridge returned invalid JSON."));
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error("Bridge request deadline exceeded; delivery may be unknown."));
    }, 15000);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end(get ? undefined : payload);
  });
  console.log(JSON.stringify(result.value, null, 2));
  if (result.status < 200 || result.status >= 300 || result.value?.ok !== true) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: {
        code: "transport_error",
        message: error instanceof Error ? error.message : "Unexpected failure.",
        deliveryUnknown: true,
        delivery: "unknown; do not blindly retry mutations",
      },
    }),
  );
  process.exitCode = 1;
}
