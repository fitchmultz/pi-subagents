import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Additive native API; official Pi 0.87.1 does not declare this event. */
export interface NativeCheckpointEvent {
	type: "session_checkpoint";
	boundary: "turn" | "settled";
	signal: AbortSignal;
	invalidate(): void;
}
export type NativeCheckpointResult = { sleepReady: boolean; reason?: string };
export function onNativeCheckpoint(pi: ExtensionAPI, handler: (event: NativeCheckpointEvent, ctx: ExtensionContext) => NativeCheckpointResult | Promise<NativeCheckpointResult>): void {
	(pi.on as unknown as (event: "session_checkpoint", callback: typeof handler) => void)("session_checkpoint", handler);
}
