import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface IntercomLineage {
  readonly rootSessionId: string;
  readonly parentSessionId: string;
}
export function readIntercomLineage(): IntercomLineage | undefined {
  const rootSessionId = process.env.PI_INTERCOM_ROOT_SESSION_ID?.trim();
  const parentSessionId = process.env.PI_INTERCOM_PARENT_SESSION_ID?.trim();
  if (rootSessionId === undefined && parentSessionId === undefined) {
    return;
  }
  if (
    rootSessionId === undefined ||
    parentSessionId === undefined ||
    rootSessionId === "" ||
    parentSessionId === "" ||
    rootSessionId !== parentSessionId
  ) {
    throw new Error("Intercom child launch requires matching root and parent native session IDs.");
  }
  return { rootSessionId, parentSessionId };
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
  return { name: resolveIntercomPresenceName(pi.getSessionName(), sessionId) };
}
