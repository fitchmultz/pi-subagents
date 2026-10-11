import { CURSOR_MARKER, type Editor, type Component } from "@earendil-works/pi-tui";
/** Bound native editor output without replacing its cursor or input handling. */
export function editorViewport(editor: Editor, height: () => number): Component {
  let offset = 0;
  return {
    invalidate: () => editor.invalidate(),
    render(width) {
      const lines = editor.render(width),
        rows = height();
      const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
      if (cursor >= 0) {
        offset = Math.max(0, cursor - rows + 1);
      }
      offset = Math.max(0, Math.min(offset, lines.length - rows));
      return lines.slice(offset, offset + rows);
    },
    handleMouse: (event) => editor.handleMouse({ ...event, y: event.y + offset }),
  };
}
