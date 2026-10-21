import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonProjection } from "../shared/journal-frames.ts";
import { Assert } from "./typebox.ts";
import type { Static, TSchema } from "typebox";
import { launchSchema, successorSchema, type Launch, type Command } from "./contracts.ts";

export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function read<T extends TSchema>(file: string, schema: T): Static<T> | undefined {
  let value: unknown;
  try {
    value = readJsonProjection(file, () => true);
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
  Assert(schema, value);
  // TypeBox's generic Static<T> is intentionally the asserted schema's type.
  // oxlint-disable-next-line typescript/no-unsafe-return
  return value;
}
export function write(file: string, value: unknown, exclusive = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (exclusive) {
      fs.linkSync(temp, file);
    } else {
      fs.renameSync(temp, file);
    }
  } finally {
    fs.rmSync(temp, { force: true });
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
export function enqueue(
  base: string,
  launch: Launch,
  action: Command["action"],
  prompt?: string,
): string {
  const id = action === "run" ? launch.id : randomUUID();
  const command: Command = { id, runId: launch.id, action, prompt, createdAt: Date.now() };
  write(path.join(conversation(base, launch), "commands", `${id}.json`), command, true);
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
