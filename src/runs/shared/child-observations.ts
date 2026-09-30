import type { Message } from "@earendil-works/pi-ai";

/** Streaming equivalent of the existing exit/status diagnostic expression. */
export class ExitCodeObservation {
	private tail = "";
	private collecting = false;
	private complete = false;
	value?: number;
	write(text: string): void {
		if (this.complete) return;
		if (this.collecting) {
			for (const character of text) {
				if (character < "0" || character > "9") { this.complete = true; return; }
				this.value = this.value! * 10 + Number(character);
			}
			return;
		}
		const normalized = (this.tail + text.replace(/\s+/g, " ")).replace(/ +/g, " ");
		const match = /exit(?:ed)? *(?:with *)?(?:code|status)? *[: ]? *(\d+)/i.exec(normalized);
		if (match) {
			this.value = Number(match[1]);
			this.collecting = match.index + match[0].length === normalized.length;
			this.complete = !this.collecting;
			this.tail = "";
		} else this.tail = normalized.slice(-32);
	}
}

function argumentPreview(arguments_: Record<string, unknown>): Record<string, string | boolean | number> {
	const result: Record<string, string | boolean | number> = {};
	for (const [key, value] of Object.entries(arguments_)) {
		if (typeof value === "string") result[key] = value.slice(0, 2048);
		else if (typeof value === "boolean" || typeof value === "number") result[key] = value;
	}
	return result;
}
/** Facts consumed by guards/reports; full bodies belong to native history or the audit. */
export function compactObservedMessage(message: Message): Message {
	const firstText = Array.isArray(message.content) ? message.content.find((part) => part.type === "text") : undefined;
	const observedExitCode = message.role === "toolResult" && firstText?.type === "text"
		? (message as Message & { observedExitCode?: number }).observedExitCode ?? Number(firstText.text.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i)?.[1])
		: undefined;
	const content = Array.isArray(message.content) ? message.content.map((part) => {
		if (part.type === "text") {
			const preview = part.text.slice(0, 4096);
			return { type: "text" as const, text: preview + (!preview.trim() && part.text.trim() ? "…" : "") };
		}
		if (part.type === "toolCall") return { ...part, arguments: part.name === "structured_output" ? part.arguments : argumentPreview(part.arguments ?? {}) };
		if (part.type === "thinking") return { type: "thinking" as const, thinking: "" };
		return { type: "image" as const, data: "", mimeType: part.mimeType };
	}) : typeof message.content === "string" ? message.content.slice(0, 4096) : [];
	if (message.role === "toolResult") {
		const details = message.details as { preview?: unknown; modifiedFiles?: unknown } | undefined;
		return { ...message, ...(observedExitCode !== undefined && !Number.isNaN(observedExitCode) ? { observedExitCode } : {}), content: content as typeof message.content, details: details ? {
			...(typeof details.preview === "boolean" ? { preview: details.preview } : {}),
			...(Array.isArray(details.modifiedFiles) ? { modifiedFiles: details.modifiedFiles.filter((file): file is string => typeof file === "string") } : {}),
		} : undefined };
	}
	return { ...message, content } as Message;
}
