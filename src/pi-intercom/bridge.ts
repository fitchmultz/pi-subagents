import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import { getBrokerSocketPath } from "./broker/paths.ts";
import { loadConfig, sameListener, type Config, type Identity } from "./bridge-config.ts";
import { ASK_TIMEOUT, Fault, fingerprint, log } from "./bridge-protocol.ts";
import { Session } from "./bridge-session.ts";
import { operationFor, routeFor } from "./bridge-routes.ts";
import { reply, replyFault } from "./bridge-http.ts";
import { sameIdentity } from "./bridge-launch.ts";
import { BridgeOperations } from "./bridge-operations.ts";
import { authenticatedCertificateChain } from "./native-control-auth.ts";
import { PersistentPresence } from "./bridge-presence.ts";
import { WakeDeliveries } from "./bridge-wake.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";

const MAX_CONNECTIONS = 128;
const LONG_ROUTES = new Set([
  "POST /v1/start",
  "POST /v1/spawn",
  "POST /v1/resume",
  "GET /v1/transcript",
  "POST /v1/transcript",
]);

function validCertificateDates(starts: number, expires: number): boolean {
  return (
    Number.isFinite(starts) &&
    Number.isFinite(expires) &&
    starts <= Date.now() &&
    expires > Date.now()
  );
}

interface Connection {
  readonly fingerprint: string;
  readonly expires: number;
  timer: NodeJS.Timeout;
}

class Bridge {
  private config: Config;
  private readonly configPath: string;
  private readonly sessions = new Map<string, Session>();
  private readonly losses = new Map<string, number>();
  private readonly operations: BridgeOperations;
  private readonly sockets = new Set<Socket>();
  private readonly connections = new Map<TLSSocket, Connection>();
  private readonly server: Server;
  private stopping = false;
  private readonly handlers = new Set<Promise<void>>();
  private readonly presence?: PersistentPresence;
  private readonly deliveries: WakeDeliveries;

