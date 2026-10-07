import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { actionHints } from "./action-hints.ts";
import { readableText } from "./history-text.ts";
import { CONTINUE_HINT, CONTINUE_NOTICES, primaryKey, type AgentVisit } from "./view-model.ts";

interface ControlModel {
  readonly menu: boolean;
  readonly detail: boolean;
  readonly compact: boolean;
  readonly width: number;
  readonly primary?: string;
  readonly actionHint: string;
  readonly act: (action: string) => void;
}
export function conversationControls(model: ControlModel, theme: Theme): Component {
  const { compact, act } = model;
  const primary =
    model.primary !== undefined
      ? { text: model.actionHint, run: () => act(model.primary ?? "") }
      : model.actionHint;
  const actions = { text: compact ? "F2" : "F2 Actions", run: () => act("actions") };
  const focus = { text: compact ? "Tab" : "Tab Read/write", run: () => act("focus") };
  const reply = { text: compact ? "Alt+R" : "Alt+R Reply", run: () => act("reply") };
  const back = { text: backLabel(model), run: () => act("back") };
  const choose = {
    text: `${primaryKey("tui.select.confirm")}${compact ? "" : " Choose"}`.trim(),
    run: () => act("choose"),
  };
  if (model.menu) {
    return actionHints([choose, " · ", back]);
  }
  const style = (text: string) => theme.fg("dim", text);
  if (model.detail) {
    return actionHints([reply, " · ", actions, " · ", back], style);
  }
  if (compact) {
    return actionHints([actions, " · ", focus, " · ", back], style);
  }
  if (model.width < 60) {
    return actionHints([actions, " · ", back, "\n", primary, " · ", focus], style);
  }
  return actionHints([primary, " · ", actions, " · ", focus, " · ", back], style);
}
function backLabel(model: ControlModel): string {
  if (!model.menu) {
    return model.compact ? "Esc" : "Esc Back";
  }
  let suffix = "";
  if (!model.compact) {
    suffix = model.detail ? " Back to details" : " Back to conversation";
  }
  return `${primaryKey("tui.select.cancel")}${suffix}`.trim();
}
interface FrameModel {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly status: string;
  readonly unread: boolean;
  readonly menu?: Component;
  readonly detail: boolean;
  readonly footer: Component;
  readonly viewport: Component;
  readonly editorViewport: Component;
  readonly editorRows: number;
  readonly composeLabel: string;
  readonly notice: AgentVisit["notice"];
  readonly quoteTitle?: string;
  readonly act: (action: string) => void;
}
function header(model: FrameModel, theme: Theme, showStatus: boolean): Container {
  const c = new Container(),
    width = Math.max(1, model.width - 2);
  c.addChild(new Text(theme.fg("accent", theme.bold(truncateToWidth(model.title, width))), 0, 0));
  if (showStatus) {
    c.addChild(
      actionHints(
        [
          ...(model.unread
            ? [
                "New activity · ",
                ...(model.menu
                  ? []
                  : [{ text: "Alt+L latest", run: () => model.act("latest") }, " · "]),
              ]
            : []),
          model.status,
        ],
        (text) => theme.fg("dim", text),
        "...",
      ),
    );
  }
  return c;
}
function composer(model: FrameModel, theme: Theme, compact: boolean): Container {
  const c = new Container(),
    width = Math.max(1, model.width - 2);
  if (!model.detail) {
    const notice = model.notice;
    if (notice !== undefined) {
      const parts =
        typeof notice === "string"
          ? [readableText(notice).replace(/\s+/g, " ").trim()]
          : [
              CONTINUE_NOTICES[notice.continue],
              { text: CONTINUE_HINT, run: () => model.act("continue") },
              ".",
            ];
      c.addChild(actionHints(parts, (text) => theme.fg("warning", text), "..."));
    }
    if (model.quoteTitle !== undefined) {
      c.addChild(
        actionHints(
          [
            "Quote · ",
            { text: "Alt+Q remove", run: () => model.act("unquote") },
            ": ",
            model.quoteTitle,
          ],
          (text) => theme.fg("dim", text),
          "...",
        ),
      );
    }
    if (!compact) {
      c.addChild(new Text(theme.fg("accent", truncateToWidth(model.composeLabel, width)), 0, 0));
    }
    c.addChild(model.editorViewport);
  }
  c.addChild(model.footer);
  return c;
}
export function conversationFrame(
  model: FrameModel,
  theme: Theme,
): { component: Component; editorHeight: number; historyHeight: number } {
  const width = Math.max(1, model.width - 2),
    compact = model.height < 16;
  const contentRows = model.menu
    ? model.menu.render(width).length
    : 1 +
      (model.detail
        ? 0
        : 1 +
          Number(!compact) +
          Number(model.notice !== undefined) +
          Number(model.quoteTitle !== undefined));
  const required = 1 + model.footer.render(width).length + contentRows;
  const showStatus = model.height > required,
    framed = model.height >= required + Number(showStatus) + 2;
  const root = new Container(),
    body = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  const title = header(model, theme, showStatus);
  body.addChild(title);
  let editorHeight = Infinity,
    historyHeight = 1;
  if (model.menu) {
    body.addChild(model.menu);
    body.addChild(model.footer);
  } else {
    const bottom = composer(model, theme, compact);
    const space = model.height - Number(framed) * 2 - title.render(width).length;
    const bottomRows = bottom.render(width).length;
    if (!model.detail) {
      editorHeight = Math.max(1, space - (bottomRows - model.editorRows) - 1);
    }
    const clippedRows = model.detail
      ? bottomRows
      : bottomRows - model.editorRows + Math.min(model.editorRows, editorHeight);
    historyHeight = Math.max(1, space - clippedRows);
    body.addChild(model.viewport);
    body.addChild(bottom);
  }
  if (framed) {
    root.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
  }
  root.addChild(body);
  if (framed) {
    root.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
  }
  return { component: root, editorHeight, historyHeight };
}
