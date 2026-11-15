import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { DelegationContract, Launch, OverseerLaunch } from "./contracts.ts";
import type { DelegateInput } from "./tool-schemas.ts";
import { loadSDK, packageRoot, runtimeEntry } from "./host.ts";
import { runDirectory, write } from "./storage.ts";

export interface LaunchContext {
  readonly cwd: string;
  readonly isProjectTrusted: () => boolean;
  readonly model: ExtensionContext["model"];
  readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "getAll">;
  readonly sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getSessionId" | "getSessionFile" | "getHeader" | "getBranch"
  >;
}

function selectedThinking(
  requested: ThinkingLevel | undefined,
  inherited: ThinkingLevel,
  suffix?: ThinkingLevel,
): ThinkingLevel {
  if (requested !== undefined && suffix !== undefined && requested !== suffix) {
    throw new Error("thinking conflicts with the model's thinking suffix.");
  }
  return suffix ?? requested ?? inherited;
}

function resolveExplicitModel(
  spec: string,
  context: LaunchContext,
  sdk: Awaited<ReturnType<typeof loadSDK>>,
) {
  const slash = spec.indexOf("/");
  if (slash < 1) {
    throw new Error("model must be an exact provider/model ID.");
  }
  const provider = spec.slice(0, slash);
  const rest = spec.slice(slash + 1);
  const direct = context.modelRegistry.find(provider, rest);
  if (direct) {
    return { model: direct, suffix: undefined };
  }
  if (typeof sdk.resolveModelReference === "function") {
    const resolved = sdk.resolveModelReference(
      { text: spec, provider, thinkingSuffix: "strict", fuzzy: false },
      context.modelRegistry.getAll(),
      () => true,
    );
    if (resolved.status !== "resolved") {
      throw new Error(`Model ${spec} is unavailable; no fallback was used.`);
    }
    return { model: resolved.model, suffix: resolved.thinkingLevel };
  }
  throw new Error(
    `Model ${spec} is unavailable; no fallback was used. Check the provider/model ID. This host supports literal IDs only. If you intended a thinking suffix, update Pi for native thinking-suffix support.`,
  );
}

function selectedModel(
  options: {
    input: DelegateInput;
    defaultModel?: string | undefined;
    defaultThinking?: ThinkingLevel | undefined;
    thinking: ThinkingLevel;
  },
  context: LaunchContext,
  sdk: Awaited<ReturnType<typeof loadSDK>>,
) {
  const { input, defaultModel, defaultThinking, thinking } = options;
  if (input.model === undefined) {
    if (defaultModel !== undefined) {
      const resolved = resolveExplicitModel(defaultModel, context, sdk);
      return {
        model: resolved.model,
        thinking: input.thinking ?? resolved.suffix ?? defaultThinking ?? thinking,
      };
    }
    if (!context.model) {
      throw new Error("No selected model; no fallback was used.");
    }
    return { model: context.model, thinking: selectedThinking(input.thinking, thinking) };
  }
  const resolved = resolveExplicitModel(input.model, context, sdk);
  const fallback =
    defaultModel !== undefined && `${resolved.model.provider}/${resolved.model.id}` === defaultModel
      ? (defaultThinking ?? thinking)
      : thinking;
  return {
    model: resolved.model,
    thinking: selectedThinking(input.thinking, fallback, resolved.suffix),
  };
}
function targetTrust(
  sdk: Awaited<ReturnType<typeof loadSDK>>,
  cwd: string,
  context: LaunchContext,
  agentDir: string,
): boolean {
  if (fs.realpathSync(cwd) === fs.realpathSync(context.cwd)) {
    return context.isProjectTrusted();
  }
  if (!sdk.hasTrustRequiringProjectResources(cwd)) {
    return true;
  }
  const remembered = new sdk.ProjectTrustStore(agentDir).get(cwd);
  if (remembered !== null) {
    return remembered;
  }
  // Resolve another project's global policy without loading its untrusted settings.
  const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  return settings.getDefaultProjectTrust() === "always";
}
/**
 * The session id whose provider prompt cache holds the invoking session's conversation.
 * fitchmultz/pi records it as `cacheSessionId` in the header of a session that is itself a copy.
 */
