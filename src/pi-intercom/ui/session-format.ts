import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionInfo } from "../types.ts";
import type { IntercomSessionScope } from "../runtime-types.ts";
import { filterProjectSessions, formatSessionTarget } from "../session-targets.ts";
const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function localForkStartCommand(): string {
  return `pi --name worker --extension ${shellQuote(path.join(PACKAGE_ROOT, "src", "pi-intercom", "index.ts"))} --skill ${shellQuote(path.join(PACKAGE_ROOT, "skills", "pi-intercom"))}`;
}
function duplicateNames(sessions: readonly SessionInfo[]): ReadonlySet<string> {
  const names = sessions
    .map((session) => session.name?.toLowerCase())
    .filter((name): name is string => name !== undefined && name !== "");
  return new Set(names.filter((name, index) => names.indexOf(name) !== index));
}
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}
export function sessionBusyState(session: SessionInfo): "idle" | "busy" | "unknown" {
  if (session.acceptsAsks === true) {
    return "idle";
  }
  if (session.acceptsAsks === false) {
    return "busy";
  }
  const status = session.status ?? "";
  if (status === "idle" || ["idle ", "idle ·"].some((prefix) => status.startsWith(prefix))) {
    return "idle";
  }
  if (
    status === "thinking" ||
    ["thinking ", "thinking ·", "tool:"].some((prefix) => status.startsWith(prefix))
  ) {
    return "busy";
  }
  return "unknown";
}
function age(timestamp: number | undefined, now: number): string {
  return typeof timestamp === "number" && timestamp > 0
    ? `${formatDuration(Math.max(0, Math.floor((now - timestamp) / 1000)))} ago`
    : "none";
}
function guidance(session: SessionInfo, self: boolean): string {
  if (self) {
    return "self target unavailable; choose a peer from Other sessions; use pending/reply for inbound asks";
  }
  const state = sessionBusyState(session);
  if (state === "idle") {
    return "send defaults to steer and wakes; ask only if sender must stay alive for a required reply; queue only for intentional delay; passive discouraged";
  }
  if (session.acceptsAsks === false) {
    return "send defaults to steer; ask only if sender must stay alive for a required reply (default sends without waiting when peer is busy); queue only for intentional delay; passive discouraged";
  }
  if (state === "busy") {
    return "send defaults to steer at the next tool boundary; ask only if sender must stay alive for a required reply; queue only for intentional delay; passive discouraged";
  }
  return "state unknown; target is valid; send defaults to steer; ask only if sender must stay alive for a required reply; queue only for intentional delay; passive discouraged";
}
function healthTags(session: SessionInfo, now: number): readonly string[] {
  const tags = [
    `state:${sessionBusyState(session)}`,
    `accepts_asks:${session.acceptsAsks === undefined ? "unknown" : String(session.acceptsAsks)}`,
    `pending_asks:${typeof session.pendingAsks === "number" ? session.pendingAsks : "unknown"}`,
    `last_intercom_activity:${age(session.lastIntercomActivity, now)}`,
  ];
  if (typeof session.lastSeen === "number") {
    tags.push(
      `last_seen:${formatDuration(Math.max(0, Math.floor((now - session.lastSeen) / 1000)))} ago`,
    );
  }
  return tags;
}
interface RowOptions {
  readonly currentCwd: string;
  readonly self: boolean;
  readonly duplicates: (name: string) => boolean;
  readonly allSessions: readonly SessionInfo[];
  readonly now: number;
}
function row(session: SessionInfo, options: RowOptions): string {
  const name = session.name === undefined || session.name === "" ? "Unnamed session" : session.name;
  const duplicate =
    session.name !== undefined &&
    session.name !== "" &&
    options.duplicates(session.name.toLowerCase());
  let location: string | undefined;
  if (options.self) {
    location = "self";
  } else if (session.cwd === options.currentCwd) {
    location = "same native session cwd";
  }
  const tags = [
    location,
    session.status,
    duplicate ? `target:${formatSessionTarget(session, options.allSessions)}` : undefined,
    ...healthTags(session, options.now),
  ].filter((tag): tag is string => tag !== undefined && tag !== "");
  const target = formatSessionTarget(session, options.allSessions);
  const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  return `• ${name} (${target}) — Native session cwd: ${session.cwd} (${session.model})${suffix}\n  ↳ ${guidance(session, options.self)}`;
}
export function sessionsForScope(
  sessions: readonly SessionInfo[],
  currentSessionId: string,
  scope: IntercomSessionScope,
): readonly SessionInfo[] {
  return scope === "all" ? sessions : filterProjectSessions(sessions, currentSessionId);
}
function noPeers(hidden: number): string {
  if (hidden > 0) {
    return "No other sessions connected in this project.";
  }
  return `No other sessions connected. Start another intercom-enabled session with \`pi --name worker\`, then run \`intercom({ action: "list" })\` again. If you are dogfooding this local fork without installing it, start the peer with \`${localForkStartCommand()}\`.`;
}
export function formatSessionListSections(
  allSessions: readonly SessionInfo[],
  id: string,
  scope: IntercomSessionScope = "project",
): string {
  const current = allSessions.find((session) => session.id === id);
  if (!current) {
    throw new Error("Current session is missing from intercom session list.");
  }
  const scoped = sessionsForScope(allSessions, id, scope);
  const hidden = allSessions.length - scoped.length;
  const others = scoped.filter((session) => session.id !== id);
  const options = {
    currentCwd: current.cwd,
    duplicates: (name: string) => duplicateNames(allSessions).has(name),
    allSessions,
    now: Date.now(),
  };
  const currentSection = `**Current session:**\n${row(current, { ...options, self: true })}`;
  const otherSection = `**Other sessions:**\n${others.length === 0 ? noPeers(hidden) : others.map((session) => row(session, { ...options, self: false })).join("\n")}`;
  const hint =
    hidden > 0
      ? `\n\n${hidden} session${hidden === 1 ? "" : "s"} in other projects hidden. Use \`intercom({ action: "list", scope: "all" })\` to show every connected session.`
      : "";
  return `${currentSection}\n\n${otherSection}${hint}`;
}
