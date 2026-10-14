import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createSecureContext } from "node:tls";
import { parseEnv } from "node:util";
import { isUnknownArray } from "../shared/unknown.ts";
import { BODY_LIMIT, object, label, fingerprint } from "./bridge-protocol.ts";
import { launchPolicy, type LaunchPolicy } from "./bridge-launch-policy.ts";
import { stateDirectory } from "./bridge-mailbox.ts";
import { readBridgeFile } from "./bridge-files.ts";

const MAX_CLIENTS = 64;

export interface WakePolicy {
  readonly envFile: string;
  readonly url: string;
  readonly key: string;
}

function wakePolicy(value: unknown): WakePolicy | undefined {
  if (value === undefined) {
    return;
  }
  const input = object(value, ["envFile"]);
  const envFile = label(input.envFile, "wake credential file", 4096);
  if (!isAbsolute(envFile)) {
    throw new Error("Wake credential file must be absolute.");
  }
  const env = parseEnv(readBridgeFile(envFile, true, 16384).toString("utf8"));
  const url = new URL(label(env.GROK_WAKE_WEBHOOK_URL, "wake webhook URL", 8192));
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("Wake webhook requires HTTPS without URL credentials or a fragment.");
  }
  return {
    envFile,
    url: url.href,
    key: label(env.GROK_WAKE_WEBHOOK_KEY, "wake webhook key", 4096),
  };
}

export interface Identity {
  readonly fingerprint256: string;
  readonly name: string;
  readonly cwd: string;
  readonly launch?: LaunchPolicy;
  readonly wake?: WakePolicy;
}
export interface Config {
  readonly stateDir?: string;
  readonly port: number;
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
  readonly clients: Readonly<ReadonlyMap<string, Identity>>;
  readonly tls: { readonly ca: Buffer; readonly cert: Buffer; readonly key: Buffer };
}

function identities(value: unknown): Map<string, Identity> {
  if (!isUnknownArray(value) || value.length > MAX_CLIENTS) {
    throw new Error(`clients must be an array of at most ${MAX_CLIENTS} identities.`);
  }
  const clients = new Map<string, Identity>();
  const names = new Set<string>();
  for (const raw of value) {
    const entry = object(raw, ["fingerprint256", "name", "cwd", "launch", "wake"]);
    const fingerprint256 = fingerprint(entry.fingerprint256);
    const name = label(entry.name, "name", 128).trim();
    const cwd = label(entry.cwd, "cwd", 4096);
    if (!isAbsolute(cwd)) {
      throw new Error("Client cwd must be absolute.");
    }
    const launch = launchPolicy(entry.launch);
    if (launch && !statSync(cwd).isDirectory()) {
      throw new Error("Launch cwd must be an existing directory.");
    }
    if (clients.has(fingerprint256) || names.has(name.toLowerCase())) {
      throw new Error("Client fingerprints and names must be unique.");
    }
    clients.set(fingerprint256, {
      fingerprint256,
      name,
      cwd: launch ? realpathSync(cwd) : cwd,
      launch,
      wake: wakePolicy(entry.wake),
    });
    names.add(name.toLowerCase());
  }
  return clients;
}

export function loadConfig(path: string): Config {
  const raw: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(readBridgeFile(path, true, BODY_LIMIT)),
  );
  const input = object(raw, ["port", "ca", "cert", "key", "clients", "stateDir"]);
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
    ca: readBridgeFile(ca, false, 1024 * 1024),
    cert: readBridgeFile(cert, false, 1024 * 1024),
    key: readBridgeFile(key, true, 1024 * 1024),
  };
  createSecureContext({ ...tls, minVersion: "TLSv1.2" });
  const stateDir = stateDirectory(input.stateDir);
  if (stateDir === undefined && [...clients.values()].some((identity) => identity.wake)) {
    throw new Error("Wake delivery requires a durable stateDir.");
  }
  return { port, ca, cert, key, clients, tls, stateDir };
}

export function sameListener(next: Config, current: Config): boolean {
  return (
    next.stateDir === current.stateDir &&
    next.port === current.port &&
    next.ca === current.ca &&
    next.cert === current.cert &&
    next.key === current.key &&
    next.tls.ca.equals(current.tls.ca) &&
    next.tls.cert.equals(current.tls.cert) &&
    next.tls.key.equals(current.tls.key)
  );
}
