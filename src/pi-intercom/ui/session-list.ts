import type { Component, SelectItem, TUI } from "@earendil-works/pi-tui";
import { SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "../types.ts";
import { formatSessionTarget } from "../session-targets.ts";

function sessionTitle(session: SessionInfo, allSessions: SessionInfo[], suffix?: string): string {
  return `${session.name || "Unnamed session"} (${formatSessionTarget(session, allSessions)})${suffix ? ` [${suffix}]` : ""}`;
}

export class SessionListOverlay implements Component {
  private selectList: SelectList;
  private allSessions: SessionInfo[];
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private currentSession: SessionInfo;
  private sessions: SessionInfo[];
  private done: (result: SessionInfo | undefined) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    currentSession: SessionInfo,
    sessions: SessionInfo[],
    done: (result: SessionInfo | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.currentSession = currentSession;
    this.sessions = sessions;
    this.done = done;
    this.allSessions = [currentSession, ...sessions];
    const items: SelectItem[] = sessions.map((session) => ({
      value: session.id,
      label: sessionTitle(session, this.allSessions, session.cwd === currentSession.cwd ? "same cwd" : undefined),
      description: `${session.cwd} • ${session.model}`,
    }));
    this.selectList = new SelectList(items, 8, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("dim", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("dim", text),
    });
    this.selectList.onSelect = (item) => done(sessions.find((session) => session.id === item.value));
    this.selectList.onCancel = () => done(undefined);
  }

  invalidate(): void {
    this.selectList.invalidate();
  }

  handleInput(data: string): void {
    if (this.sessions.length === 0) {
      if (this.keybindings.matches(data, "tui.select.cancel")) this.done(undefined);
    } else {
      this.selectList.handleInput(data);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 3) return [truncateToWidth("Intercom", width)];
    const innerWidth = Math.min(width, 88);
    const contentWidth = Math.max(1, innerWidth - 2);
    const footer = this.sessions.length === 0
      ? `${this.keybindings.getKeys("tui.select.cancel").join("/")}: Close`
      : `${this.keybindings.getKeys("tui.select.confirm").join("/")}: Message • ${this.keybindings.getKeys("tui.select.cancel").join("/")}: Close`;
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines = [
      border(`╭${"─".repeat(contentWidth)}╮`),
      row(this.theme.bold(" Current Session")),
      border(`├${"─".repeat(contentWidth)}┤`),
      row(`  ${this.theme.fg("dim", sessionTitle(this.currentSession, this.allSessions, "self"))}`),
      row(`  ${this.theme.fg("dim", `${this.currentSession.cwd} • ${this.currentSession.model}`)}`),
      border(`├${"─".repeat(contentWidth)}┤`),
      row(this.theme.bold(" Other Sessions")),
    ];

    if (this.sessions.length === 0) {
      lines.push(
        row(this.theme.fg("dim", " No other intercom-connected sessions")),
        row(this.theme.fg("dim", " Start another session with: pi --name worker")),
        row(this.theme.fg("dim", " Then run intercom({ action: \"list\" }) again")),
      );
    } else {
      lines.push(...this.selectList.render(contentWidth).map(row));
    }

    lines.push(
      border(`├${"─".repeat(contentWidth)}┤`),
      row(this.theme.fg("dim", ` ${footer}`)),
      border(`╰${"─".repeat(contentWidth)}╯`),
    );
    return lines;
  }
}
