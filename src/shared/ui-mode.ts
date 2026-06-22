import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi 0.79.10 exposes ctx.mode so extensions can distinguish TUI from RPC.
 * Keep a hasUI fallback for tests and custom contexts that only provide legacy
 * UI hints.
 */
export function isTuiContext(ctx: Pick<ExtensionContext, "hasUI"> & { mode?: ExtensionContext["mode"] }): boolean {
	return ctx.mode ? ctx.mode === "tui" : ctx.hasUI;
}
