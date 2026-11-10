import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionInfo } from "../types.ts";
import type { IntercomSessionScope } from "../runtime-types.ts";
import type { DeviceListing } from "../devices.ts";
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
  "self target unavailable; choose a peer below; use pending/reply for inbound asks";
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
  /** The caller's cwd. Absent for a session on another device: paths there are not comparable. */
  readonly currentCwd?: string;
  readonly self: boolean;
  readonly duplicates: ReadonlySet<string>;
  readonly allSessions: readonly SessionInfo[];
  readonly now: number;
  /** The alias of the other device that the session runs on: its targets end in `@device`. */
  readonly device?: string;
}
function location(session: SessionInfo, options: RowOptions): string | undefined {
  if (options.self) {
    return "self";
  }
  return session.cwd === options.currentCwd ? "same native session cwd" : undefined;
}
function row(session: SessionInfo, options: RowOptions): string {
  const at = options.device === undefined ? "" : `@${options.device}`;
  const name = session.name === undefined || session.name === "" ? "Unnamed session" : session.name;
  const duplicate =
    session.name !== undefined &&
    session.name !== "" &&
    options.duplicates.has(session.name.toLowerCase());
  const target = `${formatSessionTarget(session, options.allSessions)}${at}`;
  const tags = [
    location(session, options),
    session.status,
    duplicate ? `target:${target}` : undefined,
    ...healthTags(session, options.now),
  ].filter((tag): tag is string => tag !== undefined && tag !== "");
  const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  return `• ${name}${at} (${target}) — Native session cwd: ${session.cwd} (${session.model})${suffix}${options.self ? `\n  ↳ ${SELF_HINT}` : ""}`;
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
type PeerState = ReturnType<typeof sessionBusyState>;
const PEER_STATES: readonly PeerState[] = ["idle", "busy", "unknown"];
function stateCounts(sessions: readonly SessionInfo[]): string {
  return PEER_STATES.map((state) => ({
    state,
    count: sessions.filter((session) => sessionBusyState(session) === state).length,
  }))
    .filter(({ count }) => count > 0)
    .map(({ state, count }) => `${count} ${state}`)
    .join(", ");
}
function projectKey(session: SessionInfo): string {
  return session.projectId === undefined || session.projectId === ""
    ? session.cwd
    : session.projectId;
}
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
/** Same-project sessions sit together: projects by their first cwd, then sessions by name. */
function byProjectThenName(sessions: readonly SessionInfo[]): readonly SessionInfo[] {
  const firstCwd = new Map<string, string>();
  for (const session of sessions) {
    const known = firstCwd.get(projectKey(session));
    if (known === undefined || session.cwd < known) {
      firstCwd.set(projectKey(session), session.cwd);
    }
  }
  return sessions
    .map((session) => ({
      session,
      key: [
        firstCwd.get(projectKey(session)) ?? session.cwd,
        projectKey(session),
        (session.name ?? "").toLowerCase(),
        session.id,
      ].join("\0"),
    }))
    .toSorted((left, right) => compareText(left.key, right.key))
    .map(({ session }) => session);
}
function isChild(session: SessionInfo): boolean {
  return session.parentSessionId !== undefined;
}
function matching(sessions: readonly SessionInfo[], query: string): readonly SessionInfo[] {
  const wanted = query.toLowerCase();
  return sessions.filter((session) =>
    [session.name ?? "", session.id].some((value) => value.toLowerCase().includes(wanted)),
  );
}
/** What a list prints. A child is a session with a parent; every other session is a main. */
export interface SessionListView {
  readonly scope?: IntercomSessionScope | undefined;
  /** Keeps the peers whose name or ID contains it, ignoring case. */
  readonly query?: string | undefined;
  /** Prints every child row instead of the one-line summary. */
  readonly children?: boolean | undefined;
}
interface BlockView {
  /** The caller's own kind is labelled "Other": the caller is in neither block. */
  readonly callerIsChild: boolean;
  readonly scope: IntercomSessionScope;
  readonly query: string;
  readonly childRows: boolean;
  readonly render: (session: SessionInfo) => string;
}
interface Block {
  readonly lines: readonly string[];
  /** The targets this block offers: the rows it prints and the children it only counts. */
  readonly peers: readonly SessionInfo[];
}
function mainBlock(mains: readonly SessionInfo[], view: BlockView): Block {
  const label = view.callerIsChild ? "Main sessions" : "Other main sessions";
  const peers = matching(byProjectThenName(mains), view.query);
  const heading =
    view.query === ""
      ? `**${label} (${mains.length}):**`
      : `**${label} matching ${JSON.stringify(view.query)} (${peers.length} of ${mains.length}; omit \`to\` to list all):**`;
  return { lines: [heading, ...peers.map(view.render)], peers };
}
/** One summary line unless the caller asks for the rows or `query` matches some. */
function childBlock(children: readonly SessionInfo[], view: BlockView): Block {
  const label = `${view.callerIsChild ? "Other child" : "Child"} sessions in your group`;
  if (children.length === 0) {
    return { lines: view.childRows ? [`**${label} (0):**`] : [], peers: [] };
  }
  if (view.query !== "") {
    const peers = matching(children, view.query);
    const heading = `**${label} matching ${JSON.stringify(view.query)} (${peers.length} of ${children.length}):**`;
    return { lines: [heading, ...peers.map(view.render)], peers };
  }
  const heading = `**${label} (${children.length}: ${stateCounts(children)}):**`;
  if (view.childRows) {
    return { lines: [heading, ...children.map(view.render)], peers: children };
  }
  const call = `intercom({ action: "list", ${view.scope === "project" ? 'scope: "project", ' : ""}children: true })`;
  return {
    lines: [
      `${heading} rows not printed; each is a valid target by name or ID. Print them with \`${call}\`, or only the matching ones with \`to\`.`,
    ],
    peers: children,
  };
}
function hiddenHint(hidden: number): readonly string[] {
  return hidden > 0
    ? [
        `${hidden} session${hidden === 1 ? "" : "s"} in other projects hidden. Use \`intercom({ action: "list", scope: "all" })\` to show every reachable session.`,
      ]
    : [];
}
/** Main sessions first, then the child sessions of the caller's group. */
export function formatSessionListSections(
  allSessions: readonly SessionInfo[],
  id: string,
  view: SessionListView = {},
): string {
  const current = allSessions.find((session) => session.id === id);
  if (!current) {
    throw new Error("Current session is missing from intercom session list.");
  }
  const scope = view.scope ?? "all";
  const scoped = sessionsForScope(allSessions, id, scope);
  const hidden = allSessions.length - scoped.length;
  const others = scoped.filter((session) => session.id !== id);
  const options = {
    currentCwd: current.cwd,
    duplicates: duplicateNames(allSessions),
    allSessions,
    now: Date.now(),
  };
  const blockView: BlockView = {
    callerIsChild: isChild(current),
    scope,
    query: (view.query ?? "").trim(),
    childRows: view.children === true,
    render: (peer) => row(peer, { ...options, self: false }),
  };
  const mains = mainBlock(
    others.filter((session) => !isChild(session)),
    blockView,
  );
  const children = childBlock(others.filter(isChild), blockView);
  const peers = [...mains.peers, ...children.peers];
  return [
    ["**Current session:**", row(current, { ...options, self: true })],
    [...mains.lines, ...(others.length === 0 ? [noPeers(hidden)] : [])],
    children.lines,
    peers.length === 0 ? [] : [deliveryLegend(peers)],
    hiddenHint(hidden),
  ]
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}
function deviceBlock(listing: DeviceListing, query: string): string {
  if ("failure" in listing) {
    return `**${listing.device}:** ${listing.failure}`;
  }
  const { device, sessions, now } = listing;
  if (sessions.length === 0) {
    return `**Main sessions on ${device} (0):** no Pi session is connected there.`;
  }
  const options = { self: false, duplicates: duplicateNames(sessions), allSessions: sessions, now };
  const peers = matching(byProjectThenName(sessions), query);
  const count =
    query === ""
      ? `(${sessions.length})`
      : `matching ${JSON.stringify(query)} (${peers.length} of ${sessions.length})`;
  return [
    `**Main sessions on ${device} ${count}:**`,
    ...peers.map((peer) => row(peer, { ...options, device })),
  ].join("\n");
}
/** One block per other device: its mains as `name@device`, with ages on that device's clock. */
export function formatDeviceListings(listings: readonly DeviceListing[], query = ""): string {
  return [
    ...listings.map((listing) => deviceBlock(listing, query.trim())),
    "**Other devices:** list only. send, ask and last reach the sessions of this device.",
  ].join("\n\n");
}