function cacheSessionId(
  manager: Pick<ExtensionContext["sessionManager"], "getHeader" | "getSessionId">,
): string {
  const header = manager.getHeader();
  return header !== null && "cacheSessionId" in header && typeof header.cacheSessionId === "string"
    ? header.cacheSessionId
    : manager.getSessionId();
}

function savedSessionHeader(
  input: DelegateInput,
  header: NonNullable<ReturnType<ExtensionContext["sessionManager"]["getHeader"]>>,
  context: LaunchContext,
) {
  if (input.context !== "fork") {
    return header;
  }
  return {
    ...header,
    parentSession: context.sessionManager.getSessionFile(),
    // OpenAI routes a request to a cache by session id; the copied conversation is cached
    // under the invoking session's. Hosts without `cacheSessionId` ignore the field.
    cacheSessionId: cacheSessionId(context.sessionManager),
  };
}

function optionalLaunchFields(options: {
  name?: string | undefined;
  contract?: DelegationContract | undefined;
  overseer?: OverseerLaunch | undefined;
}) {
  return {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.contract !== undefined ? { contract: options.contract } : {}),
    ...(options.overseer !== undefined ? { overseer: options.overseer } : {}),
  };
}

export async function prepareLaunch(options: {
  input: DelegateInput;
  context: LaunchContext;
  base: string;
  owner: string;
  agentDir: string;
  thinking: ThinkingLevel;
  executionCwd: string;
  defaultModel?: string | undefined;
  defaultThinking?: ThinkingLevel | undefined;
  contract?: DelegationContract | undefined;
  overseer?: OverseerLaunch | undefined;
}): Promise<Launch> {
  const { input, context, base, owner, agentDir, thinking } = options;
  const sdkRoot = packageRoot();
  const sdk = await loadSDK(sdkRoot);
  const cwd = path.resolve(options.executionCwd, input.cwd ?? ".");
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error("Delegation cwd is not a directory.");
  }
  const selection = selectedModel(
    {
      input,
      defaultModel: options.defaultModel,
      defaultThinking: options.defaultThinking,
      thinking,
    },
    context,
    sdk,
  );
  const trusted = targetTrust(sdk, cwd, context, agentDir);
  const id = randomUUID();
  const directory = runDirectory(base, id);
  fs.mkdirSync(directory, { mode: 0o700 });
  const manager = sdk.SessionManager.create(cwd, directory);
  const sessionFile = manager.getSessionFile();
  const header = manager.getHeader();
  if (sessionFile === undefined || !header) {
    throw new Error("Native session did not allocate a durable identity.");
  }
  const inherited = input.context === "fork" ? context.sessionManager.getBranch() : [];
  const savedHeader = savedSessionHeader(input, header, context);
  // Preserve the full native branch: no semantic tool filter or canned body.
  fs.writeFileSync(
    sessionFile,
    [savedHeader, ...inherited].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const launch: Launch = {
    version: 1,
    id,
    rootId: id,
    owner,
    cwd,
    agentDir,
    sdk: sdkRoot,
    entry: runtimeEntry(),
    sessionFile,
    sessionId: manager.getSessionId(),
    prompt: input.prompt,
    context: input.context ?? "fresh",
    provider: selection.model.provider,
    model: selection.model.id,
    thinking: selection.thinking,
    trusted,
    ...optionalLaunchFields({
      name: input.name,
      contract: options.contract,
      overseer: options.overseer,
    }),
    createdAt: Date.now(),
  };
  // Retain even unpublished native journals on failure, including full fork evidence.
  // Inventory admits only directories with a canonical launch.json.
  write(path.join(directory, "launch.json"), launch, true);
  return launch;
}
