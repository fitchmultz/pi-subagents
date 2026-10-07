import {
  Container,
  ScrollView,
  Text,
  matchesKey,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { actionHints } from "../../tui/action-hints.ts";
interface TopicViewOptions {
  readonly tui: TUI;
  readonly done: () => void;
  readonly inspect: () => string;
  readonly attach: (render: (() => void) | null) => void;
}
function scrollDelta(data: string, viewport: number): number {
  if (matchesKey(data, "pageUp")) {
    return -viewport;
  }
  if (matchesKey(data, "pageDown")) {
    return viewport;
  }
  if (matchesKey(data, "up")) {
    return -1;
  }
  if (matchesKey(data, "down")) {
    return 1;
  }
  return 0;
}
export function createTopicView(
  options: TopicViewOptions,
): Component & { readonly dispose: () => void } {
  const { tui, done, inspect, attach } = options;
  const text = new Text("", 0, 0);
  const scroll = new ScrollView(text, { follow: "none", scrollbar: "hidden" });
  const render = () => {
    tui.requestRender();
  };
  attach(render);
  let closed = false;
  const act = (delta?: number) => {
    if (closed) {
      return;
    }
    if (delta === undefined) {
      done();
    } else {
      scroll.scrollBy(delta);
    }
    tui.requestRender();
  };
  const view = new Container();
  view.addChild({
    invalidate() {
      scroll.invalidate();
    },
    render: (width) => {
      text.setText(inspect());
      const lines = scroll.render(width);
      const height = Math.max(1, tui.terminal.rows - 2);
      scroll.updateLayout(lines.length, height, render);
      return lines.slice(scroll.scrollTop, scroll.scrollTop + height);
    },
  });
  view.addChild(
    actionHints(
      [
        { text: "↑", run: () => act(-1) },
        "/",
        { text: "↓", run: () => act(1) },
        " ",
        { text: "PgUp", run: () => act(-scroll.viewportHeight) },
        "/",
        { text: "PgDn Read", run: () => act(scroll.viewportHeight) },
        " · ",
        { text: "Esc Back", run: () => act() },
      ],
      (hint) => hint,
      "...",
    ),
  );
  return {
    invalidate() {
      view.invalidate();
    },
    dispose: () => {
      closed = true;
      attach(null);
    },
    render: (width) => view.render(width),
    handleInput(data) {
      if (matchesKey(data, "escape")) {
        act();
      } else {
        act(scrollDelta(data, scroll.viewportHeight));
      }
    },
    handleMouse(event) {
      if (event.type === "wheel") {
        act(event.wheelDelta ?? 0);
        return { handled: true };
      }
      return view.handleMouse(event);
    },
  };
}
