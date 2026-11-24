import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Schema, Validator } from "@earendil-works/pi-schema";
import { readJsonProjection } from "../shared/journal-frames.ts";
import type { Projection } from "../shared/json-projection.ts";
import { assertValid } from "../shared/schema.ts";
import {
  launchSchema,
  successorSchema,
  type Command,
  type Launch,
  type OverseerLaunch,
} from "./contracts.ts";
import { hasErrorCode } from "../shared/unknown.ts";
import { notifyInventory } from "./inventory-events.ts";

export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function read<T>(
  file: string,
  schema: Schema<T> | Validator<T>,
  select: Projection = () => true,
): T | undefined {
  let value: unknown;
  try {
    value = readJsonProjection(file, select);
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
  assertValid(schema, value);
  return value;
}

function publishExclusive(temp: string, file: string): boolean {
  try {
    fs.linkSync(temp, file);
    return false;
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOTSUP"].some((code) => hasErrorCode(error, code))) {
      throw error;
    }
    fs.symlinkSync(path.basename(temp), file);
    return true;
  }
}

export function write(file: string, value: unknown, exclusive = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.${exclusive ? "data" : "tmp"}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  let retained = false;
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (exclusive) {
      retained = publishExclusive(temp, file);
    } else {
      fs.renameSync(temp, file);
    }
  } finally {
    if (!retained) {
      fs.rmSync(temp, { force: true });
    }
  }
}

export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Invalid run/session ID.");
  }
  return id;
}

export function ownerDirectory(agentDir: string, owner: string): string {
  return path.join(agentDir, "sessions", "agent-runs", safeId(owner));
}

export function runDirectory(base: string, id: string): string {
  return path.join(base, safeId(id));
}

export function launchAt(base: string, id: string, owner: string): Launch {
  const launch = read(path.join(runDirectory(base, id), "launch.json"), launchSchema);
  if (!launch || launch.id !== id || launch.owner !== owner) {
    throw new Error("Missing saved launch or foreign run owner; nothing was launched.");
  }
  return launch;
}

export interface SuccessorOptions {
  /** Overrides inherited overseer config on the successor (`null` clears it). */
  readonly overseer?: OverseerLaunch | null | undefined;
}

function buildSuccessorLaunch(input: {
  readonly launch: Launch;
  readonly id: string;
  readonly prompt: string;
  readonly options: SuccessorOptions | undefined;
}): Launch {
  const { launch, id, prompt, options } = input;
  const { overseer: inheritedOverseer, ...rest } = launch;
  const overseer =
    options?.overseer === undefined ? inheritedOverseer : (options.overseer ?? undefined);
  return {
    ...rest,
    id,
    predecessor: launch.id,
    prompt,
    ...(overseer !== undefined ? { overseer } : {}),
    createdAt: Date.now(),
  };
}

export function successor(
  base: string,
  launch: Launch,
  prompt: string,
  options?: SuccessorOptions,
): Launch | undefined {
  const id = randomUUID();
  const next = buildSuccessorLaunch({ launch, id, prompt, options });
  fs.mkdirSync(runDirectory(base, id), { mode: 0o700 });
  write(path.join(runDirectory(base, id), "launch.json"), next, true);
  try {
    write(path.join(runDirectory(base, launch.id), "successor.json"), { id }, true);
  } catch (error) {
    fs.rmSync(runDirectory(base, id), { recursive: true });
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    return undefined;
  }
  return next;
}

export function latest(base: string, initial: Launch): Launch {
  const seen = new Set<string>();
  let launch = initial;
  for (;;) {
    if (seen.has(launch.id)) {
      throw new Error("Cyclic saved continuation.");
    }
    seen.add(launch.id);
    const next = read(path.join(runDirectory(base, launch.id), "successor.json"), successorSchema);
    if (!next) {
      return launch;
    }
    launch = launchAt(base, next.id, initial.owner);
  }
}

export function conversation(base: string, launch: Launch): string {
  return runDirectory(base, launch.rootId);
}

export function commandIdentity(file: string): string | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
}

export function enqueue(
  base: string,
  launch: Launch,
  input:
    | { readonly action: "run" }
    | { readonly action: "steer"; readonly prompt: string; readonly id?: string | undefined }
    | { readonly action: "stop"; readonly actorToken: string },
): string {
  let id: string;
  if (input.action === "run") {
    id = launch.id;
  } else if (input.action === "steer") {
    id = input.id ?? randomUUID();
  } else {
    id = randomUUID();
  }
  const command: Command =
    input.action === "steer"
      ? { id, runId: launch.id, action: "steer", prompt: input.prompt, createdAt: Date.now() }
      : { id, runId: launch.id, ...input, createdAt: Date.now() };
  write(path.join(conversation(base, launch), "commands", `${id}.json`), command, true);
  if (input.action === "steer") {
    notifyInventory(base, launch.id);
  }
  return id;
}

export function list(base: string): string[] {
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          fs.lstatSync(path.join(base, e.name, "launch.json"), { throwIfNoEntry: false }) !==
            undefined,
      )
      .map((e) => e.name);
  } catch (error) {
    if (missing(error)) {
      return [];
    }
    throw error;
  }
}