  constructor(config: Config, configPath: string) {
    this.config = config;
    this.configPath = configPath;
    this.operations = new BridgeOperations(config.stateDir);
    this.deliveries = new WakeDeliveries(config.stateDir, (identity) => this.allowed(identity));
    if (config.stateDir !== undefined) {
      this.presence = new PersistentPresence({
        stateDir: config.stateDir,
        clients: () => this.config.clients,
        connect: async (identity, expires) => {
          await spawnBrokerIfNeeded(process.execPath, []);
          if (!this.allowed(identity)) {
            return;
          }
          const session = this.session(identity, expires);
          const controller = session.begin();
          try {
            await session.connectedPeers(controller.signal);
          } finally {
            session.end(controller);
          }
        },
      });
    }
    this.server = createServer(
      {
        ...config.tls,
        minVersion: "TLSv1.2",
        requestCert: true,
        rejectUnauthorized: true,
        handshakeTimeout: 10000,
      },
      (req, res) => {
        const handler = this.handle(req, res).catch(() => {
          // A response write can fail after route handling; close transport and retain metadata only.
          res.destroy();
          log("request", { result: "transport_failed" });
        });
        this.handlers.add(handler);
        handler
          .finally(() => {
            this.handlers.delete(handler);
          })
          .catch(() => {
            res.destroy();
          });
      },
    );
    this.server.maxConnections = MAX_CONNECTIONS;
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
    this.server.keepAliveTimeout = 5000;
    this.server.maxRequestsPerSocket = 100;
    this.server.maxHeadersCount = 32;
    this.server.on("connection", (socket: Socket) => {
      if (this.stopping || this.sockets.size >= MAX_CONNECTIONS) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once("close", () => {
        this.sockets.delete(socket);
      });
    });
    this.server.on("secureConnection", (socket: TLSSocket) => this.authenticate(socket));
    this.server.on("tlsClientError", () =>
      log("connection_rejected", { result: "tls_authentication_failed" }),
    );
    this.server.on("clientError", (_error, socket) => {
      socket.destroy();
    });
    this.server.on("error", () => {
      log("server_error", { result: "listener_failed" });
      process.exitCode = 1;
      this.stop();
    });
  }
  private allowed(identity: Identity): boolean {
    const current = this.config.clients.get(identity.fingerprint256);
    return (
      !this.stopping &&
      sameIdentity(identity, current) &&
      JSON.stringify(identity.wake) === JSON.stringify(current?.wake)
    );
  }
  private lost(fp: string, count = 1): void {
    if (count > 0 && this.config.clients.has(fp)) {
      this.losses.set(fp, Math.min(Number.MAX_SAFE_INTEGER, (this.losses.get(fp) ?? 0) + count));
    }
  }
  private session(identity: Identity, expires: number): Session {
    this.deliveries.session(identity, expires);
    let session = this.sessions.get(identity.fingerprint256);
    if (!session) {
      session = new Session(
        {
          stateDir: this.config.stateDir,
          notifications: identity.wake !== undefined,
          allowed: (candidate) => this.allowed(candidate),
          lost: (fp, count) => this.lost(fp, count),
          losses: (fp) => this.losses.get(fp) ?? 0,
          retired: (fp, generation) => {
            if (this.sessions.get(fp)?.generation === generation) {
              this.sessions.delete(fp);
            }
          },
        },
        identity,
        expires,
      );
      this.sessions.set(identity.fingerprint256, session);
    }
    return session;
  }
  private authenticate(socket: TLSSocket): void {
    const cert = socket.getPeerCertificate();
    let fp: string;
    try {
      fp = fingerprint(cert.fingerprint256);
    } catch {
      socket.destroy();
      return;
    }
    const identity = this.config.clients.get(fp);
    const expires = Date.parse(cert.valid_to);
    const starts = Date.parse(cert.valid_from);
    if (
      !socket.authorized ||
      !identity ||
      this.stopping ||
      !validCertificateDates(starts, expires)
    ) {
      log("connection_rejected", { fingerprint: fp, result: "unauthorized" });
      socket.destroy();
      return;
    }
    try {
      this.presence?.authenticated(identity, expires);
    } catch {
      log("connection_rejected", { fingerprint: fp, result: "presence_storage_failed" });
      socket.destroy();
      return;
    }
    const expiry = () => {
      if (expires <= Date.now()) {
        this.drop(fp, new Fault(403, "certificate_expired", "Client certificate expired."));
        return;
      }
      connection.timer = setTimeout(expiry, Math.min(expires - Date.now(), 0x7fffffff));
    };
    // Node timers must recheck long-lived certificates in INT32_MAX-bounded slices.
    const connection: Connection = {
      fingerprint: fp,
      expires,
      timer: setTimeout(expiry, Math.min(expires - Date.now(), 0x7fffffff)),
    };
    this.connections.set(socket, connection);
    socket.once("close", () => {
      clearTimeout(connection.timer);
      this.connections.delete(socket);
    });
    log("connected", { name: identity.name, fingerprint: fp, result: "authenticated" });
  }
  private drop(fp: string, error: Readonly<Fault>): void {
    this.deliveries.drop(fp);
    this.sessions.get(fp)?.close(error);
    for (const [socket, connection] of this.connections) {
      if (connection.fingerprint === fp) {
        socket.destroy();
      }
    }
  }
  start(): void {
    this.server.listen(this.config.port, "127.0.0.1", () => {
      const address = this.server.address();
      log("listening", {
        result: "ready",
        host: "127.0.0.1",
        pid: process.pid,
        port: typeof address === "object" && address ? address.port : this.config.port,
        brokerSocket: getBrokerSocketPath(),
      });
      this.presence?.start();
    });
    process.on("SIGHUP", () => this.reload());
    // Retain listeners during dispatch: selected SDK dependencies use signal-exit's listener check.
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }
  private reload(): void {
    if (this.stopping) {
      return;
    }
    try {
      const next = loadConfig(this.configPath);
      if (!sameListener(next, this.config)) {
        throw new Error("TLS/listener rotation requires restarting the helper.");
      }
      this.config = next;
      this.revokeRemoved();
      this.operations.revoke(next.clients).catch(() => log("launch_cleanup", { result: "failed" }));
      log("allowlist_reloaded", { result: "accepted", clients: next.clients.size });
    } catch {
      this.config = { ...this.config, clients: new Map() };
      this.deliveries.reload();
      this.operations
        .revoke(this.config.clients)
        .catch(() => log("launch_cleanup", { result: "failed" }));
      for (const session of this.sessions.values()) {
        session.close(
          new Fault(
            503,
            "configuration_invalid",
            "Configuration reload failed; all identities denied.",
          ),
        );
      }
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.losses.clear();
      log("allowlist_reloaded", { result: "failed_closed" });
    }
  }
  private revokeRemoved(): void {
    this.deliveries.reload();
    for (const [fp, session] of this.sessions) {
      if (!this.allowed(session.identity)) {
        this.drop(
          fp,
          new Fault(403, "revoked", "Identity revoked or changed by configuration reload."),
        );
      }
    }
    for (const connection of this.connections.values()) {
      if (!this.config.clients.has(connection.fingerprint)) {
        this.drop(connection.fingerprint, new Fault(403, "revoked", "Identity revoked."));
      }
    }
    for (const fp of this.losses.keys()) {
      if (!this.config.clients.has(fp)) {
        this.losses.delete(fp);
      }
    }
  }
  private stop(): void {
    this.shutdown().catch(() => {
      process.exitCode = 1;
      log("shutdown", { result: "cleanup_failed" });
    });
  }
  private async shutdown(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.server.close();
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      session.close(new Fault(503, "shutting_down", "Bridge is shutting down."));
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await Promise.all([
      ...this.handlers,
      ...sessions.map((session) => session.settled()),
      this.operations.shutdown(),
      this.presence?.stop(),
      this.deliveries.stop(),
    ]);
    log("shutdown", { result: "closed" });
  }
  private admission(req: IncomingMessage): {
    readonly identity: Identity;
    readonly expires: number;
    readonly certificate: string;
  } {
    const socket = req.socket;
    const connection = socket instanceof TLSSocket ? this.connections.get(socket) : undefined;
    const identity = connection && this.config.clients.get(connection.fingerprint);
    if (
      !connection ||
      !identity ||
      !(socket instanceof TLSSocket) ||
      !socket.authorized ||
      this.stopping
    ) {
      throw new Fault(403, "unauthorized", "Client certificate is not authorized.");
    }
    if (connection.expires <= Date.now()) {
      const fault = new Fault(403, "certificate_expired", "Client certificate expired.");
      this.drop(connection.fingerprint, fault);
      throw fault;
    }
    return {
      identity,
      expires: connection.expires,
      certificate: authenticatedCertificateChain(socket),
    };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    let session: Session | undefined;
    let controller: AbortController | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let peer: string | undefined;
    const abort = () =>
      session?.close(
        new Fault(499, "client_aborted", "HTTP client disconnected; delivery may be unknown."),
      );
    const onClose = () => {
      if (!res.writableFinished) {
        abort();
      }
    };
    const setDeadline = (ms: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(
        () =>
          session?.close(
            new Fault(
              504,
              "request_timeout",
              "HTTP operation deadline exceeded; delivery may be unknown.",
            ),
          ),
        Math.max(1, ms - (Date.now() - started)),
      );
    };
    try {
      const { identity, expires, certificate } = this.admission(req);
      const route = routeFor(req);
      session = this.session(identity, expires);
      controller = session.begin();
      const signal = controller.signal;
      req.once("aborted", abort);
      res.once("close", onClose);
      const duration = route === "POST /v1/ask" ? ASK_TIMEOUT + 15000 : 15000;
      setDeadline(LONG_ROUTES.has(route) ? 75000 : duration);
      const operation = await operationFor(req, route, signal);
      if (operation.route === "POST /v1/ask") {
        setDeadline(operation.timeoutMs + 15000);
      } else if (operation.route === "GET /v1/transcript") {
        setDeadline(75000);
      }
      const data = await this.operations.execute(operation, session, {
        signal,
        requestId,
        expires,
        certificate,
        onPeer: (id) => {
          peer = id;
        },
      });
      session.guard(signal);
      log("request", { ...session.fields(), requestId, peer, result: "ok" });
      reply(res, requestId, 200, { ok: true, ...data });
    } catch (error) {
      const fault =
        error instanceof Fault
          ? error
          : new Fault(503, "broker_unavailable", "Local broker operation failed.");
      log("request", { ...session?.fields(), requestId, peer, result: fault.code });
      replyFault(res, requestId, fault);
    } finally {
      clearTimeout(deadline);
      req.off("aborted", abort);
      res.off("close", onClose);
      if (controller && session) {
        session.end(controller);
      }
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    process.stdout.write(
      "Usage: node dist/pi-intercom/bridge.js --config PATH\n\nOptional loopback HTTPS/mTLS bridge for the local pi-intercom broker.\nConfig and TLS key must be owned by you with mode 0600.\nWithout stateDir, messaging never starts the broker. Durable presence safely starts\none only when none is running; it never restarts or replaces a live broker.\nSIGHUP reloads the client allowlist (invalid reload denies all clients).\nRestart this helper for TLS/listener rotation. SIGINT/SIGTERM disconnect peers.\n\nExample: node dist/pi-intercom/bridge.js --config ~/.pi/agent/intercom/bridge.json\n",
    );
    return;
  }
  if (args.length !== 2 || args[0] !== "--config" || args[1] === "") {
    process.stderr.write("Usage: node dist/pi-intercom/bridge.js --config PATH (or --help)\n");
    process.exitCode = 2;
    return;
  }
  try {
    const path = resolve(args[1]);
    new Bridge(loadConfig(path), path).start();
  } catch {
    process.stderr.write(
      "Bridge startup failed: check config schema, file ownership/mode 0600, absolute TLS/cwd paths, TLS credentials, stateDir (owned 0700 directory), and launch policy (0700 sessionDir, Pi packageRoot, extension paths).\n",
    );
    process.exitCode = 1;
  }
}
main();
