import type { AgentMessage } from "@earendil-works/pi-agent-core";

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
  "subagent-orchestration-instructions",
  "subagent-slash-result",
  "subagent-notify",
  "subagent_control_notice",
  "subagent-control",
  "subagent-control-notice",
]);
const ORCHESTRATION_TOOLS = new Set(["subagent", "delegate", "agent_runs", "load_subagent"]);

function parentOnlyMessage(message: AgentMessage, fanoutChild: boolean): boolean {
  if (message.role === "custom") {
    return PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(message.customType);
  }
  return !fanoutChild && message.role === "toolResult" && ORCHESTRATION_TOOLS.has(message.toolName);
}
function stripParentToolCalls(message: AgentMessage): AgentMessage | undefined {
  if (message.role !== "assistant") {
    return message;
  }
  const content = message.content.filter(
    (block) => block.type !== "toolCall" || !ORCHESTRATION_TOOLS.has(block.name),
  );
  if (content.length === message.content.length) {
    return message;
  }
  return content.length === 0 ? undefined : { ...message, content };
}

/** Only the request-local context changes. Native saved history is never rewritten. */
export function stripParentOnlySubagentMessages(
  messages: readonly AgentMessage[],
  fanoutChild = false,
): AgentMessage[] | undefined {
  let changed = false;
  const filtered: AgentMessage[] = [];
  for (const message of messages) {
    if (parentOnlyMessage(message, fanoutChild)) {
      changed = true;
      continue;
    }
    const stripped = fanoutChild ? message : stripParentToolCalls(message);
    if (stripped === undefined) {
      changed = true;
      continue;
    }
    changed ||= stripped !== message;
    filtered.push(stripped);
  }
  return changed ? filtered : undefined;
}
