import { constants, closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { createSecureContext, type TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import { IntercomClient } from "./broker/client.ts";
import { getBrokerSocketPath } from "./broker/paths.ts";
import { formatSessionTarget, resolveSessionProjectId, resolveSessionTarget } from "./session-targets.ts";
import type { Message, SendResult, SessionInfo } from "./types.ts";

const BODY_LIMIT = 64 * 1024;
const SEND_TIMEOUT = 8000;
const LIST_TIMEOUT = 5000;
const ASK_TIMEOUT = 120000;
const IDLE_TIMEOUT = 5 * 60 * 1000;
const MAX_CLIENTS = 64;
const MAX_CONNECTIONS = 128;
const MAX_REQUESTS = 8;
const INBOX_COUNT = 256;
const INBOX_BYTES = 4 * 1024 * 1024;
const LABEL_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

class Fault extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface Identity { fingerprint256: string; name: string; cwd: string }
interface Config {
  port: number;
  ca: string;
  cert: string;
  key: string;
  clients: Map<string, Identity>;
  tls: { ca: Buffer; cert: Buffer; key: Buffer };
}
interface Envelope { from: SessionInfo; message: Message }
interface InboxEntry extends Envelope { bytes: number; replying: boolean }
interface Connection { fingerprint: string; expires: number; timer: NodeJS.Timeout }
interface WaitingAsk { id: string; peer?: string; settled: boolean; resolve: (reply: Envelope) => void; reject: (error: Fault) => void }

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Fault(400, "invalid_input", "Expected a JSON object.");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key))) throw new Fault(400, "invalid_input", "Unknown field.");
  return result;
}

function label(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || LABEL_CONTROLS.test(value)) {
    throw new Fault(400, "invalid_input", `Invalid ${field}.`);
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || TEXT_CONTROLS.test(value)) throw new Fault(400, "invalid_input", "Invalid message.");
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/.test(value)) {
    throw new Fault(400, "invalid_input", "Invalid SHA256 certificate fingerprint.");
  }
  return value.replaceAll(":", "").toUpperCase();
}

function readFile(path: string, privateFile: boolean, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Configuration/TLS file must be a bounded regular file.");
    if (privateFile && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)) {
      throw new Error("Config and TLS key must be owned by the current user with mode 0600.");
    }
    const data = readFileSync(fd);
    if (data.length > limit) throw new Error("Configuration/TLS file exceeds its size limit.");
    return data;
  } finally {
    closeSync(fd);
  }
}

function loadConfig(path: string): Config {
  const input = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFile(path, true, BODY_LIMIT))), ["port", "ca", "cert", "key", "clients"]);
  const port = input.port === undefined ? 9443 : input.port;
  if (!Number.isInteger(port) || typeof port !== "number" || port < 0 || port > 65535) throw new Error("Invalid HTTPS port.");
  const ca = label(input.ca, "ca path", 4096);
  const cert = label(input.cert, "cert path", 4096);
  const key = label(input.key, "key path", 4096);
  if (![ca, cert, key].every(isAbsolute)) throw new Error("TLS paths must be absolute.");
  if (!Array.isArray(input.clients) || input.clients.length > MAX_CLIENTS) throw new Error(`clients must be an array of at most ${MAX_CLIENTS} identities.`);
  const clients = new Map<string, Identity>();
  const names = new Set<string>();
  for (const raw of input.clients) {
    const entry = object(raw, ["fingerprint256", "name", "cwd"]);
    const fingerprint256 = fingerprint(entry.fingerprint256);
    const name = label(entry.name, "name", 128).trim();
    const cwd = label(entry.cwd, "cwd", 4096);
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error("Client cwd must be an existing absolute directory.");
    if (clients.has(fingerprint256) || names.has(name.toLowerCase())) throw new Error("Client fingerprints and names must be unique.");
    clients.set(fingerprint256, { fingerprint256, name, cwd });
    names.add(name.toLowerCase());
  }
  const tls = { ca: readFile(ca, false, 1024 * 1024), cert: readFile(cert, false, 1024 * 1024), key: readFile(key, true, 1024 * 1024) };
  createSecureContext({ ...tls, minVersion: "TLSv1.2" });
  return { port, ca, cert, key, clients, tls };
}

