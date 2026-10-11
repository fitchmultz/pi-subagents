interface SessionIdentityManager {
  readonly getSessionFile: () => string | null | undefined;
  readonly getSessionId: () => string | null | undefined;
}

// Only delegation supplies this identity; Pi's ordinary fork/clone ancestry does not.
export function resolveRootSessionId(
  sessionManager: SessionIdentityManager,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const rootId = env.PI_SUBAGENT_CHILD === "1" ? env.PI_SUBAGENT_ROOT_SESSION_ID : undefined;
  const sessionId = rootId !== undefined && rootId !== "" ? rootId : sessionManager.getSessionId();
  if (sessionId === null || sessionId === undefined || sessionId === "") {
    throw new Error("Root session identity is unavailable.");
  }
  return sessionId;
}

export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
  const sessionId = sessionManager.getSessionId();
  if (sessionId === null || sessionId === undefined || sessionId === "") {
    throw new Error("Current session identity is unavailable.");
  }
  return sessionId;
}
