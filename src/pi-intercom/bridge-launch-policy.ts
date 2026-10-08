import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import { label, object, text } from "./bridge-protocol.ts";

export interface LaunchPolicy {
  readonly packageRoot: string;
  readonly cli: string;
  readonly sessionDir: string;
  readonly provider: string;
  readonly model: string;
  readonly context: string;
  readonly extensions: readonly string[];
  readonly discoverResources: boolean;
  readonly trustProject: boolean;
  readonly offline: boolean;
  readonly maxSessions: number;
  readonly startupTimeoutMs: number;
}

function absolute(value: unknown, field: string): string {
  const path = label(value, field, 4096);
  if (!isAbsolute(path)) {
    throw new Error(`${field} must be absolute.`);
  }
  return realpathSync(path);
}
function bounded(value: unknown, fallback: number, max: number): number {
  const number = value ?? fallback;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) {
    throw new Error("Invalid launch limit.");
  }
  return number;
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error("Launch switches must be boolean.");
  }
  return value;
}
function executable(packageRoot: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (
    !isRecord(manifest) ||
    manifest.name !== "@earendil-works/pi-coding-agent" ||
    !isRecord(manifest.bin)
  ) {
    throw new Error("Launch package must be an installed Pi package.");
  }
  const bin = label(manifest.bin.pi, "Pi manifest bin", 4096);
  const cli = realpathSync(join(packageRoot, bin));
  const within = relative(packageRoot, cli);
  if (within.startsWith("..") || isAbsolute(within) || !statSync(cli).isFile()) {
    throw new Error("Pi bin must be a file inside the pinned package.");
  }
  return cli;
}
function extensions(value: unknown): readonly string[] {
  if (!isUnknownArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("Launch extensions must include Intercom (1..32 local paths).");
  }
  return value.map((entry) => absolute(entry, "extension path"));
}

export function launchPolicy(value: unknown): LaunchPolicy | undefined {
  if (value === undefined) {
    return;
  }
  const raw = object(value, [
    "packageRoot",
    "sessionDir",
    "provider",
    "model",
    "context",
    "extensions",
    "discoverResources",
    "trustProject",
    "offline",
    "maxSessions",
    "startupTimeoutMs",
  ]);
  const packageRoot = absolute(raw.packageRoot, "Pi package root");
  const sessionDir = absolute(raw.sessionDir, "session directory");
  const storage = lstatSync(sessionDir);
  if (
    !storage.isDirectory() ||
    storage.uid !== process.getuid?.() ||
    (storage.mode & 0o777) !== 0o700
  ) {
    throw new Error("Launch storage must be an owned directory with mode 0700.");
  }
  return {
    packageRoot,
    cli: executable(packageRoot),
    sessionDir,
    provider: label(raw.provider, "provider", 128),
    model: label(raw.model, "model", 256),
    context: text(raw.context),
    extensions: extensions(raw.extensions),
    discoverResources: boolean(raw.discoverResources, false),
    trustProject: boolean(raw.trustProject, false),
    offline: boolean(raw.offline, false),
    maxSessions: bounded(raw.maxSessions, 4, 16),
    startupTimeoutMs: bounded(raw.startupTimeoutMs, 15000, 60000),
  };
}
