import {
  applyIntercomBridgeToAgent,
  resolveIntercomBridge,
} from "../../intercom/intercom-bridge.ts";
import type { ReadonlyInput } from "../../shared/types.ts";
import { applyThinkingSuffix, buildPiArgs } from "./pi-args.ts";
import type { BuildPiArgsInput, BuildPiArgsResult } from "./pi-launch-input.ts";
import {
  buildClaudeCodeInvocation,
  isClaudeCodeModel,
  type ClaudeCodeInvocation,
} from "./claude-code.ts";
import { nativeFinalizationLaunch, type NativeFinalizationConfig } from "./native-finalization.ts";
import { nonempty } from "./child-json.ts";

type ChildInvocationInput = ReadonlyInput<
  Omit<BuildPiArgsInput, "baseArgs"> & { readonly nativeFinalization?: NativeFinalizationConfig }
>;
export type ChildInvocation = BuildPiArgsResult & { claudeCodeInvocation?: ClaudeCodeInvocation };

function bridgedInput(input: ChildInvocationInput): ChildInvocationInput {
  if (!nonempty(input.orchestratorIntercomTarget)) {
    return input;
  }
  const bridged = applyIntercomBridgeToAgent(
    { systemPrompt: input.systemPrompt ?? "", tools: input.tools, extensions: input.extensions },
    resolveIntercomBridge(input.orchestratorIntercomTarget),
  );
  return {
    ...input,
    systemPrompt: bridged.systemPrompt,
    tools: bridged.tools,
    extensions: bridged.extensions,
  };
}

function finalizedPiInvocation(input: ChildInvocationInput): BuildPiArgsResult {
  const built = buildPiArgs({
    ...bridgedInput(input),
    structuredOutput: input.nativeFinalization ? undefined : input.structuredOutput,
    baseArgs: ["--mode", "json", "-p"],
  });
  if (!input.nativeFinalization) {
    return built;
  }
  const runtime = nativeFinalizationLaunch(input.nativeFinalization);
  built.args.push("--extension", runtime.extension);
  Object.assign(built.env, runtime.env);
  const tools = built.args.indexOf("--tools");
  const names = tools >= 0 ? built.args.at(tools + 1) : undefined;
  if (names !== undefined && !names.split(",").includes("structured_output")) {
    built.args[tools + 1] = `${names},structured_output`;
  }
  return built;
}

export function buildChildInvocation(input: ChildInvocationInput): ChildInvocation {
  const model = applyThinkingSuffix(input.model, input.thinking);
  if (!nonempty(model) || !isClaudeCodeModel(model)) {
    return finalizedPiInvocation(input);
  }
  const invocation = buildClaudeCodeInvocation({
    ...input,
    model,
    systemPrompt: input.systemPrompt ?? undefined,
    sessionName: input.intercomSessionName,
    outputSchema: input.structuredOutput?.schema,
  });
  return {
    args: [...invocation.args],
    env: { ...invocation.env },
    claudeCodeInvocation: invocation,
  };
}
