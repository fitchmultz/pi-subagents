import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { write } from "./storage.ts";

type Request = {
  sessionManager: ExtensionContext["sessionManager"];
  path?: string;
  result?: { cwd?: string; error?: string };
};
export function localCwdOwner(source: { source: string; path: string }): boolean {
  return /(?:^|[/\\:@])(?:pi-)?change-working-dir(?:[/\\@:.>]|$)/.test(
    `${source.source}/${source.path}`,
  );
}
function hasOwner(pi: ExtensionAPI): boolean {
  return (
    pi.getAllTools().some((tool) => tool.name === "change_dir" || localCwdOwner(tool.sourceInfo)) ||
    pi
      .getCommands()
      .some(
        (command) =>
          command.source === "extension" &&
          (/^cwd(?::\d+)?$/.test(command.name) || localCwdOwner(command.sourceInfo)),
      )
  );
}
function reply(request: Request): string | undefined {
  if (request.result?.error !== undefined && request.result.error !== "") {
    throw new Error(request.result.error);
  }
  if (request.result && (request.result.cwd === undefined || request.result.cwd === "")) {
    throw new Error("Directory owner returned no execution directory.");
  }
  return request.result?.cwd;
}
export function executionCwd(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const request: Request = { sessionManager: ctx.sessionManager };
  pi.events.emit("pi-change-working-dir:resolve-execution-cwd", request);
  const cwd = reply(request);
  if (cwd === undefined && hasOwner(pi)) {
    throw new Error("Loaded directory owner did not resolve cwd; update pi-change-working-dir.");
  }
  return cwd ?? ctx.cwd;
}
export function initializeCwd(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cwd: string,
  directory: string,
): void {
  // A saved continuation restores its owner's latest selection, not its frozen launch directory.
  const current = executionCwd(pi, ctx);
  const marker = path.join(directory, "cwd-initialized.json");
  if (fs.existsSync(marker)) {
    return;
  }
  if (hasOwner(pi) || fs.realpathSync(current) !== fs.realpathSync(ctx.cwd)) {
    const request: Request = { sessionManager: ctx.sessionManager, path: cwd };
    pi.events.emit("pi-change-working-dir:set-execution-cwd", request);
    const selected = reply(request);
    if (selected === undefined || fs.realpathSync(selected) !== fs.realpathSync(cwd)) {
      throw new Error("Directory owner did not initialize the requested child cwd.");
    }
  } else if (fs.realpathSync(ctx.cwd) !== fs.realpathSync(cwd)) {
    throw new Error("Native child directory does not match launch cwd.");
  }
  write(marker, { cwd }, true);
}
