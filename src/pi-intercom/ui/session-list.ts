import {
  type Component,
  type SelectItem,
  type TUI,
  type TuiMouseEvent,
  Box,
  Container,
  SelectList,
  Text,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { actionHints } from "../../tui/action-hints.ts";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "../types.ts";
import { formatSessionTarget } from "../session-targets.ts";

function sessionTitle(
  session: SessionInfo,
  allSessions: readonly SessionInfo[],
  suffix?: string,
): string {
  return `${(session.name ?? "").length > 0 ? (session.name ?? "") : "Unnamed session"} (${formatSessionTarget(session, allSessions)})${suffix !== undefined && suffix.length > 0 ? ` [${suffix}]` : ""}`;
}

export interface SessionListOptions {
  readonly keybindings: KeybindingsManager;
  readonly currentSession: SessionInfo;
  readonly sessions: readonly SessionInfo[];
  readonly done: (result: SessionInfo | undefined) => void;
  readonly hiddenSessionCount?: number;
  readonly allSessions?: readonly SessionInfo[];
}

function sessionDescription(session: SessionInfo): string {
  const resources =
    session.topics
      ?.filter((topic) => (topic.resource ?? "").length > 0 && topic.ownership === "held")
      .map((topic) => `Using ${topic.resource ?? ""}`)
      .join(" · ") ?? "";
  return `${resources.length > 0 ? resources : `Native session cwd: ${session.cwd}`} • ${session.model}`;
}

export class SessionListOverlay extends Container {
  private completed = false;
  private readonly selectList: SelectList;
  private readonly allSessions: readonly SessionInfo[];
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly options: SessionListOptions;
  private readonly hiddenSessionCount: number;

  constructor(tui: TUI, theme: Theme, options: SessionListOptions) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    const { sessions, currentSession } = options;
    this.hiddenSessionCount = options.hiddenSessionCount ?? 0;
    this.allSessions = options.allSessions ?? [currentSession, ...sessions];
    const items: SelectItem[] = sessions.map((session) => ({
      value: session.id,
      label: sessionTitle(
        session,
        this.allSessions,
        session.cwd === currentSession.cwd ? "same native session cwd" : undefined,
      ),
      description: sessionDescription(session),
    }));
    this.selectList = new SelectList(items, 8, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("dim", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("dim", text),
    });
    this.selectList.onSelect = (item) =>
      this.finish(sessions.find((session) => session.id === item.value));
    this.selectList.onCancel = () => this.finish();
  }

  private finish(result?: SessionInfo): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.options.done(result);
  }

  dispose(): void {
    this.completed = true;
  }

  handleMouse(event: Readonly<TuiMouseEvent>): ReturnType<Container["handleMouse"]> {
    const width = Math.min(event.width, 88);
    if (this.completed || event.x >= width) {
      return;
    }
    return super.handleMouse({ ...event, width });
  }

  handleInput(data: string): void {
    if (this.completed) {
      return;
    }
    if (this.options.sessions.length === 0) {
      if (this.options.keybindings.matches(data, "tui.select.cancel")) {
        this.finish();
      }
    } else {
      this.selectList.handleInput(data);
    }
    this.tui.requestRender();
  }

  private emptyLines(row: (text: string) => string): string[] {
    const messages =
      this.hiddenSessionCount > 0
        ? [
            " No other sessions in this project",
            ` ${this.hiddenSessionCount} in other project${this.hiddenSessionCount === 1 ? "" : "s"} hidden`,
            " Run /intercom all to show every connected session",
          ]
        : [
            " No other intercom-connected sessions",
            " Start another session with: pi --name worker",
            ' Then run intercom({ action: "list" }) again',
          ];
    return messages.map((message) => row(this.theme.fg("dim", message)));
  }

  private controls(): Component {
    const message = [this.options.keybindings.getKeys("tui.select.confirm").join("/"), "Message"]
      .filter(Boolean)
      .join(": ");
    const close = [this.options.keybindings.getKeys("tui.select.cancel").join("/"), "Close"]
      .filter(Boolean)
      .join(": ");
    return actionHints(
      [
        " ",
        ...(this.options.sessions.length > 0
          ? [
              {
                text: message,
                run: () => {
                  const item = this.selectList.getSelectedItem();
                  if (item) {
                    this.selectList.onSelect?.(item);
                  }
                },
              },
              " • ",
            ]
          : []),
        { text: close, run: () => this.finish() },
      ],
      (text) => this.theme.fg("dim", text),
      "",
    );
  }

  render(width: number): string[] {
    this.clear();
    if (width < 3) {
      return [truncateToWidth("Intercom", width)];
    }
    const innerWidth = Math.min(width, 88);
    const contentWidth = Math.max(1, innerWidth - 2);
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const framed = (component: Component) => {
      const box = new Box(1, 0, (line) => row(sliceByColumn(line, 1, contentWidth)));
      box.addChild(component);
      return box;
    };
    const lines = [
      border(`╭${"─".repeat(contentWidth)}╮`),
      row(this.theme.bold(" Current Session")),
      border(`├${"─".repeat(contentWidth)}┤`),
      row(
        `  ${this.theme.fg("dim", sessionTitle(this.options.currentSession, this.allSessions, "self"))}`,
      ),
      row(
        `  ${this.theme.fg("dim", `Native session cwd: ${this.options.currentSession.cwd} • ${this.options.currentSession.model}`)}`,
      ),
      border(`├${"─".repeat(contentWidth)}┤`),
      row(this.theme.bold(" Other Sessions")),
    ];

    this.addChild(new Text(lines.join("\n"), 0, 0));
    if (this.options.sessions.length === 0) {
      this.addChild(new Text(this.emptyLines(row).join("\n"), 0, 0));
    } else {
      this.addChild(framed(this.selectList));
      if (this.hiddenSessionCount > 0) {
        this.addChild(
          new Text(
            row(
              this.theme.fg(
                "dim",
                ` ${this.hiddenSessionCount} other-project session${this.hiddenSessionCount === 1 ? "" : "s"} hidden · /intercom all`,
              ),
            ),
            0,
            0,
          ),
        );
      }
    }

    this.addChild(new Text(border(`├${"─".repeat(contentWidth)}┤`), 0, 0));
    this.addChild(framed(this.controls()));
    this.addChild(new Text(border(`╰${"─".repeat(contentWidth)}╯`), 0, 0));
    return super.render(innerWidth);
  }
}
