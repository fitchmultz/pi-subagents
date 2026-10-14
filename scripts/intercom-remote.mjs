#!/usr/bin/env node
import https from "node:https";
import { lstatSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

function help() {
  console.log(`Usage: node intercom-remote.mjs <register|list|inbox|send|ask|reply|ack|start|spawn|resume|sessions|stop|cancel|capabilities|transcript|groups|group-upsert|broadcast|group-send> [options] [IDs...]

Environment (required):
  INTERCOM_BRIDGE_CA    Path to trusted bridge CA certificate
  INTERCOM_BRIDGE_CERT  Path to your client certificate
  INTERCOM_BRIDGE_KEY   Path to your private client key (owned, mode 0600)
  INTERCOM_BRIDGE_URL   HTTPS origin (default: https://127.0.0.1:9443)

Options:
  --to PEER            Recipient name, peer ID or native ID for messages/controls
  --message TEXT       Message for send/ask/reply
  --id ID              Send only: exact message ID (default: random; no deduplication guarantee)
  --passive            Send only: mailbox delivery without waking the recipient
  --reply-to ID        Inbound ask ID from inbox, for reply
  --timeout-ms MS      Ask: 100..120000 (default 120000); control: 100..10000 (default 3000)
  --after CURSOR       Inbox cursor from nextCursor (default: 0)
  --wait-ms MS         Inbox: wait for new mail, 0..10000 (default: 0)
  --limit COUNT        Inbox: 1..256; sessions/transcript: 1..100
  --name NAME          Start/reuse a named idle Pi session under local policy
  --session-id ID      Native ID for resume, stop or cancel
  --target ID_OR_NAME  Unique target for resume, stop, cancel or transcript
  --cwd PATH           Spawn in an existing locally approved workspace
  --task TEXT          Submit an Intercom task after spawn/resume readiness
  --model PROVIDER/ID  Exact spawn model; or --provider NAME with --model ID
  --mode cancel|kill   Stop mode: owned kill observes exit; foreign kill requests shutdown
  --live --saved       Opt into live/saved session metadata
  --q TEXT --offset N  Catalog filter and page cursor
  --max-bytes N        Transcript UTF-8 text budget (256..131072)
  --cursor CURSOR      Opaque cursor from an earlier transcript page
  --group NAME         Named group for broadcast/group-send
  --members JSON       Group members as a JSON array of IDs/names
  --name-pattern GLOB  Dynamic group name selector
  --cwd-pattern GLOB   Dynamic group cwd selector (combined with name pattern)
  -h, --help           Show help

Examples:
  node intercom-remote.mjs list
  node intercom-remote.mjs ask --to planner --message 'What is the current status?'
  node intercom-remote.mjs inbox
  node intercom-remote.mjs inbox --after NEXT_CURSOR --limit 64
  node intercom-remote.mjs reply --reply-to QUESTION_ID --message 'Proceed.'
  node intercom-remote.mjs ack MESSAGE_ID
  node intercom-remote.mjs start --name planner
  node intercom-remote.mjs spawn --name planner --cwd /project --task 'Review this project.'
  node intercom-remote.mjs sessions --live --saved
  node intercom-remote.mjs resume --name saved-unique-name
  node intercom-remote.mjs transcript --target NATIVE_SESSION_ID
  node intercom-remote.mjs stop --session-id NATIVE_SESSION_ID

Outputs JSON. Exit: 0 success, 1 API/TLS/transport failure, 2 invalid arguments.
No automatic retries: a lost response does not prove a message was unsent.`);
}

function allowedOptions(action) {
  const fields = {
    inbox: ["after", "limit", "wait-ms"],
    start: ["name"],
    spawn: ["name", "cwd", "task", "provider", "model"],
    resume: ["session-id", "name", "target", "task"],
    stop: ["session-id", "target", "to", "mode", "timeout-ms"],
    cancel: ["session-id", "target", "to", "timeout-ms"],
    sessions: ["live", "saved", "q", "offset", "limit"],
    capabilities: ["to", "target", "timeout-ms"],
    transcript: ["to", "target", "timeout-ms", "limit", "max-bytes", "cursor"],
    broadcast: ["message", "group"],
    "group-send": ["message", "group"],
    "group-upsert": ["name", "members", "name-pattern", "cwd-pattern"],
    send: ["to", "message", "passive", "id"],
    ask: ["to", "message", "timeout-ms"],
    reply: ["reply-to", "message"],
  };
  return fields[action] ?? [];
}

function requireMessage(recipient, message) {
  if (
    typeof message !== "string" ||
    message.trim() === "" ||
    typeof recipient !== "string" ||
    recipient.trim() === ""
  ) {
    throw new Error("Recipient/ask ID and message are required.");
  }
}

function sendId(id) {
  // Match the bridge's label bounds without changing the caller's ID.
  // oxlint-disable-next-line no-control-regex
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  if (id !== undefined && (id.trim() === "" || id.length > 512 || controls.test(id))) {
    throw new Error("Invalid message ID.");
  }
  return id;
}

function resumeBody(options) {
  if (["name", "session-id", "target"].filter((key) => options[key] !== undefined).length !== 1) {
    throw new Error("Resume requires exactly one --name, --session-id or --target.");
  }
  return {
    name: options.name,
    sessionId: options["session-id"],
    target: options.target,
    task: options.task,
  };
}
function stopBody(action, options) {
  if (["session-id", "target", "to"].filter((key) => options[key] !== undefined).length !== 1) {
    throw new Error("Choose exactly one --session-id, --target or --to.");
  }
  return {
    target: options["session-id"] ?? options.target ?? options.to,
    mode: action === "stop" ? options.mode : undefined,
    timeoutMs: controlTimeout(options),
  };
}
function launchBody(action, options) {
  if (action === "resume") {
    return resumeBody(options);
  }
  if (action === "stop" || action === "cancel") {
    return stopBody(action, options);
  }
  if (typeof options.name !== "string" || options.name.trim() === "") {
    throw new Error("--name is required.");
  }
  return action === "start"
    ? { name: options.name }
    : {
        name: options.name,
        cwd: options.cwd,
        task: options.task,
        provider: options.provider,
        model: options.model,
      };
}
function controlTimeout(options) {
  const timeoutMs = options["timeout-ms"] === undefined ? 3000 : Number(options["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
    throw new Error("Control --timeout-ms must be 100..10000.");
  }
  return timeoutMs;
}
function extraBody(action, options) {
  if (["capabilities", "transcript"].includes(action)) {
    if (["to", "target"].filter((key) => options[key] !== undefined).length !== 1) {
      throw new Error("Choose exactly one --to or --target.");
    }
    return {
      to: options.to ?? options.target,
      timeoutMs: controlTimeout(options),
      ...(action === "transcript" ? transcriptBody(options) : {}),
    };
  }
  if (action === "group-upsert") {
    return {
      name: options.name,
      members: options.members === undefined ? undefined : JSON.parse(options.members),
      namePattern: options["name-pattern"],
      cwdPattern: options["cwd-pattern"],
    };
  }
  if (action === "broadcast" || action === "group-send") {
    requireMessage(action === "group-send" ? options.group : "all", options.message);
    return { message: options.message, group: options.group };
  }
}
function transcriptBody(options) {
  return {
    limit: options.limit === undefined ? undefined : Number(options.limit),
    maxBytes: options["max-bytes"] === undefined ? undefined : Number(options["max-bytes"]),
    cursor: options.cursor,
  };
}
function requestBody(action, options, ids, timeout) {
  const extra = extraBody(action, options);
  if (extra !== undefined) {
    return extra;
  }
  if (["start", "spawn", "resume", "stop", "cancel"].includes(action)) {
    return launchBody(action, options);
  }
  if (["send", "ask", "reply"].includes(action)) {
    const recipient = action === "reply" ? options["reply-to"] : options.to;
    requireMessage(recipient, options.message);
    if (action === "reply") {
      return { replyTo: recipient, message: options.message };
    }
    return {
      to: recipient,
      message: options.message,
      messageId: sendId(options.id),
      ...(action === "ask" ? { timeoutMs: timeout } : {}),
      ...(options.passive === true ? { passive: true } : {}),
    };
  }
  if (action === "ack") {
    if (ids.length === 0) {
      throw new Error("ack needs at least one message ID.");
    }
    return { ids };
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

function requestQuery(action, options) {
  if (action === "inbox") {
    return inboxQuery(options);
  }
  return action === "sessions"
    ? new URLSearchParams(
        Object.entries(options).map(([key, value]) => [key, String(value)]),
      ).toString()
    : "";
}

let body, action, origin, timeout, query;
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
      "reply-to": { type: "string" },
      "timeout-ms": { type: "string" },
      after: { type: "string" },
      "wait-ms": { type: "string" },
      limit: { type: "string" },
      name: { type: "string" },
      "session-id": { type: "string" },
      cwd: { type: "string" },
      target: { type: "string" },
      mode: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      task: { type: "string" },
      live: { type: "boolean" },
      saved: { type: "boolean" },
      q: { type: "string" },
      offset: { type: "string" },
      group: { type: "string" },
      members: { type: "string" },
      "name-pattern": { type: "string" },
      "cwd-pattern": { type: "string" },
      "max-bytes": { type: "string" },
      cursor: { type: "string" },
    },
  });
  if (parsed.values.help) {
    help();
    process.exit(0);
  }
  const options = parsed.values;
  for (const name of ["wait-ms", "id"]) {
    if (
      parsed.tokens.filter((token) => token.kind === "option" && token.name === name).length > 1
    ) {
      throw new Error(`--${name} must not be repeated.`);
    }
  }
  [action] = parsed.positionals;
  if (
    ![
      "register",
      "list",
      "inbox",
      "send",
      "ask",
      "reply",
      "ack",
      "start",
      "spawn",
      "resume",
      "sessions",
      "stop",
      "cancel",
      "capabilities",
      "transcript",
      "groups",
      "group-upsert",
      "broadcast",
      "group-send",
    ].includes(action)
  ) {
    throw new Error("Choose an action; use --help.");
  }
  const allowed = allowedOptions(action);
  if (
    Object.keys(options).some((key) => !allowed.includes(key)) ||
    (action !== "ack" && parsed.positionals.length !== 1)
  ) {
    throw new Error("Unexpected arguments for this action.");
  }
  timeout = options["timeout-ms"] === undefined ? 120000 : Number(options["timeout-ms"]);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) {
    throw new Error("--timeout-ms must be 100..120000.");
  }
  body = requestBody(action, options, parsed.positionals.slice(1), timeout);
  query = requestQuery(action, options);
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
  const aliases = { "group-upsert": "groups", "group-send": "broadcast" };
  origin.pathname = `/v1/${aliases[action] ?? action}`;
  origin.search = query;
  const payload = JSON.stringify(body);
  const get = ["list", "inbox", "sessions", "groups"].includes(action);
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
    const timer = setTimeout(
      () => {
        req.destroy(new Error("Bridge request deadline exceeded; delivery may be unknown."));
      },
      ["start", "spawn", "resume", "transcript"].includes(action)
        ? 90000
        : (action === "ask" ? timeout : 0) + 15000,
    );
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end(get ? undefined : payload);
  });
  console.log(JSON.stringify(result.value, null, 2));
  if (
    result.status < 200 ||
    result.status >= 300 ||
    result.value?.ok !== true ||
    unsuccessful(result.value)
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: {
        code: "transport_error",
        message: error instanceof Error ? error.message : "Unexpected failure.",
        delivery: "unknown; do not blindly retry mutations",
      },
    }),
  );
  process.exitCode = 1;
}
function unsuccessful(value) {
  return (
    value?.status === "partial" ||
    ["denied", "failed", "unsupported"].includes(value?.native?.status)
  );
}
