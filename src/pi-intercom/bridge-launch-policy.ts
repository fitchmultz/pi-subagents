import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import { Fault, label, object, text } from "./bridge-protocol.ts";

export interface LaunchPolicy {
  readonly packageRoot: string;
  readonly cli: string;
  readonly sessionDir: string;
  readonly provider?: string;
  readonly model?: string;
  readonly workspaceRoots: readonly string[];
  readonly resumeDirs: readonly string[];
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
  const suffix = relative(packageRoot, cli);
  if (suffix.startsWith("..") || isAbsolute(suffix) || !statSync(cli).isFile()) {
    throw new Error("Pi bin must be a file inside the pinned package.");
  }
  return cli;
}
function extensions(value: unknown): readonly string[] {
  if (!isUnknownArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("Launch extensions must contain 1..32 local paths.");
  }
  return value.map((entry) => absolute(entry, "extension path"));
}

function directories(value: unknown, owned = true): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!isUnknownArray(value) || value.length > 32) {
    throw new Error("Launch roots must contain at most 32 local directories.");
  }
  return [
    ...new Set(
      value.map((entry) => {
        const path = absolute(entry, "trusted root");
        const stat = lstatSync(path);
        if (!stat.isDirectory() || (owned && stat.uid !== process.getuid?.())) {
          throw new Error("Launch roots must be owned directories.");
        }
        return path;
      }),
    ),
  ];
}

export function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix !== ".." &&
    !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(suffix)
  );
}
export function launchCwd(policy: LaunchPolicy, requested: string): string {
  if (!isAbsolute(requested)) {
    throw new Fault(400, "invalid_cwd", "cwd must be an absolute approved workspace directory.");
  }
  let cwd: string;
  try {
    cwd = realpathSync(requested);
    if (!statSync(cwd).isDirectory()) {
      throw new Error("Not a directory");
    }
  } catch {
    throw new Fault(400, "invalid_cwd", "cwd must be an existing workspace directory.");
  }
  if (!policy.workspaceRoots.some((root) => within(root, cwd))) {
    throw new Fault(403, "cwd_forbidden", "cwd is outside locally approved workspaceRoots.");
  }
  return cwd;
}

export function spawnPolicy(
  policy: LaunchPolicy,
  input: { readonly provider?: string; readonly model?: string },
): LaunchPolicy {
  if (input.model === undefined) {
    if (input.provider !== undefined) {
      throw new Fault(400, "invalid_input", "Spawn provider requires model.");
    }
    return policy;
  }
  // Native provider/model convention splits at the first slash; model IDs may contain further slashes.
  const slash = input.model.indexOf("/");
  const provider = input.provider ?? (slash > 0 ? input.model.slice(0, slash) : policy.provider);
  const model =
    input.provider === undefined && slash > 0 ? input.model.slice(slash + 1) : input.model;
  if (provider === undefined || provider.trim() === "" || model.trim() === "") {
    throw new Fault(
      400,
      "invalid_input",
      "Use an exact provider/model reference or a provider and model pair.",
    );
  }
  return { ...policy, provider: provider.trim(), model: model.trim() };
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
    "workspaceRoots",
    "resumeDirs",
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
  if ((raw.provider === undefined) !== (raw.model === undefined)) {
    throw new Error("Launch provider and model must both be supplied or both omitted.");
  }
  return {
    packageRoot,
    cli: executable(packageRoot),
    sessionDir,
    provider: raw.provider === undefined ? undefined : label(raw.provider, "provider", 128),
    model: raw.model === undefined ? undefined : label(raw.model, "model", 256),
    workspaceRoots: directories(raw.workspaceRoots, false),
    resumeDirs: directories(raw.resumeDirs),
    context: text(raw.context),
    extensions: extensions(raw.extensions),
    discoverResources: boolean(raw.discoverResources, false),
    trustProject: boolean(raw.trustProject, false),
    offline: boolean(raw.offline, false),
    maxSessions: bounded(raw.maxSessions, 4, 16),
    startupTimeoutMs: bounded(raw.startupTimeoutMs, 15000, 60000),
  };
}
