import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasExecutionCwdOwner } from "../runs/shared/child-execution-cwd.ts";

/** Capture the active directory owner once per invocation, before asynchronous preparation. */
export function resolveExecutionCwd(pi: Pick<ExtensionAPI, "events"> & Partial<Pick<ExtensionAPI, "getAllTools" | "getCommands">>, ctx: ExtensionContext): string {
	const request: { sessionManager: ExtensionContext["sessionManager"]; result?: { cwd?: string; error?: string } } = { sessionManager: ctx.sessionManager };
	pi.events.emit("pi-change-working-dir:resolve-execution-cwd", request);
	if (request.result?.error) throw new Error(request.result.error);
	if (request.result && !request.result.cwd) throw new Error("Working-directory owner did not return an execution directory.");
	if (!request.result && pi.getAllTools && pi.getCommands && hasExecutionCwdOwner({ getAllTools: pi.getAllTools, getCommands: pi.getCommands })) {
		throw new Error("The loaded directory extension did not resolve the execution directory. Update pi-change-working-dir before delegating work.");
	}
	return request.result?.cwd ?? ctx.cwd;
}
