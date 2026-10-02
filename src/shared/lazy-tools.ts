import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

const declarations = new WeakMap<ExtensionContext["sessionManager"], {
	leaf: string | null; count: number | undefined; current: ReturnType<typeof getCurrentSystemMessage>;
}>();

/** Only our unnamespaced tools are owned here; foreign public IDs pass through untouched. */
export function activateTools(pi: ExtensionAPI, names: readonly string[]): void {
	const available = pi.getAllTools();
	const active = pi.getActiveTools();
	const added = names.filter((name) => !active.includes(name) && available.some((tool) => tool.name === name && !("namespace" in tool && tool.namespace)));
	if (added.length) pi.setActiveTools([...active, ...new Set(added)]);
}

/** Official 1.0 SDK creation omits initial resume restoration; tree/reload are native. */
export function restoreLazyTools(pi: ExtensionAPI, ctx: ExtensionContext, loader: string, names: readonly string[]): void {
	const available = pi.getAllTools();
	// A tool-only allowlist must remain usable without its discovery entry.
	if (!available.some((tool) => tool.name === loader && !("namespace" in tool && tool.namespace))) {
		activateTools(pi, names);
		return;
	}
	const manager = ctx.sessionManager, leaf = manager.getLeafId(), count = (manager as Partial<SessionManager>).getEntryCount?.();
	let cached = declarations.get(manager);
	if (count === undefined || !cached || cached.leaf !== leaf || cached.count !== count) {
		cached = { leaf, count, current: getCurrentSystemMessage(manager.buildSessionProjection().messages) };
		declarations.set(manager, cached);
	}
	const declared = cached.current;
	if (!declared) return;
	const selected = declared?.toolsAdded ?? [];
	const restored = names.filter((name) => selected.some((tool) => tool.name === name && !("namespace" in tool && tool.namespace))
		&& available.some((tool) => tool.name === name && !("namespace" in tool && tool.namespace)));
	activateTools(pi, restored);
}
