import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildOrchestratorMetadata } from "./runtime-types.ts";
function environmentText(name: string): string {
  return process.env[name]?.trim() ?? "";
}
export function readChildOrchestratorMetadata(): ChildOrchestratorMetadata | null {
  const orchestratorTarget = environmentText("PI_SUBAGENT_ORCHESTRATOR_TARGET");
  const runId = environmentText("PI_SUBAGENT_RUN_ID");
  const agent = environmentText("PI_SUBAGENT_CHILD_AGENT");
  const index = environmentText("PI_SUBAGENT_CHILD_INDEX");
  if ([orchestratorTarget, runId, agent, index].includes("")) {
    return null;
  }
  const sessionName = environmentText("PI_SUBAGENT_INTERCOM_SESSION_NAME");
  return {
    orchestratorTarget,
    runId,
    agent,
    index,
    ...(sessionName !== "" ? { sessionName } : {}),
  };
}
export function formatChildOrchestratorMessage(
  kind: "ask" | "update" | "interview",
  metadata: ChildOrchestratorMetadata,
  message: string,
): string {
  const headings = {
    ask: "Subagent needs a supervisor decision.",
    interview: "Subagent requests a structured supervisor interview.",
    update: "Subagent progress update.",
  };
  return [
    headings[kind],
    `Run: ${metadata.runId}`,
    `Agent: ${metadata.agent}`,
    `Child index: ${metadata.index}`,
    metadata.sessionName !== undefined && metadata.sessionName !== ""
      ? `Child intercom target: ${metadata.sessionName}`
      : undefined,
    "",
    message,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
export function resolveIntercomPresenceName(
  sessionName: string | undefined,
  sessionId: string,
): string {
  const name = sessionName?.trim();
  if (name !== undefined && name !== "") {
    return name;
  }
  const normalized = sessionId.startsWith("session-")
    ? sessionId.slice("session-".length)
    : sessionId;
  return `subagent-chat-${normalized.slice(0, 8)}`;
}
export function buildPresenceIdentity(
  pi: ExtensionAPI,
  sessionId: string,
): { readonly name: string } {
  const name = process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME?.trim();
  return {
    name:
      name !== undefined && name !== ""
        ? name
        : resolveIntercomPresenceName(pi.getSessionName(), sessionId),
  };
}
