import { lstatSync, mkdirSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { readBridgeFile, writeBridgeJson } from "./bridge-files.ts";
import { isUnknownArray, hasErrorCode } from "../shared/unknown.ts";
import { Fault, label, object } from "./bridge-protocol.ts";
import { resolveSessionTarget, nativePeerId } from "./session-targets.ts";
import type { SessionInfo } from "./types.ts";

export interface GroupDefinition {
  readonly name: string;
  readonly members?: readonly string[];
  readonly namePattern?: string;
  readonly cwdPattern?: string;
}
const GROUP_LIMIT = 64;
function normalizedGroup(value: unknown): Record<string, unknown> {
  const input = object(value, ["name", "members", "namePattern", "cwdPattern", "match"]);
  if (input.match === undefined) {
    return input;
  }
  if ([input.members, input.namePattern, input.cwdPattern].some((field) => field !== undefined)) {
    throw new Fault(400, "invalid_input", "Use match or canonical selectors, not both.");
  }
  const match =
    typeof input.match === "string"
      ? { nameglob: input.match }
      : object(input.match, ["id", "nameglob", "cwd"]);
  return {
    name: input.name,
    members: typeof match.id === "string" ? [match.id] : match.id,
    namePattern: match.nameglob,
    cwdPattern: match.cwd,
  };
}
export function groupDefinition(value: unknown): GroupDefinition {
  const input = normalizedGroup(value);
  const name = label(input.name, "group name", 64).trim();
  if (
    input.members !== undefined &&
    (!isUnknownArray(input.members) || input.members.length > 256)
  ) {
    throw new Fault(400, "invalid_input", "members must contain at most 256 peer IDs/names.");
  }
  const members = isUnknownArray(input.members)
    ? [...new Set(input.members.map((member) => label(member, "member", 512).trim()))]
    : undefined;
  const namePattern =
    input.namePattern === undefined ? undefined : label(input.namePattern, "name pattern", 128);
  const cwdPattern =
    input.cwdPattern === undefined ? undefined : label(input.cwdPattern, "cwd pattern", 512);
  if (members === undefined && namePattern === undefined && cwdPattern === undefined) {
    throw new Fault(400, "invalid_input", "Define explicit members or at least one glob pattern.");
  }
  return { name, members, namePattern, cwdPattern };
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Fault(
      503,
      "state_unavailable",
      "Group stateDir must be owned by the current user with mode 0700.",
    );
  }
}
export function nativePeers(
  peers: readonly SessionInfo[],
  source?: string | null,
): readonly SessionInfo[] {
  return peers.filter((peer) => /^pi-[a-f0-9]{32}$/.test(peer.id) && peer.id !== source);
}
export interface GroupTargets {
  readonly peers: readonly SessionInfo[];
  readonly errors: readonly { readonly member: string; readonly code: string }[];
}
export class Groups {
  private readonly stateDir: string;
  constructor(stateDir: string) {
    this.stateDir = stateDir;
    privateDirectory(stateDir);
  }
  private file(fingerprint: string): string {
    if (!/^[a-fA-F0-9]{64}$/.test(fingerprint)) {
      throw new Fault(403, "unauthorized", "Invalid identity.");
    }
    return join(this.stateDir, `groups-${fingerprint.toLowerCase()}.json`);
  }
  list(fingerprint: string): readonly GroupDefinition[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readBridgeFile(this.file(fingerprint), true, 1024 * 1024).toString("utf8"));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    if (!isUnknownArray(raw) || raw.length > GROUP_LIMIT) {
      throw new Fault(503, "state_unavailable", "Invalid group state.");
    }
    return raw.map(groupDefinition);
  }
  upsert(fingerprint: string, group: GroupDefinition): readonly GroupDefinition[] {
    privateDirectory(this.stateDir);
    const groups = this.list(fingerprint).filter((entry) => entry.name !== group.name);
    if (groups.length >= GROUP_LIMIT) {
      throw new Fault(409, "group_limit", "At most 64 groups are allowed per identity.");
    }
    groups.push(groupDefinition(group));
    const file = this.file(fingerprint);
    const serialized = JSON.stringify(groups);
    if (Buffer.byteLength(serialized) > 1024 * 1024) {
      throw new Fault(
        413,
        "state_too_large",
        "Group definitions exceed the 1 MiB identity budget.",
      );
    }
    writeBridgeJson(file, groups);
    return groups;
  }
  targets(
    fingerprint: string,
    name: string | undefined,
    peers: readonly SessionInfo[],
  ): GroupTargets {
    if (name === undefined) {
      return { peers: nativePeers(peers), errors: [] };
    }
    const group = this.list(fingerprint).find((entry) => entry.name === name);
    if (!group) {
      throw new Fault(404, "unknown_group", "Define this group before sending to it.");
    }
    return selectTargets(group, nativePeers(peers));
  }
}
function selectTargets(group: GroupDefinition, peers: readonly SessionInfo[]): GroupTargets {
  const selected = new Map<string, SessionInfo>();
  const errors: { member: string; code: string }[] = [];
  for (const member of group.members ?? []) {
    const result = resolveSessionTarget(peers, member);
    const target = result.target ?? peers.find((peer) => peer.id === nativePeerId(member));
    if (target) {
      selected.set(target.id, target);
    } else {
      errors.push({ member, code: result.status === "none" ? "peer_offline" : "ambiguous_target" });
    }
  }
  if (group.namePattern !== undefined || group.cwdPattern !== undefined) {
    for (const peer of peers) {
      if (matchesSelectors(group, peer)) {
        selected.set(peer.id, peer);
      }
    }
  }
  return { peers: [...selected.values()], errors };
}
function matchesSelectors(group: GroupDefinition, peer: SessionInfo): boolean {
  return (
    (group.namePattern === undefined || matchesGlob(peer.name ?? "", group.namePattern)) &&
    (group.cwdPattern === undefined || matchesGlob(peer.cwd, group.cwdPattern))
  );
}
