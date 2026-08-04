import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

export interface TargetIdentity {
  id: string;
  name?: string;
}

export interface ProjectSessionIdentity extends TargetIdentity {
  cwd: string;
  projectId?: string;
}

export const MIN_SESSION_TARGET_PREFIX_LENGTH = 8;

export interface TargetResolution<T extends TargetIdentity> {
  status: "none" | "found" | "ambiguous" | "prefix_too_short";
  target?: T;
  matches: T[];
  minLength?: number;
}

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, MIN_SESSION_TARGET_PREFIX_LENGTH);
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveGitCommonDirectory(cwd: string): Promise<string | undefined> {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: path.dirname(process.execPath),
      encoding: "utf8",
      env,
      maxBuffer: 4096,
      timeout: 500,
      windowsHide: true,
    }, (error, stdout) => {
      const gitDirectory = error ? "" : stdout.trim();
      resolve(gitDirectory && !/[\0\r\n]/.test(gitDirectory)
        ? normalizedPath(path.resolve(cwd, gitDirectory))
        : undefined);
    });
  });
}

export async function resolveSessionProjectId(cwd: string): Promise<string> {
  const gitDirectory = await resolveGitCommonDirectory(cwd);
  const identity = gitDirectory ? `git:${gitDirectory}` : `cwd:${normalizedPath(cwd)}`;
  return createHash("sha256").update(identity).digest("hex");
}

function normalizedNames(sessions: TargetIdentity[]): Set<string> {
  return new Set(sessions
    .map((session) => session.name?.trim().toLowerCase())
    .filter((name): name is string => Boolean(name)));
}

export function formatSessionTarget(session: TargetIdentity, allSessions: TargetIdentity[] = [session]): string {
  const ids = allSessions.map((candidate) => candidate.id.toLowerCase());
  const names = normalizedNames(allSessions);
  const id = session.id.toLowerCase();

  for (let length = MIN_SESSION_TARGET_PREFIX_LENGTH; length < session.id.length; length += 1) {
    const prefix = id.slice(0, length);
    const uniqueIdPrefix = ids.filter((candidateId) => candidateId.startsWith(prefix)).length === 1;
    if (uniqueIdPrefix && !names.has(prefix)) {
      return session.id.slice(0, length);
    }
  }

  return session.id;
}

export function formatTargetOptions(sessions: TargetIdentity[], allSessions: TargetIdentity[] = sessions): string {
  return sessions
    .map((session) => `${session.name || shortSessionId(session.id)} → ${formatSessionTarget(session, allSessions)}`)
    .join(", ");
}

export function targetDisplayName(session: TargetIdentity, allSessions: TargetIdentity[] = [session]): string {
  if (!session.name?.trim()) {
    return session.id;
  }

  const lowerName = session.name.trim().toLowerCase();
  const duplicateName = allSessions.some((candidate) =>
    candidate.id !== session.id && candidate.name?.trim().toLowerCase() === lowerName
  );
  const nameConflictsWithOtherIdPrefix = allSessions.some((candidate) =>
    candidate.id !== session.id && candidate.id.toLowerCase().startsWith(lowerName)
  );

  return duplicateName || nameConflictsWithOtherIdPrefix
    ? `${session.name} (${formatSessionTarget(session, allSessions)})`
    : session.name;
}

export function formatPeerAwarenessHint<T extends ProjectSessionIdentity>(sessions: T[], currentSessionId: string): string | undefined {
  const current = sessions.find((session) => session.id === currentSessionId);
  if (!current) return undefined;

  const peers = sessions.filter((session) => {
    if (session.id === currentSessionId) return false;
    if (session.cwd === current.cwd) return true;
    return Boolean(current.projectId && session.projectId && session.projectId === current.projectId);
  });
  if (peers.length === 0) return undefined;

  const sameCheckout = peers.filter((session) => session.cwd === current.cwd).length;
  const peerCount = `${peers.length} other Pi session${peers.length === 1 ? " is" : "s are"}`;
  const checkoutCount = sameCheckout > 0
    ? ` (${sameCheckout} in this checkout)`
    : "";
  return `${peerCount} connected to this project${checkoutCount}. If you have not checked them for this task, use intercom({ action: "list" }) before duplicating substantial work or changing shared state. Coordinate only when work overlaps; use subagent controls for managed child runs.`;
}

export function resolveSessionTarget<T extends TargetIdentity>(sessions: T[], rawTarget: string): TargetResolution<T> {
  const target = rawTarget.trim();
  const lowerTarget = target.toLowerCase();

  const exactIdMatches = sessions.filter((session) => session.id.toLowerCase() === lowerTarget);
  if (exactIdMatches.length === 1) {
    return { status: "found", target: exactIdMatches[0], matches: exactIdMatches };
  }
  if (exactIdMatches.length > 1) {
    return { status: "ambiguous", matches: exactIdMatches };
  }

  const nameMatches = sessions.filter((session) => session.name?.trim().toLowerCase() === lowerTarget);
  const allPrefixMatches = sessions.filter((session) => session.id.toLowerCase().startsWith(lowerTarget));
  const prefixMatches = target.length >= MIN_SESSION_TARGET_PREFIX_LENGTH ? allPrefixMatches : [];
  if (target.length > 0 && target.length < MIN_SESSION_TARGET_PREFIX_LENGTH && allPrefixMatches.length > 0) {
    if (nameMatches.length > 0) {
      const matchesById = new Map<string, T>();
      for (const session of [...nameMatches, ...allPrefixMatches]) {
        matchesById.set(session.id, session);
      }
      const matches = Array.from(matchesById.values());
      if (matches.length === 1) {
        return { status: "found", target: matches[0], matches };
      }
      return { status: "ambiguous", matches };
    }
    return { status: "prefix_too_short", matches: allPrefixMatches, minLength: MIN_SESSION_TARGET_PREFIX_LENGTH };
  }

  const matchesById = new Map<string, T>();
  for (const session of [...nameMatches, ...prefixMatches]) {
    matchesById.set(session.id, session);
  }
  const matches = Array.from(matchesById.values());

  if (matches.length === 1) {
    return { status: "found", target: matches[0], matches };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", matches };
  }
  return { status: "none", matches: [] };
}
