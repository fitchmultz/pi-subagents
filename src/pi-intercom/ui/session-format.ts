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
  return `pi --name worker --extension ${shellQuote(path.join(PACKAGE_ROOT, "src", "index.ts"))}`;
}
function duplicateNames(sessions: readonly SessionInfo[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const session of sessions) {
    const name = session.name?.toLowerCase();
    if (name === undefined || name === "") {
      continue;
    }
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return duplicates;
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
const SELF_HINT =
  "self target unavailable; choose a peer from Other sessions; use pending/reply for inbound asks";
/** Delivery guidance once per list. Each row's state and accepts_asks tags say which part applies. */
function deliveryLegend(peers: readonly SessionInfo[]): string {
  return [
    "**Delivery:** send steers by default: it wakes an idle peer (a full model request for it) and reaches a busy peer at its next tool boundary. ask only if you must stay alive for a required reply. queue only for intentional delay. passive never wakes: use it for receipts and FYI that need no action.",
    ...(peers.some((peer) => peer.acceptsAsks === false)
      ? ["A default ask to an accepts_asks:false peer sends without waiting."]
      : []),
    ...(peers.some((peer) => sessionBusyState(peer) === "unknown")
      ? ["A state:unknown peer is a valid target."]
      : []),
  ].join(" ");
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
  readonly duplicates: ReadonlySet<string>;
  readonly allSessions: readonly SessionInfo[];
  readonly now: number;
}
function row(session: SessionInfo, options: RowOptions): string {
  const name = session.name === undefined || session.name === "" ? "Unnamed session" : session.name;
  const duplicate =
    session.name !== undefined &&
    session.name !== "" &&
    options.duplicates.has(session.name.toLowerCase());
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
  return `• ${name} (${target}) — Native session cwd: ${session.cwd} (${session.model})${suffix}${options.self ? `\n  ↳ ${SELF_HINT}` : ""}`;
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
/** `query` keeps the peers whose name or ID contains it, ignoring case. */
export function formatSessionListSections(
  allSessions: readonly SessionInfo[],
  id: string,
  scope: IntercomSessionScope = "all",
  query = "",
): string {
  const current = allSessions.find((session) => session.id === id);
  if (!current) {
    throw new Error("Current session is missing from intercom session list.");
  }
  const scoped = sessionsForScope(allSessions, id, scope);
  const hidden = allSessions.length - scoped.length;
  const others = scoped.filter((session) => session.id !== id);
  const wanted = query.trim().toLowerCase();
  const shown = others.filter((session) =>
    [session.name ?? "", session.id].some((value) => value.toLowerCase().includes(wanted)),
  );
  const options = {
    currentCwd: current.cwd,
    duplicates: duplicateNames(allSessions),
    allSessions,
    now: Date.now(),
  };
  const currentSection = `**Current session:**\n${row(current, { ...options, self: true })}`;
  const heading =
    wanted === "" || others.length === 0
      ? "**Other sessions:**"
      : `**Other sessions matching ${JSON.stringify(query.trim())} (${shown.length} of ${others.length}; omit \`to\` to list all):**`;
  const rows =
    others.length === 0
      ? [noPeers(hidden)]
      : shown.map((peer) => row(peer, { ...options, self: false }));
  const legend = shown.length === 0 ? [] : ["", deliveryLegend(shown)];
  const otherSection = [heading, ...rows, ...legend].join("\n");
  const hint =
    hidden > 0
      ? `\n\n${hidden} session${hidden === 1 ? "" : "s"} in other projects hidden. Use \`intercom({ action: "list", scope: "all" })\` to show every reachable session.`
      : "";
  return `${currentSection}\n\n${otherSection}${hint}`;
}
