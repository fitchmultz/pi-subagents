import type { Terminal } from "@earendil-works/pi-tui";

/** Drive the real TUI input/render loop without a process terminal or a clipboard. */
export function createTestTerminal(columns = 90, rows = 28) {
	let onInput: (data: string) => void = () => {};
	let onResize: () => void = () => {};
	const terminal = {
		columns, rows, kittyProtocolActive: false,
		start(input: (data: string) => void, resize: () => void) { onInput = input; onResize = resize; },
		stop() { onInput = () => {}; onResize = () => {}; },
		write() {},
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, async drainInput() {},
		input(data: string) { onInput(data); },
		click(x: number, y: number) { onInput(`\x1b[<0;${x + 1};${y + 1}M`); onInput(`\x1b[<0;${x + 1};${y + 1}m`); },
		resize(width: number, height: number) { terminal.columns = width; terminal.rows = height; onResize(); },
	} satisfies Terminal & { input(data: string): void; click(x: number, y: number): void; resize(width: number, height: number): void };
	return terminal;
}
