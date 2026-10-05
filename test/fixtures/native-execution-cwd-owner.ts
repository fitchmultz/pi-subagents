import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface ExecutionCwdRequest {
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly path?: string;
  result?: { readonly cwd: string; readonly error?: string };
}

function isExecutionCwdRequest(
  request: unknown,
  context: ExtensionContext,
): request is ExecutionCwdRequest {
  return (
    typeof request === "object" &&
    request !== null &&
    "sessionManager" in request &&
    request.sessionManager === context.sessionManager &&
    (!("path" in request) || typeof request.path === "string")
  );
}

function storedDirectory(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && "dir" in data && typeof data.dir === "string") {
    return data.dir;
  }
  return undefined;
}

// Contract fixture; PI_CWD_TEST_OWNER can replace it with the real directory extension.
export default function (pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let cwd: string;
  const initialize = (ctx: ExtensionContext): void => {
    if (context?.sessionManager === ctx.sessionManager) {
      return;
    }
    context = ctx;
    const entry = ctx.sessionManager
      .getBranch()
      .findLast(
        (candidate) => candidate.type === "custom" && candidate.customType === "change-working-dir",
      );
    cwd = (entry?.type === "custom" ? storedDirectory(entry.data) : undefined) ?? ctx.cwd;
  };
  const change = (value: string, ctx: ExtensionContext): string => {
    initialize(ctx);
    cwd = resolve(cwd, value);
    pi.appendEntry("change-working-dir", { dir: cwd === ctx.cwd ? undefined : cwd });
    return cwd;
  };
  pi.on("session_start", (_event, ctx) => {
    initialize(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    initialize(ctx);
    // Native before_agent_start owns a mutable structured prompt draft.
    event.systemPromptOptions.cwd = cwd;
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "read" && typeof event.input.path === "string") {
      // Native tool_call permits the directory owner to resolve the input path.
      event.input.path = resolve(cwd, event.input.path);
    }
  });
  for (const name of ["resolve", "set"]) {
    pi.events.on(`pi-change-working-dir:${name}-execution-cwd`, (request) => {
      if (context === undefined || !isExecutionCwdRequest(request, context)) {
        return;
      }
      if (name === "set" && request.path === undefined) {
        return;
      }
      // This event bus protocol explicitly requires the directory owner to fill result.
      request.result = {
        cwd: name === "set" && request.path !== undefined ? change(request.path, context) : cwd,
      };
    });
  }
  pi.registerCommand("cwd", {
    handler: async (value, ctx) => {
      change(value, ctx);
    },
  });
  pi.registerTool({
    name: "change_dir",
    label: "Change Directory",
    description: "Fixture directory owner",
    parameters: Type.Object({ path: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, { path }, _signal, _update, ctx) => ({
      content: [{ type: "text", text: change(path, ctx) }],
      details: {},
    }),
  });
}
