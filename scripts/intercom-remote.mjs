#!/usr/bin/env node
import https from "node:https";
import { lstatSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

function help() {
  console.log(`Usage: node intercom-remote.mjs <register|list|inbox|send|ask|reply|ack> [options] [IDs...]

Environment (required):
  INTERCOM_BRIDGE_CA    Path to trusted bridge CA certificate
  INTERCOM_BRIDGE_CERT  Path to your client certificate
  INTERCOM_BRIDGE_KEY   Path to your private client key (owned, mode 0600)
  INTERCOM_BRIDGE_URL   HTTPS origin (default: https://127.0.0.1:9443)

Options:
  --to PEER            Recipient name or ID for send/ask
  --message TEXT       Message for send/ask/reply
  --reply-to ID        Inbound ask ID from inbox, for reply
  --timeout-ms MS      Ask timeout (100..120000, default: 120000)
  -h, --help           Show help

Examples:
  node intercom-remote.mjs list
  node intercom-remote.mjs ask --to planner --message 'What is the current status?'
  node intercom-remote.mjs inbox
  node intercom-remote.mjs reply --reply-to QUESTION_ID --message 'Proceed.'
  node intercom-remote.mjs ack MESSAGE_ID

Outputs JSON. Exit: 0 success, 1 API/TLS/transport failure, 2 invalid arguments.
No automatic retries: a lost response does not prove a message was unsent.`);
}

let options, body, action, origin, timeout;
try {
  const parsed = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, to: { type: "string" }, message: { type: "string" },
    "reply-to": { type: "string" }, "timeout-ms": { type: "string" },
  } });
  if (parsed.values.help) { help(); process.exit(0); }
  options = parsed.values;
  [action] = parsed.positionals;
  if (!["register", "list", "inbox", "send", "ask", "reply", "ack"].includes(action)) throw new Error("Choose an action; use --help.");
  const allowed = ["send", "ask"].includes(action) ? ["to", "message", ...(action === "ask" ? ["timeout-ms"] : [])] : action === "reply" ? ["reply-to", "message"] : [];
  if (Object.keys(options).some((key) => !allowed.includes(key)) ||
      (action !== "ack" && parsed.positionals.length !== 1)) throw new Error("Unexpected arguments for this action.");
  timeout = options["timeout-ms"] === undefined ? 120000 : Number(options["timeout-ms"]);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) throw new Error("--timeout-ms must be 100..120000.");
  body = ["send", "ask"].includes(action) ? { to: options.to, message: options.message, ...(action === "ask" ? { timeoutMs: timeout } : {}) }
    : action === "reply" ? { replyTo: options["reply-to"], message: options.message }
    : action === "ack" ? { ids: parsed.positionals.slice(1) } : {};
  if (["send", "ask", "reply"].includes(action) && (!body.message?.trim() || !(action === "reply" ? body.replyTo : body.to)?.trim())) throw new Error("Recipient/ask ID and message are required.");
  if (action === "ack" && body.ids.length === 0) throw new Error("ack needs at least one message ID.");
  origin = new URL(process.env.INTERCOM_BRIDGE_URL || "https://127.0.0.1:9443");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("INTERCOM_BRIDGE_URL must be an HTTPS origin, without credentials or a path.");
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: "invalid_arguments", message: error.message } }));
  process.exit(2);
}

try {
  const files = {};
  for (const field of ["CA", "CERT", "KEY"]) {
    const path = process.env[`INTERCOM_BRIDGE_${field}`];
    if (!path) throw new Error(`INTERCOM_BRIDGE_${field} is required.`);
    if (field === "KEY") {
      const st = lstatSync(path);
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error("Client key must be an owned private regular file (0600).");
    }
    files[field] = readFileSync(path);
  }
  origin.pathname = `/v1/${action}`;
  const payload = JSON.stringify(body);
  const get = ["list", "inbox"].includes(action);
  const result = await new Promise((resolve, reject) => {
    const req = https.request(origin, {
      method: get ? "GET" : "POST", ca: files.CA, cert: files.CERT, key: files.KEY,
      rejectUnauthorized: true, minVersion: "TLSv1.2", agent: false,
      headers: get ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) { req.destroy(new Error("Bridge response exceeds 16 MiB.")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error("Bridge returned invalid JSON.")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Bridge request deadline exceeded; delivery may be unknown.")), (action === "ask" ? timeout : 0) + 15000);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end(get ? undefined : payload);
  });
  console.log(JSON.stringify(result.value, null, 2));
  if (result.status < 200 || result.status >= 300 || result.value?.ok !== true) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: "transport_error", message: error.message, delivery: "unknown; do not blindly retry mutations" } }));
  process.exitCode = 1;
}
