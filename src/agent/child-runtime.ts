import * as fs from "node:fs";
import type {
  CreateAgentSessionRuntimeFactory,
  ExtensionAPI,
  ExtensionContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Launch } from "./contracts.ts";
import type { loadSDK, WorkingState } from "./host.ts";
import { shellCommand } from "./process.ts";
import { localCwdOwner } from "./cwd.ts";
import type { ToolEvent } from "./observation-state.ts";
import { backgroundCommands } from "./background-work.ts";
import { recordAt, type UnknownRecord } from "../shared/unknown.ts";

function guard(pi: ExtensionAPI, directory: string, token: string): void {
  pi.on("tool_call", (event) => {
    if (event.toolName === "delegate" || event.toolName === "agent_runs") {
      return { block: true, reason: "Only a main session may delegate or control children." };
    }
    if (event.toolName !== "bash" || typeof event.input.command !== "string") {
      return;
    }
    const owner = pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo;
    if (owner && (owner.source === "builtin" || localCwdOwner(owner))) {
      // Preserve the selected local owner's cwd/env and leave remote/custom tools alone.
      const input = event.input;
      input.command = shellCommand(event.input.command, directory, token);
    }
    return;
  });
}
/**
 * Fork-only: settings with `toolExposure`, how the model reaches each tool. Official Pi has
 * no such setting, so its children keep the exposure every tool registered with.
 */
type Exposing = SettingsManager & {
  readonly applyOverrides: (overrides: { toolExposure: UnknownRecord }) => void;
};
function exposing(settings: SettingsManager): settings is Exposing {
  return typeof Reflect.get(settings, "getToolExposure") === "function";
}
/**
 * Gives this child the `subagents.toolExposure` map of its settings files on top of its own
 * `toolExposure`, so a tool children rarely need can stay out of their requests and still be
 * reached through `tool_search` and codemode. The host merges and validates the entries as it
 * does for one more settings layer. Loading the settings drops overrides, so this must follow
 * the creation of the services. An exact restore then puts back the settings it saved.
 */
function exposeChildTools(settings: SettingsManager): void {
  if (!exposing(settings)) {
    return;
  }
  // The project file last: its entries win and its patterns match first, as in `toolExposure`.
  for (const layer of [settings.getGlobalSettings(), settings.getProjectSettings()]) {
    const toolExposure = recordAt(recordAt(layer, "subagents"), "toolExposure");
    if (toolExposure !== undefined) {
      settings.applyOverrides({ toolExposure });
    }
  }
}
interface ChildHooks {
  readonly directory: string;
  readonly token: string;
  /** Exact parked working state; absent means the saved journal alone. */
  readonly saved: WorkingState | undefined;
  readonly started: (pi: ExtensionAPI, ctx: ExtensionContext) => void;
  readonly tool: (event: ToolEvent) => void;
}
/** One native child session with this package's child policy and live-view hooks. */
export function childRuntime(
  sdk: Awaited<ReturnType<typeof loadSDK>>,
  launch: Launch,
  hooks: ChildHooks,
): CreateAgentSessionRuntimeFactory {
  return async ({ sessionManager }) => {
    // Exact restore keeps settings, tool policy and accepted queues; it never replays input.
    const restore = hooks.saved ? { workingSession: hooks.saved } : {};
    if (!fs.existsSync(launch.sessionFile)) {
      throw new Error("Missing saved native session; refusing to create another.");
    }
    const settingsManager = sdk.SettingsManager.create(launch.cwd, launch.agentDir, {
      projectTrusted: launch.trusted,
    });
    const jobs = backgroundCommands(sdk);
    const services = await sdk.createAgentSessionServices({
      ...restore,
      cwd: launch.cwd,
      agentDir: launch.agentDir,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: [launch.entry],
        extensionFactories: [
          {
            name: "codemode",
            builtin: true,
            factory: sdk.createCodemodeExtension({ mode: "on" }),
          },
          { name: "tool_search", builtin: true, factory: sdk.createToolSearchExtension() },
          { name: "mcp", builtin: true, factory: sdk.createMcpExtension() },
          ...(jobs ? [{ name: "background-command", builtin: true, factory: jobs }] : []),
          (pi) => {
            guard(pi, hooks.directory, hooks.token);
            pi.on("session_start", (_event, ctx) => {
              hooks.started(pi, ctx);
            });
            // Sparse tool lifecycle keeps the live view's tools even while nobody watches.
            pi.on("tool_execution_start", hooks.tool);
            pi.on("tool_execution_update", hooks.tool);
            pi.on("tool_execution_end", hooks.tool);
          },
        ],
      },
    });
    // The SDK has no disposal for services created before a session: if a check below
    // throws, their cleanup owner never materializes and this actor exits instead.
    exposeChildTools(services.settingsManager);
    const diagnostics = services.resourceLoader.getExtensions().errors;
    if (diagnostics.length > 0) {
      throw new Error(`Child extension load failed: ${JSON.stringify(diagnostics)}`);
    }
    const model = services.modelRuntime.getModel(launch.provider, launch.model);
    if (!model) {
      throw new Error(
        `Saved model ${launch.provider}/${launch.model} is unavailable; no fallback was used.`,
      );
    }
    return {
      ...(await sdk.createAgentSessionFromServices({
        ...restore,
        services,
        sessionManager,
        model,
        thinkingLevel: launch.thinking,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
}
