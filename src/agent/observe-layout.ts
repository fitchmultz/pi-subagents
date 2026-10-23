import * as fs from "node:fs";
import { findPackageJSON } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Tui from "@earendil-works/pi-tui";
import type * as Layout from "@earendil-works/pi-tui/dist/layout.js";
import type * as Dispatch from "@earendil-works/pi-tui/dist/tui.js";
import { packageRoot } from "./host.ts";

// Jiti aliases the root to an index file, so submodule URLs must resolve in the actual host graph.
const manifest = findPackageJSON(
  "@earendil-works/pi-tui",
  path.join(packageRoot(), "dist/index.js"),
);
if (manifest === undefined) {
  throw new Error("Cannot locate the native Pi TUI package.");
}
const declared: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
const main =
  typeof declared === "object" &&
  declared !== null &&
  "main" in declared &&
  typeof declared.main === "string"
    ? declared.main
    : "dist/index.js";
const root = pathToFileURL(path.resolve(path.dirname(manifest), main));
// oxlint-disable-next-line typescript/no-unsafe-assignment
const tui: typeof Tui = await import(root.href);
// oxlint-disable-next-line typescript/no-unsafe-assignment
const layout: typeof Layout = await import(new URL("./layout.js", root).href);
// oxlint-disable-next-line typescript/no-unsafe-assignment
const dispatch: typeof Dispatch = await import(new URL("./tui.js", root).href);
export const { HStack, VStack, ScrollView } = tui;
export const { renderLayoutFrame, getLayoutBoxesAt, getScrollViewsAt } = layout;
export const { dispatchMouseEvent } = dispatch;
export type { LayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";

export function dispatchLayoutMouse(
  component: Tui.Component,
  frame: Layout.LayoutFrame,
  event: Tui.TuiMouseEvent,
): ReturnType<typeof dispatchMouseEvent> {
  if (event.type === "wheel") {
    getScrollViewsAt(frame, event.x, event.y)
      .at(0)
      ?.scrollBy(event.wheelDelta ?? 0);
    return {
      handled: true,
      target: {
        component,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  }
  for (const box of getLayoutBoxesAt(frame, event.x, event.y)) {
    if (box.children.length > 0 || box.component === component) {
      continue;
    }
    const result = dispatchMouseEvent(box.component, {
      ...event,
      x: event.x - box.rect.x,
      y: event.y - box.rect.y,
      width: box.rect.width,
      height: box.rect.height,
    });
    if (result) {
      return result;
    }
  }
  return undefined;
}
