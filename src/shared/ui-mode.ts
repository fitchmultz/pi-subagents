import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isTuiContext(ctx: Pick<ExtensionContext, "mode">): boolean {
	return ctx.mode === "tui";
}
