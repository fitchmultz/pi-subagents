import * as fs from "node:fs";
import type {
  CreateAgentSessionRuntimeFactory,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Launch } from "./contracts.ts";
import type { loadSDK, WorkingState } from "./host.ts";
import { shellCommand } from "./process.ts";
import { localCwdOwner } from "./cwd.ts";
import type { ToolEvent } from "./observation-state.ts";

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
