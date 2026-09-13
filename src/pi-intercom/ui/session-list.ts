import type { Component, SelectItem, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Box, Container, SelectList, Text, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { actionHints } from "../../tui/action-hints.ts";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "../types.ts";
import { formatSessionTarget } from "../session-targets.ts";

function sessionTitle(session: SessionInfo, allSessions: SessionInfo[], suffix?: string): string {
  return `${session.name || "Unnamed session"} (${formatSessionTarget(session, allSessions)})${suffix ? ` [${suffix}]` : ""}`;
}

export class SessionListOverlay extends Container {
  private completed = false;
  private selectList: SelectList;
  private allSessions: SessionInfo[];
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private currentSession: SessionInfo;
  private sessions: SessionInfo[];
  private done: (result: SessionInfo | undefined) => void;
  private hiddenSessionCount: number;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    currentSession: SessionInfo,
    sessions: SessionInfo[],
    done: (result: SessionInfo | undefined) => void,
    hiddenSessionCount = 0,
    allSessions = [currentSession, ...sessions],
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.currentSession = currentSession;
    this.sessions = sessions;
    this.done = done;
    this.hiddenSessionCount = hiddenSessionCount;
    this.allSessions = allSessions;
    const items: SelectItem[] = sessions.map((session) => ({
      value: session.id,
      label: sessionTitle(session, this.allSessions, session.cwd === currentSession.cwd ? "same native session cwd" : undefined),
      description: `${session.topics?.filter((topic) => topic.resource && topic.ownership === "held").map((topic) => `Using ${topic.resource}`).join(" · ") || `Native session cwd: ${session.cwd}`} • ${session.model}`,
    }));
    this.selectList = new SelectList(items, 8, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("dim", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("dim", text),
    });
    this.selectList.onSelect = (item) => this.finish(sessions.find((session) => session.id === item.value));
    this.selectList.onCancel = () => this.finish();
  }

  private finish(result?: SessionInfo): void {
    if (this.completed) return;
    this.completed = true;
    this.done(result);
  }

  dispose(): void { this.completed = true; }

  handleMouse(event: TuiMouseEvent) {
    const width = Math.min(event.width, 88);
    if (this.completed || event.x >= width) return;
    return super.handleMouse({ ...event, width });
  }

  handleInput(data: string): void {
    if (this.completed) return;
    if (this.sessions.length === 0) {
      if (this.keybindings.matches(data, "tui.select.cancel")) this.finish();
    } else {
      this.selectList.handleInput(data);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.clear();
    if (width < 3) return [truncateToWidth("Intercom", width)];
    const innerWidth = Math.min(width, 88);
    const contentWidth = Math.max(1, innerWidth - 2);
    const message = [this.keybindings.getKeys("tui.select.confirm").join("/"), "Message"].filter(Boolean).join(": ");
    const close = [this.keybindings.getKeys("tui.select.cancel").join("/"), "Close"].filter(Boolean).join(": ");
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
      row(`  ${this.theme.fg("dim", sessionTitle(this.currentSession, this.allSessions, "self"))}`),
      row(`  ${this.theme.fg("dim", `Native session cwd: ${this.currentSession.cwd} • ${this.currentSession.model}`)}`),
      border(`├${"─".repeat(contentWidth)}┤`),
      row(this.theme.bold(" Other Sessions")),
    ];

    this.addChild(new Text(lines.join("\n"), 0, 0));
    if (this.sessions.length === 0) {
      this.addChild(new Text((this.hiddenSessionCount > 0
        ? [
            row(this.theme.fg("dim", " No other sessions in this project")),
            row(this.theme.fg("dim", ` ${this.hiddenSessionCount} in other project${this.hiddenSessionCount === 1 ? "" : "s"} hidden`)),
            row(this.theme.fg("dim", " Run /intercom all to show every connected session")),
          ]
        : [
            row(this.theme.fg("dim", " No other intercom-connected sessions")),
            row(this.theme.fg("dim", " Start another session with: pi --name worker")),
            row(this.theme.fg("dim", " Then run intercom({ action: \"list\" }) again")),
          ]).join("\n"), 0, 0));
    } else {
      this.addChild(framed(this.selectList));
      if (this.hiddenSessionCount > 0) {
        this.addChild(new Text(row(this.theme.fg("dim", ` ${this.hiddenSessionCount} other-project session${this.hiddenSessionCount === 1 ? "" : "s"} hidden · /intercom all`)), 0, 0));
      }
    }

    this.addChild(new Text(border(`├${"─".repeat(contentWidth)}┤`), 0, 0));
    this.addChild(framed(actionHints([
      " ", ...(this.sessions.length ? [{ text: message, run: () => { const item = this.selectList.getSelectedItem(); if (item) this.selectList.onSelect?.(item); } }, " • "] : []),
      { text: close, run: () => this.finish() },
    ], (text) => this.theme.fg("dim", text), "")));
    this.addChild(new Text(border(`╰${"─".repeat(contentWidth)}╯`), 0, 0));
    return super.render(innerWidth);
  }
}
