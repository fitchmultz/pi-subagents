import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Launch, DelegateInput } from "./contracts.ts";
import { loadSDK, packageRoot, runtimeEntry } from "./host.ts";
import { runDirectory, write } from "./storage.ts";

function selectedModel(
  input: DelegateInput,
  context: ExtensionContext,
  thinking: ThinkingLevel,
  sdk: Awaited<ReturnType<typeof loadSDK>>,
) {
  if (input.model === undefined) {
    if (!context.model) {
      throw new Error("No selected model; no fallback was used.");
    }
    return { model: context.model, thinking };
  }
  const slash = input.model.indexOf("/");
  if (slash < 1) {
    throw new Error("model must be an exact provider/model ID.");
  }
  const model = context.modelRegistry.find(
    input.model.slice(0, slash),
    input.model.slice(slash + 1),
  );
  if (model) {
    return { model, thinking };
  }
  if (typeof sdk.resolveModelReference !== "function") {
    throw new Error(
      `Model ${input.model} is unavailable; no fallback was used. Check the provider/model ID. This host supports literal IDs only. If you intended a thinking suffix, update Pi for native thinking-suffix support.`,
    );
  }
  const resolved = sdk.resolveModelReference(
    {
      text: input.model,
      provider: input.model.slice(0, slash),
      thinkingSuffix: "strict",
      fuzzy: false,
    },
    context.modelRegistry.getAll(),
    () => true,
  );
  if (resolved.status !== "resolved") {
    throw new Error(`Model ${input.model} is unavailable; no fallback was used.`);
  }
  return { model: resolved.model, thinking: resolved.thinkingLevel ?? thinking };
}
function targetTrust(
  sdk: Awaited<ReturnType<typeof loadSDK>>,
  cwd: string,
  context: ExtensionContext,
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
export async function prepareLaunch(options: {
  input: DelegateInput;
  context: ExtensionContext;
  base: string;
  owner: string;
  agentDir: string;
  thinking: ThinkingLevel;
  executionCwd: string;
}): Promise<Launch> {
  const { input, context, base, owner, agentDir, thinking } = options;
  const sdkRoot = packageRoot();
  const sdk = await loadSDK(sdkRoot);
  const cwd = path.resolve(options.executionCwd, input.cwd ?? ".");
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error("Delegation cwd is not a directory.");
  }
  const selection = selectedModel(input, context, thinking, sdk);
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
  const savedHeader =
    input.context === "fork"
      ? { ...header, parentSession: context.sessionManager.getSessionFile() }
      : header;
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
    name: input.name,
    createdAt: Date.now(),
  };
  // Retain even unpublished native journals on failure, including full fork evidence.
  // Inventory admits only directories with a canonical launch.json.
  write(path.join(directory, "launch.json"), launch, true);
  return launch;
}
