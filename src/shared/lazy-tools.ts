import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Only our unnamespaced tools are owned here; foreign public IDs pass through untouched. */
export function activateTools(pi: ExtensionAPI, names: readonly string[]): void {
	const available = pi.getAllTools();
	const active = pi.getActiveTools();
	const added = names.filter((name) => !active.includes(name) && available.some((tool) => tool.name === name && !("namespace" in tool && tool.namespace)));
	if (added.length) pi.setActiveTools([...active, ...new Set(added)]);
}

/** Native declarations, rather than an extension selection journal, own branch/reload state. */
export function restoreLazyTools(pi: ExtensionAPI, ctx: ExtensionContext, loader: string, names: readonly string[]): void {
	const available = pi.getAllTools();
	// A tool-only allowlist must remain usable without its discovery entry.
	if (!available.some((tool) => tool.name === loader && !("namespace" in tool && tool.namespace))) return;
	const messages = ctx.sessionManager.buildSessionProjection().messages;
	const declared = getCurrentSystemMessage(messages);
	const selected = declared?.toolsAdded ?? [];
	const active = pi.getActiveTools();
	const restored = names.filter((name) => selected.some((tool) => tool.name === name && !("namespace" in tool && tool.namespace))
		&& available.some((tool) => tool.name === name && !("namespace" in tool && tool.namespace)));
	const next = active.filter((name) => !names.includes(name) || restored.includes(name));
	for (const name of restored) if (!next.includes(name)) next.push(name);
	if (!declared && !next.includes(loader)) next.push(loader);
	if (next.length !== active.length || next.some((name, index) => name !== active[index])) pi.setActiveTools(next);
}