let logBackpressure = false;
let lostLogEvents = 0;
function log(event: string, fields: Record<string, unknown> = {}): void {
  if (logBackpressure) { lostLogEvents = Math.min(Number.MAX_SAFE_INTEGER, lostLogEvents + 1); return; }
  logBackpressure = !process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`);
  if (logBackpressure) process.stdout.once("drain", () => {
    logBackpressure = false;
    if (lostLogEvents) {
      const lostEvents = lostLogEvents;
      lostLogEvents = 0;
      log("log_overflow", { result: "metadata_lost", lostEvents });
    }
  });
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw signal.reason;
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

async function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw new Fault(415, "content_type", "Use application/json.");
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new Fault(413, "body_too_large", "JSON body exceeds 64 KiB.");
  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => { cleanup(); req.pause(); reject(error); };
    const onAbort = () => fail(signal.reason);
    const onError = () => fail(new Fault(400, "invalid_body", "Could not read JSON body."));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { fail(new Fault(413, "body_too_large", "JSON body exceeds 64 KiB.")); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => fail(new Fault(408, "body_timeout", "JSON body deadline exceeded.")), 10000);
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    if (signal.aborted) onAbort();
  });
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown; }
  catch { throw new Fault(400, "invalid_json", "Invalid UTF-8 JSON body."); }
}

class Session {
  readonly bridge: Bridge;
  readonly identity: Identity;
  readonly expires: number;
  readonly client = new IntercomClient({ sendTimeoutMs: SEND_TIMEOUT, listTimeoutMs: LIST_TIMEOUT });
  readonly requests = new Set<AbortController>();
  readonly inbox = new Map<string, InboxEntry>();
  inboxBytes = 0;
  pending?: WaitingAsk;
  closed = false;
  private connecting?: Promise<void>;
  private disconnecting?: Promise<void>;
  private lease?: NodeJS.Timeout;
  private closeReason?: Fault;

  constructor(bridge: Bridge, identity: Identity, expires: number) {
    this.bridge = bridge;
    this.identity = identity;
    this.expires = expires;
    this.client.on("error", () => this.close(new Fault(503, "broker_unavailable", "Broker connection failed.")));
    this.client.on("disconnected", () => this.close(new Fault(503, "broker_disconnected", "Broker disconnected.")));
    this.client.on("_registered", () => {
      // IntercomClient cannot abort socket acquisition; retire a cancelled generation before any application write.
      if (this.closed) void this.disconnect();
    });
    this.client.on("message", (from: SessionInfo, message: Message) => this.receive(from, message));
    this.client.on("session_left", (id: string) => {
      if (this.pending?.peer === id && !this.pending.settled) this.pending.reject(new Fault(409, "peer_offline", "Ask recipient disconnected.", { id: this.pending.id }));
      for (const [messageId, entry] of this.inbox) {
        if (entry.from.id === id && entry.message.expectsReply) { this.remove(messageId); this.bridge.lost(this.identity.fingerprint256); }
      }
      this.presence();
    });
    this.touch();
  }

  guard(signal?: AbortSignal): void {
    if (signal) cancelled(signal);
    if (this.closed) throw this.closeReason;
    if (!this.bridge.allowed(this.identity)) throw new Fault(403, "revoked", "Identity is no longer authorized.");
    if (this.expires <= Date.now()) {
      const error = new Fault(403, "certificate_expired", "Client certificate expired.");
      this.close(error);
      throw error;
    }
  }

  touch(): void {
    clearTimeout(this.lease);
    this.lease = setTimeout(() => this.close(this.expires <= Date.now()
      ? new Fault(403, "certificate_expired", "Client certificate expired.")
      : new Fault(410, "lease_expired", "Bridge session idle lease expired.")), Math.max(1, Math.min(IDLE_TIMEOUT, this.expires - Date.now())));
  }

  async connect(signal: AbortSignal): Promise<void> {
    this.guard(signal);
    if (!this.connecting) {
      this.connecting = (async () => {
        const projectId = await resolveSessionProjectId(this.identity.cwd);
        this.guard();
        await this.client.connect({ name: this.identity.name, cwd: this.identity.cwd, model: "remote-bridge", projectId, status: "idle", acceptsAsks: true, pendingAsks: 0 }, `remote-${this.identity.fingerprint256.toLowerCase()}`);
        if (this.closed) { await this.disconnect(); return; }
        if (this.client.sessionId !== `remote-${this.identity.fingerprint256.toLowerCase()}`) {
          this.close(new Fault(409, "identity_in_use", "This remote identity is already registered by another connection."));
          throw new Fault(409, "identity_in_use", "This remote identity is already registered by another connection.");
        }
        log("registered", this.fields());
      })().catch((error: unknown) => {
        if (!this.closed) this.close(error instanceof Fault ? error : new Fault(503, "broker_unavailable", "Local broker is unavailable; bridge does not start it."));
        throw error;
      }).finally(() => { if (this.closed) void this.disconnect(); });
    }
    await wait(this.connecting, signal);
    this.guard(signal);
  }

  fields(): Record<string, unknown> { return { name: this.identity.name, fingerprint: this.identity.fingerprint256 }; }

  private disconnect(): Promise<void> {
    if (!this.disconnecting) {
      this.disconnecting = this.client.disconnect().finally(() => { this.disconnecting = undefined; });
    }
    return this.disconnecting;
  }

  close(error: Fault): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = error;
    clearTimeout(this.lease);
    this.pending?.reject(error);
    for (const controller of this.requests) controller.abort(error);
    this.bridge.lost(this.identity.fingerprint256, this.inbox.size);
    this.inbox.clear();
    this.inboxBytes = 0;
    // Keep the retiring generation in the map until socket acquisition/registration has settled.
    // Otherwise rapid aborts could create an unbounded number of unfinished broker connects.
    const disconnect = this.disconnect();
    void (async () => {
      await disconnect;
      try { await this.connecting; } catch { /* The original request receives the connect failure. */ }
      await this.disconnect();
      if (this.bridge.sessions.get(this.identity.fingerprint256) === this) this.bridge.sessions.delete(this.identity.fingerprint256);
      log("session_closed", { ...this.fields(), result: error.code });
    })();
  }

  private receive(from: SessionInfo, message: Message): void {
    if (this.closed) return;
    try { this.guard(); } catch (error) {
      this.close(error instanceof Fault ? error : new Fault(403, "revoked", "Identity is no longer authorized."));
      return;
    }
    log("received", { ...this.fields(), peer: from.id, messageId: message.id, result: "received" });
    const pending = this.pending;
    if (pending && !pending.settled && pending.id === message.replyTo && pending.peer === from.id) {
      pending.resolve({ from, message });
      return;
    }
    if (this.inbox.has(message.id)) { this.bridge.lost(this.identity.fingerprint256); return; }
    const bytes = Buffer.byteLength(JSON.stringify({ from, message }));
    if (this.inbox.size >= INBOX_COUNT || this.inboxBytes + bytes > INBOX_BYTES) {
      this.bridge.lost(this.identity.fingerprint256);
      log("inbox_overflow", { ...this.fields(), peer: from.id, messageId: message.id, result: "lost" });
      return;
    }
    // ponytail: inbox is bounded and volatile; use a private durable journal if restart/lease-loss recovery becomes required.
    this.inbox.set(message.id, { from, message, bytes, replying: false });
    this.inboxBytes += bytes;
    this.presence();
  }

  remove(id: string): void {
    const entry = this.inbox.get(id);
    if (entry) { this.inboxBytes -= entry.bytes; this.inbox.delete(id); }
  }

  presence(): void {
    if (this.closed) return;
    const pendingAsks = [...this.inbox.values()].filter((entry) => entry.message.expectsReply).length;
    this.client.updatePresence({ pendingAsks, acceptsAsks: this.inbox.size < INBOX_COUNT && this.inboxBytes < INBOX_BYTES });
  }

  async peers(signal: AbortSignal): Promise<SessionInfo[]> {
    this.guard(signal);
    let peers: SessionInfo[];
    try { peers = await wait(this.client.listSessions(), signal); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error && error.message === "List sessions timeout") throw new Fault(504, "list_timeout", "Broker session list deadline exceeded.");
      throw new Fault(503, "broker_unavailable", "Broker session list failed.");
    }
    this.guard(signal);
    return peers;
  }

  async target(to: string, signal: AbortSignal): Promise<SessionInfo> {
    const resolution = resolveSessionTarget(await this.peers(signal), to);
    if (resolution.status === "none") throw new Fault(404, "peer_offline", "Peer is not connected.");
    if (resolution.status !== "found" || !resolution.target) throw new Fault(409, "ambiguous_target", "Use an unambiguous peer name or session ID (prefixes need at least 8 characters).");
    if (resolution.target.id === this.client.sessionId) throw new Fault(400, "self_target", "Choose another peer.");
    return resolution.target;
  }

  async send(peer: string, message: string, signal: AbortSignal, requestId: string, options: { messageId?: string; replyTo?: string; expectsReply?: boolean } = {}): Promise<SendResult> {
    this.guard(signal);
    const id = options.messageId ?? randomUUID();
    log("send", { ...this.fields(), requestId, peer, messageId: id, result: "attempt" });
    let result: SendResult;
    try { result = await wait(this.client.send(peer, { text: message, delivery: "steer", ...options, messageId: id }), signal); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      const fault = new Fault(504, "send_unconfirmed", "Broker acknowledgement was not received; delivery is unknown. Do not automatically retry.", { id, deliveryUnknown: true });
      this.close(fault);
      throw fault;
    }
    this.guard(signal);
    log("send_result", { ...this.fields(), requestId, peer, messageId: id, result: result.accepted ? "accepted" : "rejected" });
    if (!result.accepted) throw new Fault(409, "delivery_failed", result.reason ?? "Broker rejected delivery.", { id, accepted: false, delivered: false });
    return result;
  }

  async ask(to: string, message: string, timeoutMs: number, signal: AbortSignal, requestId: string): Promise<Record<string, unknown>> {
    if (this.pending) throw new Fault(409, "ask_in_progress", "Only one concurrent ask is allowed per identity.");
    const id = randomUUID();
    let waiting!: WaitingAsk;
    let timer: NodeJS.Timeout | undefined;
    let receipt: SendResult | undefined;
    const reply = new Promise<Envelope>((resolve, reject) => {
      waiting = { id, settled: false,
        resolve: (answer) => { waiting.settled = true; clearTimeout(timer); resolve(answer); },
        reject: (error) => { waiting.settled = true; clearTimeout(timer); reject(error); },
      };
    });
    // A disconnect may reject the reply while target lookup or send acknowledgement is still pending.
    void reply.catch(() => {});
    this.pending = waiting;
    const abort = () => waiting.reject(signal.reason as Fault);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.connect(signal);
      const peer = await this.target(to, signal);
      this.guard(signal);
      waiting.peer = peer.id;
      timer = setTimeout(() => {
        const fault = new Fault(504, "ask_timeout", "Peer did not reply before the ask deadline.", { id, ...(receipt ? { accepted: receipt.accepted, delivered: receipt.delivered } : { deliveryUnknown: true }) });
        if (receipt) waiting.reject(fault);
        else this.close(fault);
      }, timeoutMs);
      receipt = await this.send(peer.id, message, signal, requestId, { messageId: id, expectsReply: true });
      const answer = await wait(reply, signal);
      this.guard(signal);
      return { ...receipt, replied: true, reply: answer };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (this.pending === waiting) this.pending = undefined;
    }
  }
}

class Bridge {
  private config: Config;
  private readonly configPath: string;
  readonly sessions = new Map<string, Session>();
  private readonly losses = new Map<string, number>();
  private readonly sockets = new Set<Socket>();
  private readonly connections = new Map<TLSSocket, Connection>();
  private readonly server: Server;
  private stopping = false;

  constructor(config: Config, configPath: string) {
    this.config = config;
    this.configPath = configPath;
    this.server = createServer({ ...config.tls, minVersion: "TLSv1.2", requestCert: true, rejectUnauthorized: true, handshakeTimeout: 10000 }, (req, res) => { void this.handle(req, res); });
    this.server.maxConnections = MAX_CONNECTIONS;
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
    this.server.keepAliveTimeout = 5000;
    this.server.maxRequestsPerSocket = 100;
    this.server.maxHeadersCount = 32;
    this.server.on("connection", (socket: Socket) => {
      if (this.stopping || this.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("secureConnection", (socket: TLSSocket) => this.authenticate(socket));
    this.server.on("tlsClientError", () => log("connection_rejected", { result: "tls_authentication_failed" }));
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("error", () => { log("server_error", { result: "listener_failed" }); process.exitCode = 1; this.shutdown(); });
  }

  allowed(identity: Identity): boolean {
    const current = this.config.clients.get(identity.fingerprint256);
    return !this.stopping && current?.name === identity.name && current.cwd === identity.cwd;
  }

  lost(fp: string, count = 1): void {
    if (count && this.config.clients.has(fp)) this.losses.set(fp, Math.min(Number.MAX_SAFE_INTEGER, (this.losses.get(fp) ?? 0) + count));
  }

  private authenticate(socket: TLSSocket): void {
    const cert = socket.getPeerCertificate();
    let fp: string;
    try { fp = fingerprint(cert.fingerprint256); } catch { socket.destroy(); return; }
    const identity = this.config.clients.get(fp);
    const expires = Date.parse(cert.valid_to);
    const starts = Date.parse(cert.valid_from);
    if (!socket.authorized || !identity || this.stopping || !Number.isFinite(expires) || !Number.isFinite(starts) || starts > Date.now() || expires <= Date.now()) {
      log("connection_rejected", { fingerprint: fp, result: "unauthorized" });
      socket.destroy();
      return;
    }
    // Timers longer than INT32_MAX fire immediately in Node; recheck long-lived certificates in bounded slices.
    const expiry = () => {
      if (expires <= Date.now()) { this.drop(fp, new Fault(403, "certificate_expired", "Client certificate expired.")); return; }
      connection.timer = setTimeout(expiry, Math.min(expires - Date.now(), 0x7fffffff));
    };
    const connection: Connection = { fingerprint: fp, expires, timer: setTimeout(expiry, Math.min(expires - Date.now(), 0x7fffffff)) };
    this.connections.set(socket, connection);
    socket.once("close", () => { clearTimeout(connection.timer); this.connections.delete(socket); });
    log("connected", { name: identity.name, fingerprint: fp, result: "authenticated" });
  }

  private drop(fp: string, error: Fault): void {
    this.sessions.get(fp)?.close(error);
    for (const [socket, connection] of this.connections) if (connection.fingerprint === fp) socket.destroy();
  }

  start(): void {
    this.server.listen(this.config.port, "127.0.0.1", () => {
      const address = this.server.address();
      log("listening", { result: "ready", host: "127.0.0.1", pid: process.pid, port: typeof address === "object" && address ? address.port : this.config.port, brokerSocket: getBrokerSocketPath() });
    });
    process.on("SIGHUP", () => this.reload());
    process.once("SIGINT", () => this.shutdown());
    process.once("SIGTERM", () => this.shutdown());
  }

  private reload(): void {
    if (this.stopping) return;
    try {
      const next = loadConfig(this.configPath);
      if (next.port !== this.config.port || next.ca !== this.config.ca || next.cert !== this.config.cert || next.key !== this.config.key
        || !next.tls.ca.equals(this.config.tls.ca) || !next.tls.cert.equals(this.config.tls.cert) || !next.tls.key.equals(this.config.tls.key)) {
        throw new Error("TLS/listener rotation requires restarting the helper.");
      }
      this.config = next;
      for (const [fp, session] of this.sessions) if (!this.allowed(session.identity)) this.drop(fp, new Fault(403, "revoked", "Identity revoked or changed by configuration reload."));
      for (const connection of this.connections.values()) if (!next.clients.has(connection.fingerprint)) this.drop(connection.fingerprint, new Fault(403, "revoked", "Identity revoked."));
      for (const fp of this.losses.keys()) if (!next.clients.has(fp)) this.losses.delete(fp);
      log("allowlist_reloaded", { result: "accepted", clients: next.clients.size });
    } catch {
      this.config.clients.clear();
      for (const session of this.sessions.values()) session.close(new Fault(503, "configuration_invalid", "Configuration reload failed; all identities denied."));
      for (const socket of this.sockets) socket.destroy();
      this.losses.clear();
      log("allowlist_reloaded", { result: "failed_closed" });
    }
  }

  private shutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.server.close();
    for (const session of this.sessions.values()) session.close(new Fault(503, "shutting_down", "Bridge is shutting down."));
    for (const socket of this.sockets) socket.destroy();
    log("shutdown", { result: "closed" });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    let session: Session | undefined;
    let controller: AbortController | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let peer: string | undefined;
    const abort = () => session?.close(new Fault(499, "client_aborted", "HTTP client disconnected; delivery may be unknown."));
    const onClose = () => { if (!res.writableFinished) abort(); };
    const reply = (status: number, data: Record<string, unknown>) => {
      if (res.destroyed || res.writableEnded) return;
      const payload = JSON.stringify({ ...data, requestId });
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Connection": "close" });
      res.end(payload);
    };
    try {
      const socket = req.socket as TLSSocket;
      const connection = this.connections.get(socket);
      const identity = connection && this.config.clients.get(connection.fingerprint);
      if (!connection || !identity || !socket.authorized || this.stopping) throw new Fault(403, "unauthorized", "Client certificate is not authorized.");
      if (connection.expires <= Date.now()) { this.drop(connection.fingerprint, new Fault(403, "certificate_expired", "Client certificate expired.")); throw new Fault(403, "certificate_expired", "Client certificate expired."); }
      if (req.headers.origin !== undefined || Object.keys(req.headers).some((key) => key.startsWith("sec-fetch-"))) throw new Fault(403, "browser_forbidden", "Browser access is not supported.");
      const route = `${req.method} ${req.url}`;
      if (!["GET /v1/list", "GET /v1/inbox", "POST /v1/register", "POST /v1/send", "POST /v1/ask", "POST /v1/reply", "POST /v1/ack"].includes(route)) throw new Fault(404, "not_found", "Unknown method or path.");
      if (req.method === "GET" && (req.headers["transfer-encoding"] !== undefined || req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) throw new Fault(400, "invalid_input", "GET requests must not have a body.");
      session = this.sessions.get(identity.fingerprint256);
      if (!session) { session = new Session(this, identity, connection.expires); this.sessions.set(identity.fingerprint256, session); }
      session.guard();
      if (session.requests.size >= MAX_REQUESTS) throw new Fault(429, "too_many_requests", "Too many concurrent requests for this identity.");
      controller = new AbortController();
      const signal = controller.signal;
      session.requests.add(controller);
      session.touch();
      req.once("aborted", abort);
      res.once("close", onClose);
      const setDeadline = (ms: number) => {
        clearTimeout(deadline);
        deadline = setTimeout(() => session?.close(new Fault(504, "request_timeout", "HTTP operation deadline exceeded; delivery may be unknown.")), Math.max(1, ms - (Date.now() - started)));
      };
      setDeadline(route === "POST /v1/ask" ? ASK_TIMEOUT + 15000 : 15000);
      let input: Record<string, unknown> = {};
      if (req.method === "POST") {
        const fields = route === "POST /v1/register" ? [] : route === "POST /v1/ack" ? ["ids"] : route === "POST /v1/reply" ? ["replyTo", "message"] : route === "POST /v1/ask" ? ["to", "message", "timeoutMs"] : ["to", "message"];
        input = object(await body(req, signal), fields);
      }
      let message: string | undefined;
      let to: string | undefined;
      let replyTo: string | undefined;
      let ids: string[] = [];
      let timeoutMs = ASK_TIMEOUT;
      if (["POST /v1/send", "POST /v1/ask", "POST /v1/reply"].includes(route)) message = text(input.message);
      if (["POST /v1/send", "POST /v1/ask"].includes(route)) to = label(input.to, "to").trim();
      if (route === "POST /v1/reply") replyTo = label(input.replyTo, "replyTo");
      if (route === "POST /v1/ask") {
        const timeout = input.timeoutMs === undefined ? ASK_TIMEOUT : input.timeoutMs;
        if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 100 || timeout > ASK_TIMEOUT) throw new Fault(400, "invalid_input", "timeoutMs must be an integer from 100 to 120000.");
        timeoutMs = timeout;
        setDeadline(timeoutMs + 15000);
      }
      if (route === "POST /v1/ack") {
        if (!Array.isArray(input.ids) || input.ids.length > INBOX_COUNT) throw new Fault(400, "invalid_input", "ids must be an array of at most 256 message IDs.");
        ids = [...new Set(input.ids.map((id) => label(id, "message ID")))];
      }
      session.guard(signal);
      if (route !== "POST /v1/ask") await session.connect(signal);
      let data: Record<string, unknown>;
      switch (route) {
        case "POST /v1/register": data = { sessionId: session.client.sessionId, name: identity.name }; break;
        case "GET /v1/list": {
          const sessions = await session.peers(signal);
          data = { sessionId: session.client.sessionId, sessions: sessions.map(({ topics: _topics, subscriptions: _subscriptions, ...entry }) => ({ ...entry, target: formatSessionTarget(entry, sessions) })) };
          break;
        }
        case "GET /v1/inbox": {
          const lostMessages = this.losses.get(identity.fingerprint256) ?? 0;
          data = { messages: [...session.inbox.values()].map(({ from, message }) => ({ from, message })), overflow: lostMessages > 0, lostMessages };
          break;
        }
        case "POST /v1/ack": {
          const acked: string[] = [];
          const retained: string[] = [];
          for (const id of ids) {
            const entry = session.inbox.get(id);
            if (entry?.message.expectsReply) retained.push(id);
            else if (entry) { session.remove(id); acked.push(id); }
          }
          session.presence();
          data = { acked, retained };
          break;
        }
        case "POST /v1/send": {
          peer = (await session.target(to!, signal)).id;
          data = { ...await session.send(peer, message!, signal, requestId) };
          break;
        }
        case "POST /v1/ask": data = await session.ask(to!, message!, timeoutMs, signal, requestId); break;
        case "POST /v1/reply": {
          const entry = session.inbox.get(replyTo!);
          if (!entry?.message.expectsReply) throw new Fault(404, "unknown_ask", "replyTo must identify an unanswered inbound ask.");
          if (entry.replying) throw new Fault(409, "reply_in_progress", "This ask already has a reply in flight.");
          entry.replying = true;
          peer = entry.from.id;
          try {
            const peers = await session.peers(signal);
            if (!peers.some((candidate) => candidate.id === peer)) throw new Fault(409, "peer_offline", "Original ask sender is disconnected.");
            session.guard(signal);
            if (session.inbox.get(replyTo!) !== entry) throw new Fault(409, "ask_retired", "Inbound ask is no longer replyable.");
            data = { ...await session.send(peer, message!, signal, requestId, { replyTo }) };
            session.remove(replyTo!);
            session.presence();
          } finally { entry.replying = false; }
          break;
        }
        default: throw new Fault(404, "not_found", "Unknown method or path.");
      }
      session.guard(signal);
      log("request", { ...session.fields(), requestId, peer, result: "ok" });
      reply(200, { ok: true, ...data });
    } catch (error) {
      const fault = error instanceof Fault ? error : new Fault(503, "broker_unavailable", "Local broker operation failed.");
      log("request", { ...session?.fields(), requestId, peer, result: fault.code });
      reply(fault.status, { ok: false, error: { code: fault.code, message: fault.message, ...fault.details } });
    } finally {
      clearTimeout(deadline);
      req.off("aborted", abort);
      res.off("close", onClose);
      if (controller) session?.requests.delete(controller);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    process.stdout.write("Usage: node dist/pi-intercom/bridge.js --config PATH\n\nOptional loopback HTTPS/mTLS bridge for the local pi-intercom broker.\nConfig and TLS key must be owned by you with mode 0600. Never starts the broker.\nSIGHUP reloads the client allowlist (invalid reload denies all clients).\nRestart this helper for TLS/listener rotation. SIGINT/SIGTERM disconnect peers.\n\nExample: node dist/pi-intercom/bridge.js --config ~/.pi/agent/intercom/bridge.json\n");
    return;
  }
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) {
    process.stderr.write("Usage: node dist/pi-intercom/bridge.js --config PATH (or --help)\n");
    process.exitCode = 2;
    return;
  }
  try {
    const path = resolve(args[1]);
    new Bridge(loadConfig(path), path).start();
  } catch {
    process.stderr.write("Bridge startup failed: check config schema, file ownership/mode 0600, absolute TLS/cwd paths, and TLS credentials.\n");
    process.exitCode = 1;
  }
}

main();
