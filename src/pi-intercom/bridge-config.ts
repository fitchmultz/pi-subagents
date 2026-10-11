import { constants, closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createSecureContext } from "node:tls";
import { isUnknownArray } from "../shared/unknown.ts";
import { BODY_LIMIT, object, label, fingerprint } from "./bridge-protocol.ts";

const MAX_CLIENTS = 64;

export interface Identity {
  readonly fingerprint256: string;
  readonly name: string;
  readonly cwd: string;
}
export interface Config {
  readonly port: number;
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
  readonly clients: Readonly<ReadonlyMap<string, Identity>>;
  readonly tls: { readonly ca: Buffer; readonly cert: Buffer; readonly key: Buffer };
}

function readFile(path: string, privateFile: boolean, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) {
      throw new Error("Configuration/TLS file must be a bounded regular file.");
    }
    if (privateFile && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)) {
      throw new Error("Config and TLS key must be owned by the current user with mode 0600.");
    }
    const data = readFileSync(fd);
    if (data.length > limit) {
      throw new Error("Configuration/TLS file exceeds its size limit.");
    }
    return data;
  } finally {
    closeSync(fd);
  }
}

function identities(value: unknown): Map<string, Identity> {
  if (!isUnknownArray(value) || value.length > MAX_CLIENTS) {
    throw new Error(`clients must be an array of at most ${MAX_CLIENTS} identities.`);
  }
  const clients = new Map<string, Identity>();
  const names = new Set<string>();
  for (const raw of value) {
    const entry = object(raw, ["fingerprint256", "name", "cwd"]);
    const fingerprint256 = fingerprint(entry.fingerprint256);
    const name = label(entry.name, "name", 128).trim();
    const cwd = label(entry.cwd, "cwd", 4096);
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error("Client cwd must be an existing absolute directory.");
    }
    if (clients.has(fingerprint256) || names.has(name.toLowerCase())) {
      throw new Error("Client fingerprints and names must be unique.");
    }
    clients.set(fingerprint256, { fingerprint256, name, cwd });
    names.add(name.toLowerCase());
  }
  return clients;
}

export function loadConfig(path: string): Config {
  const raw: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(readFile(path, true, BODY_LIMIT)),
  );
  const input = object(raw, ["port", "ca", "cert", "key", "clients"]);
  const port = input.port === undefined ? 9443 : input.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid HTTPS port.");
  }
  const ca = label(input.ca, "ca path", 4096);
  const cert = label(input.cert, "cert path", 4096);
  const key = label(input.key, "key path", 4096);
  if (![ca, cert, key].every(isAbsolute)) {
    throw new Error("TLS paths must be absolute.");
  }
  const clients = identities(input.clients);
  const tls = {
    ca: readFile(ca, false, 1024 * 1024),
    cert: readFile(cert, false, 1024 * 1024),
    key: readFile(key, true, 1024 * 1024),
  };
  createSecureContext({ ...tls, minVersion: "TLSv1.2" });
  return { port, ca, cert, key, clients, tls };
}

export function sameListener(next: Config, current: Config): boolean {
  return (
    next.port === current.port &&
    next.ca === current.ca &&
    next.cert === current.cert &&
    next.key === current.key &&
    next.tls.ca.equals(current.tls.ca) &&
    next.tls.cert.equals(current.tls.cert) &&
    next.tls.key.equals(current.tls.key)
  );
}
