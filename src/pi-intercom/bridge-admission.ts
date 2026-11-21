import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import type { Config, Identity } from "./bridge-config.ts";
import { fingerprint, log } from "./bridge-protocol.ts";
import { isRecord } from "../shared/unknown.ts";

function validCertificateDates(starts: number, expires: number): boolean {
  return (
    Number.isFinite(starts) &&
    Number.isFinite(expires) &&
    starts <= Date.now() &&
    expires > Date.now()
  );
}

/** The remote end, `address:port`, while the socket's handle is open. */
function remoteOf(socket: Socket): string | undefined {
  const { remoteAddress, remotePort } = socket;
  return remoteAddress === undefined || remotePort === undefined
    ? undefined
    : `${remoteAddress}:${remotePort}`;
}

export type Verdict =
  | { readonly identity: Identity; readonly expires: number }
  | {
      readonly reason: string;
      readonly fingerprint?: string | undefined;
      readonly name?: string | undefined;
    };

/** Decides whether the client certificate of a completed TLS handshake may use the bridge. */
export function verdict(socket: TLSSocket, clients: Config["clients"], stopping: boolean): Verdict {
  const cert = socket.getPeerX509Certificate();
  if (cert === undefined) {
    return { reason: "no_client_certificate" };
  }
  const fp = fingerprint(cert.fingerprint256);
  const identity = clients.get(fp);
  const expires = Date.parse(cert.validTo);
  const rejected = (reason: string): Verdict => ({ reason, fingerprint: fp, name: identity?.name });
  if (!socket.authorized) {
    // Node sets the OpenSSL verification code here, despite the declared Error type.
    const code: unknown = socket.authorizationError;
    return rejected(typeof code === "string" ? code : "certificate_untrusted");
  }
  if (identity === undefined) {
    return rejected("not_pinned");
  }
  if (!validCertificateDates(Date.parse(cert.validFrom), expires)) {
    return rejected("certificate_not_current");
  }
  return stopping ? rejected("shutting_down") : { identity, expires };
}

/**
 * Records TLS connections that end before authentication decides them. A connection that
 * closes without sending a byte is a TCP health probe, not an authentication attempt.
 */
export class Handshakes {
  /** Remote ends of TCP connections that have no authentication decision yet. */
  private readonly pending = new Set<string>();

  /** Follows a new TCP connection until authentication decides it or it closes. */
  opened(socket: Socket): void {
    const remote = remoteOf(socket);
    if (remote === undefined) {
      return;
    }
    this.pending.add(remote);
    socket.once("close", () => {
      if (this.pending.delete(remote) && socket.bytesRead > 0) {
        log("connection_rejected", {
          remote,
          result: "tls_authentication_failed",
          reason: "client_closed_during_handshake",
        });
      }
    });
  }

  /** Records a TLS failure on a connection that is still open. */
  failed(error: Error, socket: TLSSocket): void {
    const remote = remoteOf(socket);
    // Without a remote end the socket already closed, and opened() recorded it.
    if (remote !== undefined && this.pending.delete(remote)) {
      log("connection_rejected", {
        remote,
        result: "tls_authentication_failed",
        reason: isRecord(error) && typeof error.code === "string" ? error.code : "unknown",
      });
    }
  }

  /** Ends tracking of a completed handshake and returns its remote end for the audit. */
  decided(socket: TLSSocket): string | undefined {
    const remote = remoteOf(socket);
    if (remote !== undefined) {
      this.pending.delete(remote);
    }
    return remote;
  }

  /** Forgets connections the bridge is about to cut itself; the caller records why. */
  clear(): void {
    this.pending.clear();
  }
}
