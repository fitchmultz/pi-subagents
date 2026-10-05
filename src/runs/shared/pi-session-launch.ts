import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlyInput } from "../../shared/types.ts";
import type { BuildPiArgsInput, BuildPiArgsResult } from "./pi-launch-input.ts";
import { prepareChildExecutionCwd } from "./child-execution-cwd.ts";
import { errorCode, isObject, nonempty } from "./child-json.ts";

const SESSION_CWD_PRELOAD_URL = new URL(
  `session-cwd-preload${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  import.meta.url,
).href;

// Read only the header; joining chunks before decoding preserves split UTF-8.
function readSessionHeaderLine(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT" && !fs.lstatSync(file, { throwIfNoEntry: false })) {
      return;
    }
    throw error;
  }
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    while (true) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (length === 0) {
        break;
      }
      const chunk = buffer.subarray(0, length);
      const newline = chunk.indexOf(10);
      chunks.push(Buffer.from(newline < 0 ? chunk : chunk.subarray(0, newline)));
      if (newline >= 0) {
        break;
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function needsCwdOverride(file: string, cwd: string): boolean {
  try {
    const line = readSessionHeaderLine(file);
    if (line === undefined) {
      return false; // A new session inherits the spawn cwd natively.
    }
    const header: unknown = JSON.parse(line);
    if (
      isObject(header) &&
      header.type === "session" &&
      typeof header.cwd === "string" &&
      path.isAbsolute(header.cwd)
    ) {
      return fs.realpathSync.native(header.cwd) !== fs.realpathSync.native(cwd);
    }
  } catch {
    // Unknown headers or unavailable directories still need the SDK override.
  }
  return true;
}

/** Prepare persistence before spawn without modifying an existing session header or identity. */
export function piSessionLaunch(input: ReadonlyInput<BuildPiArgsInput>): BuildPiArgsResult {
  const args: string[] = [];
  const env: Record<string, string | undefined> = {};
  if (!nonempty(input.sessionFile)) {
    if (!input.sessionEnabled) {
      args.push("--no-session");
    }
    if (nonempty(input.sessionDir)) {
      fs.mkdirSync(input.sessionDir, { recursive: true });
      args.push("--session-dir", input.sessionDir);
    }
    return { args, env };
  }
  prepareChildExecutionCwd(input.sessionFile, input.cwd);
  fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
  args.push("--session", input.sessionFile);
  if (nonempty(input.cwd) && needsCwdOverride(input.sessionFile, input.cwd)) {
    env.PI_SUBAGENT_SESSION_CWD = JSON.stringify({
      sessionFile: path.resolve(input.cwd, input.sessionFile),
      cwd: input.cwd,
      nodeOptions: process.env.NODE_OPTIONS,
    });
    env.NODE_OPTIONS =
      `${process.env.NODE_OPTIONS ?? ""} --import=${SESSION_CWD_PRELOAD_URL}`.trim();
  }
  return { args, env };
}
