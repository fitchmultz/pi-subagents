interface SessionIdentityManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

// Only delegation supplies this identity; Pi's ordinary fork/clone ancestry does not.
export function resolveRootSessionId(sessionManager: SessionIdentityManager, env: NodeJS.ProcessEnv = process.env): string {
	const rootId = env.PI_SUBAGENT_CHILD === "1" ? env.PI_SUBAGENT_ROOT_SESSION_ID : undefined;
	const sessionId = rootId || sessionManager.getSessionId();
	if (!sessionId) throw new Error("Root session identity is unavailable.");
	return sessionId;
}

export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
	const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
	if (!sessionId) throw new Error("Current session identity is unavailable.");
	return sessionId;
}
