import * as fs from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  CreateAgentSessionRuntimeFactory,
  Extension,
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
import type { OverseerSentinel } from "./overseer-sentinel.ts";
import { recordAt, type UnknownRecord } from "../shared/unknown.ts";

const EDIT_TOOLS = new Set(["edit", "write", "replace_text", "write_files", "apply_patch"]);
const CHILD_GUARDED_TOOLS = new Set(["delegate", "agent_runs"]);
const NON_MID_CONVO_TOOL_APIS = new Set([
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
]);

export function supportsMidConvoToolChanges(model: Pick<Model<Api>, "api" | "compat">): boolean {
  if (NON_MID_CONVO_TOOL_APIS.has(model.api)) {
    return false;
  }
  const compat = recordAt(model, "compat");
  if (!compat || compat.supportsMidConvoSystemMessages !== true) {
    return false;
  }
  return compat.supportsMidConvoToolChanges === true || compat.supportsAdditionalTools === true;
}

export function shouldPreserveParentTools(
  launch: Pick<Launch, "context">,
  model: Pick<Model<Api>, "api" | "compat">,
): boolean {
  return launch.context === "fork" && !supportsMidConvoToolChanges(model);
}

function exposeGuardedTools(extensions: readonly Extension[]): void {
  for (const extension of extensions) {
    for (const name of CHILD_GUARDED_TOOLS) {
      const registered = extension.tools.get(name);
      if (registered?.definition.exposure === "hidden") {
        extension.tools.set(name, {
          ...registered,
          definition: { ...registered.definition, exposure: "direct" },
        });
      }
    }
  }
}

function rewriteLocalBash(
  pi: ExtensionAPI,
  event: { readonly toolName: string; readonly input: Record<string, unknown> },
  directory: string,
  token: string,
): void {
  if (event.toolName !== "bash" || typeof event.input.command !== "string") {
    return;
  }
  const owner = pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo;
  if (owner && (owner.source === "builtin" || localCwdOwner(owner))) {
    const input = event.input;
    input.command = shellCommand(event.input.command, directory, token);
  }
}

interface GuardOptions {
  readonly activeLaunch: () => Launch;
  readonly directory: string;
  readonly token: string;
}

const CHILD_ROLE_SECTION = [
  "You are a delegated subagent reporting results to your parent session, not speaking directly to the user.",
  "Execute only the assigned task within its stated scope and stop boundary. Do not merge PRs, deploy, push, modify unrelated files, or mutate shared state unless explicitly tasked.",
].join("\n");

const READ_ONLY_SECTION =
  "This child is read-only (`readOnly: true`): repository file-editing tools are disabled. Do not edit files.";

function guard(pi: ExtensionAPI, options: GuardOptions): void {
  const { activeLaunch, directory, token } = options;
  pi.on("before_agent_start", (event) => {
    const { sections } = event.systemPromptOptions;
    sections.delegation_role =
      activeLaunch().readOnly === true
        ? `${CHILD_ROLE_SECTION}\n${READ_ONLY_SECTION}`
        : CHILD_ROLE_SECTION;
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "delegate" || event.toolName === "agent_runs") {
      return { block: true, reason: "Only a main session may delegate or control children." };
    }
    if (activeLaunch().readOnly === true && EDIT_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: "This child is read-only (readOnly: true); file-editing tools are disabled.",
      };
    }
    rewriteLocalBash(pi, event, directory, token);
    return;
  });
}

type Exposing = SettingsManager & {
  readonly applyOverrides: (overrides: { toolExposure: UnknownRecord }) => void;
};
function exposing(settings: SettingsManager): settings is Exposing {
  return typeof Reflect.get(settings, "getToolExposure") === "function";
}

function exposeChildTools(settings: SettingsManager): void {
  if (!exposing(settings)) {
    return;
  }
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
  readonly activeLaunch?: (() => Launch) | undefined;
  readonly saved: WorkingState | undefined;
  readonly started: (pi: ExtensionAPI, ctx: ExtensionContext) => void;
  readonly tool: (event: ToolEvent) => void;
  readonly sentinel?: OverseerSentinel | undefined;
}

export function childRuntime(
  sdk: Awaited<ReturnType<typeof loadSDK>>,
  launch: Launch,
  hooks: ChildHooks,
): CreateAgentSessionRuntimeFactory {
  return async ({ sessionManager }) => {
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
            guard(pi, {
              activeLaunch: hooks.activeLaunch ?? (() => launch),
              directory: hooks.directory,
              token: hooks.token,
            });
            hooks.sentinel?.attach(pi);
            pi.on("session_start", (_event, ctx) => {
              hooks.started(pi, ctx);
            });
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
    if (shouldPreserveParentTools(launch, model)) {
      exposeGuardedTools(services.resourceLoader.getExtensions().extensions);
    } else {
      exposeChildTools(services.settingsManager);
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
