import { findPackageJSON } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Tui from "@earendil-works/pi-tui";
import type * as Layout from "@earendil-works/pi-tui/dist/layout.js";
import type * as Dispatch from "@earendil-works/pi-tui/dist/tui.js";
import { loadSDK, packageRoot } from "./host.ts";

// Every runtime UI and SDK value in the lazy viewer graph comes from the selected host's files.
// A bare import would resolve against whatever node_modules exist when /agents first opens.
// Jiti aliases the pi-tui root to an index file, so submodule URLs must resolve here too.
const sdkRoot = packageRoot();
const manifest = findPackageJSON("@earendil-works/pi-tui", path.join(sdkRoot, "dist/index.js"));
if (manifest === undefined) {
  throw new Error("Cannot locate the native Pi TUI package.");
}
const root = pathToFileURL(path.join(path.dirname(manifest), "dist/index.js"));
// oxlint-disable-next-line typescript/no-unsafe-assignment
const tui: typeof Tui = await import(root.href);
// oxlint-disable-next-line typescript/no-unsafe-assignment
const layout: typeof Layout = await import(new URL("./layout.js", root).href);
// oxlint-disable-next-line typescript/no-unsafe-assignment
const dispatch: typeof Dispatch = await import(new URL("./tui.js", root).href);
const sdk = await loadSDK(sdkRoot);
export const { Container, HStack, ScrollView, Text, TruncatedText, VStack } = tui;
export const {
  AssistantMessageComponent,
  ToolExecutionComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  rawKeyHint,
} = sdk;
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
