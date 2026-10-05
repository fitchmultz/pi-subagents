import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createEventBus as createNativeEventBus,
  type EventBus,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ReadonlyDeep } from "type-fest";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { createMockPi as _createMockPi, type MockPi } from "./mock-pi.ts";
import { makeExtensionContext } from "./sdk-context.ts";

export { makeExtensionContext } from "./sdk-context.ts";
export { createNativeSessionFixture } from "./native-session.ts";
export type { MockPi };

export function createMockPi(): MockPi {
  return _createMockPi();
}

export function createTempDir(prefix = "pi-subagent-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort teardown must not replace the test's original failure.
  }
}

export function createEventBus(): EventBus {
  return createNativeEventBus();
}

export function makeAgentConfigs(names: readonly string[]): AgentConfig[] {
  return names.map((name) => makeAgent(name));
}

export function makeAgent(
  name: string,
  overrides: ReadonlyDeep<Partial<AgentConfig>> = {},
): AgentConfig {
  return {
    name,
    description: `Test agent: ${name}`,
    systemPrompt: "",
    source: "user",
    filePath: path.join(os.tmpdir(), `${name}.md`),
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    ...overrides,
    fallbackModels: overrides.fallbackModels?.slice(),
    tools: overrides.tools?.slice(),
    extensions: overrides.extensions?.slice(),
    skills: overrides.skills?.slice(),
    defaultReads: overrides.defaultReads?.slice(),
    extraFields: overrides.extraFields === undefined ? undefined : { ...overrides.extraFields },
    mcpDirectTools: overrides.mcpDirectTools?.slice(),
  };
}

export function makeMinimalCtx(
  cwd: string,
  overrides: Readonly<Partial<ExtensionContext>> = {},
): ExtensionContext {
  return makeExtensionContext(cwd, overrides);
}

export const events = {
  assistantMessage(
    text: string,
    model = "mock/test-model",
  ): { readonly type: "message_end"; readonly message: AssistantMessage } {
    const separator = model.indexOf("/");
    return {
      type: "message_end",
      message: {
        role: "assistant",
        api: "mock",
        timestamp: 0,
        content: [{ type: "text", text }],
        provider: separator >= 0 ? model.slice(0, separator) : "mock",
        model: separator >= 0 ? model.slice(separator + 1) : model,
        stopReason: "stop",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
        },
      },
    };
  },

  toolStart(
    toolName: string,
    args: ReadonlyDeep<Record<string, unknown>> = {},
    toolCallId = `mock-${toolName}`,
  ): object {
    return { type: "tool_execution_start", toolName, toolCallId, args };
  },

  toolEnd(toolName: string, toolCallId = `mock-${toolName}`): object {
    return { type: "tool_execution_end", toolName, toolCallId };
  },

  toolResult(
    toolName: string,
    text: string,
    isError = false,
    toolCallId = `mock-${toolName}`,
  ): object {
    return {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName,
        toolCallId,
        timestamp: 0,
        isError,
        content: [{ type: "text", text }],
      },
    };
  },
};
