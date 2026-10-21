import type { SessionInfo } from "../types.ts";
import { nativePeerId } from "../session-targets.ts";

export function canSeeSession(from: SessionInfo, target: SessionInfo): boolean {
  return (
    (from.rootSessionId ?? from.id) === (target.rootSessionId ?? target.id) ||
    (from.parentSessionId === undefined && target.parentSessionId === undefined)
  );
}

export function assertMainParent(
  session: Omit<SessionInfo, "id">,
  sessions: ReadonlyMap<string, { readonly info: SessionInfo }>,
): void {
  if (
    session.parentSessionId !== undefined &&
    sessions.get(nativePeerId(session.parentSessionId))?.info.parentSessionId !== undefined
  ) {
    throw new Error("Nested child sessions are not supported.");
  }
}

/** Preserve exact-ID precedence and case-insensitive duplicate-name ambiguity. */
export function findSessions<T extends { readonly info: SessionInfo }>(
  sessions: ReadonlyMap<string, T>,
  nameOrId: string,
  fromId: string,
): T[] {
  const from = sessions.get(fromId);
  if (!from) {
    return [];
  }
  const byId = sessions.get(nameOrId);
  if (byId && canSeeSession(from.info, byId.info)) {
    return [byId];
  }
  const lowerName = nameOrId.toLowerCase();
  return [...sessions.values()].filter(
    (session) =>
      canSeeSession(from.info, session.info) && session.info.name?.toLowerCase() === lowerName,
  );
}
