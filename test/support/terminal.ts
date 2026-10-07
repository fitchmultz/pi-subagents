import type { Terminal } from "@earendil-works/pi-tui";

export interface TestTerminal extends Terminal {
  readonly input: (data: string) => void;
  readonly click: (x: number, y: number) => void;
  readonly resize: (width: number, height: number) => void;
}

function discardTerminalOutput(): void {
  // The real TUI owns layout/rendering; this input fixture has no output device.
}

/** Drive the real TUI input/render loop without a process terminal or a clipboard. */
export function createTestTerminal(columns = 90, rows = 28): TestTerminal {
  const dimensions = { columns, rows };
  let onInput: (data: string) => void = discardTerminalOutput;
  let onResize: () => void = discardTerminalOutput;
  const terminal: TestTerminal = {
    get columns() {
      return dimensions.columns;
    },
    get rows() {
      return dimensions.rows;
    },
    kittyProtocolActive: false,
    start(input: (data: string) => void, resize: () => void) {
      onInput = input;
      onResize = resize;
    },
    stop() {
      onInput = discardTerminalOutput;
      onResize = discardTerminalOutput;
    },
    write: discardTerminalOutput,
    moveBy: discardTerminalOutput,
    hideCursor: discardTerminalOutput,
    showCursor: discardTerminalOutput,
    clearLine: discardTerminalOutput,
    clearFromCursor: discardTerminalOutput,
    clearScreen: discardTerminalOutput,
    setTitle: discardTerminalOutput,
    setProgress: discardTerminalOutput,
    async drainInput() {
      // Input is injected synchronously; no operating-system stream needs draining.
    },
    input(data) {
      onInput(data);
    },
    click(x, y) {
      onInput(`\x1b[<0;${x + 1};${y + 1}M`);
      onInput(`\x1b[<0;${x + 1};${y + 1}m`);
    },
    resize(width, height) {
      dimensions.columns = width;
      dimensions.rows = height;
      onResize();
    },
  };
  return terminal;
}
