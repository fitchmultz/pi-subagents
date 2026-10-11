import * as fs from "node:fs";
import * as path from "node:path";
import {
  hasErrorCode,
  errorMessage as errorText,
  isRecord as isObject,
} from "../../shared/unknown.ts";
import { nonempty } from "./child-presence.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RESOLVE_CWD = "pi-change-working-dir:resolve-execution-cwd";
const SET_CWD = "pi-change-working-dir:set-execution-cwd";
const intentPath = (sessionFile: string): string => `${sessionFile}.subagent-cwd-init`;
type CwdIntent = { readonly cwd?: string };
type CwdRequest = {
  sessionManager: ExtensionContext["sessionManager"];
  path?: string;
  result?: { cwd: string; error?: string };
};

/** Call once for a new fork or explicit resume override; undo only if launch fails before starting. */
export function requestChildExecutionCwd(sessionFile: string, cwd?: string): () => void {
  if (cwd !== undefined && !path.isAbsolute(cwd)) {
    throw new Error("Child execution cwd must be absolute.");
  }
  const previous = readIntent(sessionFile);
  fs.writeFileSync(intentPath(sessionFile), JSON.stringify({ cwd }), { mode: 0o600 });
  return () => {
    if (previous) {
      fs.writeFileSync(intentPath(sessionFile), JSON.stringify(previous), { mode: 0o600 });
    } else {
      fs.unlinkSync(intentPath(sessionFile));
    }
  };
}

function readIntent(sessionFile: string): CwdIntent | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(intentPath(sessionFile), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (
    !isObject(value) ||
    ("cwd" in value && (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)))
  ) {
    throw new Error("Invalid child execution cwd initialization request.");
  }
  return { cwd: "cwd" in value && typeof value.cwd === "string" ? value.cwd : undefined };
}

/** Freeze the new fork's requested directory once the actual launch cwd is known. */
export function prepareChildExecutionCwd(sessionFile: string, cwd?: string): void {
  const intent = readIntent(sessionFile);
  if (intent && intent.cwd === undefined) {
    if (!nonempty(cwd)) {
      throw new Error("New fork execution cwd was not supplied.");
    }
    requestChildExecutionCwd(sessionFile, cwd);
  }
}

export function hasExecutionCwdOwner(
  pi: Pick<ExtensionAPI, "getAllTools" | "getCommands">,
): boolean {
  // excludeTools can hide change_dir while the owner's /cwd command remains loaded.
  const fromOwner = ({
    sourceInfo,
  }: {
    readonly sourceInfo: { readonly source: string; readonly path: string };
  }) =>
    /(?:^|[/\\:@])(?:pi-)?change-working-dir(?:[/\\@:.>]|$)/.test(
      `${sourceInfo.source}/${sourceInfo.path}`,
    );
  return (
    pi.getAllTools().some((tool) => tool.name === "change_dir" || fromOwner(tool)) ||
    pi
      .getCommands()
      .some(
        (command) =>
          command.source === "extension" &&
          (/^cwd(?::\d+)?$/.test(command.name) || fromOwner(command)),
      )
  );
}

function initializeCwd(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, owned: boolean): void {
  if (!owned) {
    if (fs.realpathSync(ctx.cwd) !== fs.realpathSync(cwd)) {
      throw new Error("Native child directory does not match the requested execution cwd.");
    }
    return;
  }
  const selection: CwdRequest = { sessionManager: ctx.sessionManager, path: cwd };
  pi.events.emit(SET_CWD, selection);
  if (!selection.result) {
    throw new Error(
      "The loaded directory extension did not initialize the child directory. Update pi-change-working-dir and ensure session startup has completed.",
    );
  }
  if (nonempty(selection.result.error)) {
    throw new Error(selection.result.error);
  }
  if (fs.realpathSync(selection.result.cwd) !== fs.realpathSync(cwd)) {
    throw new Error("The directory extension selected a different child directory.");
  }
}

function resolveCwdOwnership(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const request: CwdRequest = { sessionManager: ctx.sessionManager };
  pi.events.emit(RESOLVE_CWD, request);
  if (nonempty(request.result?.error)) {
    throw new Error(request.result.error);
  }
  const owned = request.result !== undefined || hasExecutionCwdOwner(pi);
  if (owned && !nonempty(request.result?.cwd)) {
    throw new Error(
      "The loaded directory extension did not resolve the child directory. Update pi-change-working-dir and ensure session startup has completed.",
    );
  }
  return owned;
}
function initializeOnInput(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const intent = nonempty(sessionFile) ? readIntent(sessionFile) : undefined;
  const owned = resolveCwdOwnership(pi, ctx);
  if (!intent) {
    return;
  }
  if (!nonempty(intent.cwd)) {
    throw new Error("New fork execution cwd was not prepared before startup.");
  }
  initializeCwd(pi, ctx, intent.cwd, owned);
  // This is a launch intent, not another directory store. Only the owner persists selection.
  if (sessionFile !== undefined) {
    fs.unlinkSync(intentPath(sessionFile));
  }
}

export function registerChildExecutionCwd(pi: ExtensionAPI): void {
  let initialized = false;
  pi.on("input", (_event, ctx) => {
    if (initialized) {
      return;
    }
    try {
      initializeOnInput(pi, ctx);
      initialized = true;
      return;
    } catch (error) {
      console.error(`Subagent directory initialization failed: ${errorText(error)}`);
      process.exitCode = 1;
      // Native hook exceptions are swallowed. Handled input stops before provider/tool dispatch.
      return { action: "handled" };
    }
  });
}
