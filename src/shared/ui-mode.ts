import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi 0.78.1 exposes ctx.mode so extensions can distinguish TUI from RPC.
 * Keep a hasUI fallback so git installs still degrade on older Pi builds instead
 * of hard-requiring one exact Pi version.
 */
export function isTuiContext(ctx: Pick<ExtensionContext, "hasUI"> & { mode?: ExtensionContext["mode"] }): boolean {
	return ctx.mode ? ctx.mode === "tui" : ctx.hasUI;
}
