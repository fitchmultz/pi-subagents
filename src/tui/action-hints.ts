import { rawKeyHint, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { MouseRegion, Text, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** Native custom messages expose global expansion, but need their own per-message click state. */
export function withMouseExpansion<T>(renderer: MessageRenderer<T>): MessageRenderer<T> {
	const states = new WeakMap<object, { expanded: boolean; globalExpanded: boolean }>();
	return (message, options, theme) => {
		let state = states.get(message);
		if (!state || state.globalExpanded !== options.expanded) {
			state = { expanded: options.expanded, globalExpanded: options.expanded };
			states.set(message, state);
		}
		const expansion = state;
		const draw = () => renderer(message, { ...options, expanded: expansion.expanded }, theme);
		let content = draw();
		if (!content) return;
		return new MouseRegion({ render: (width) => content?.render(width) ?? [], invalidate: () => content?.invalidate() }, (event) => {
			if (event.type !== "click" || event.button !== "left") return;
			expansion.expanded = !expansion.expanded;
			content = draw();
			return { handled: true };
		});
	};
}

/** Declare action spans while building text; native Text owns wrapping and clipping. */
export function actionHints(parts: Array<string | { text: string; run: () => void }>, style: (text: string) => string = (text) => text, ellipsis?: string): Component {
	let text = "", source = "";
	const ranges: Array<{ start: number; length: number; run: () => void }> = [];
	for (const part of parts) {
		const displayed = typeof part === "string" ? part : part.text.replace(/\balt\+/gi, (key) => stripTerminalSequences(rawKeyHint(key, "")).trim());
		const plain = stripTerminalSequences(displayed).replace(/\t/g, "   ");
		if (typeof part !== "string") ranges.push({ start: source.length, length: plain.length, run: part.run });
		text += displayed;
		source += plain;
	}
	text = style(text);
	const content = new Text("", 0, 0);
	let hits: Array<{ row: number; start: number; end: number; run: () => void }> = [];
	return new MouseRegion({
		invalidate() { content.invalidate(); hits = []; },
		render(width) {
			const clipped = ellipsis !== undefined && visibleWidth(text) > width;
			content.setText(ellipsis === undefined ? text : truncateToWidth(text, width, ellipsis));
			const lines = content.render(width);
			hits = [];
			let offset = 0;
			for (const [row, line] of lines.entries()) {
				const visible = stripTerminalSequences(line).trimEnd();
				const shown = clipped ? visible.slice(0, Math.max(0, visible.length - ellipsis!.length)) : visible;
				const from = source.indexOf(shown, offset);
				if (!shown || from < 0) continue;
				const to = from + shown.length;
				for (const range of ranges) {
					const start = Math.max(from, range.start), end = Math.min(to, range.start + range.length);
					if (start < end) hits.push({ row, start: visibleWidth(shown.slice(0, start - from)), end: visibleWidth(shown.slice(0, end - from)), run: range.run });
				}
				offset = to;
			}
			return lines;
		},
	}, (event) => {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return;
		const hit = hits.find((hit) => hit.row === event.y && event.x >= hit.start && event.x < hit.end);
		if (!hit) return;
		if (event.type === "click") hit.run();
		return { handled: true };
	});
}
