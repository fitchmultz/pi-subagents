import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

export interface TargetIdentity {
  readonly id: string;
  readonly name?: string;
}

export interface ProjectSessionIdentity extends TargetIdentity {
  readonly cwd: string;
  readonly projectId?: string;
}

export const MIN_SESSION_TARGET_PREFIX_LENGTH = 8;

export interface TargetResolution<T extends TargetIdentity> {
  readonly status: "none" | "found" | "ambiguous" | "prefix_too_short";
  readonly target?: T;
  readonly matches: readonly T[];
  readonly minLength?: number;
}

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, MIN_SESSION_TARGET_PREFIX_LENGTH);
}

function normalizedPath(value: string): string {
  return path.resolve(value);
}

function resolveGitCommonDirectory(cwd: string): Promise<string | undefined> {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: path.dirname(process.execPath),
        encoding: "utf8",
        env,
        maxBuffer: 4096,
        timeout: 500,
      },
      (error, stdout) => {
        const gitDirectory = error ? "" : stdout.trim();
        resolve(
          gitDirectory !== "" && !/[\0\r\n]/.test(gitDirectory)
            ? normalizedPath(path.resolve(cwd, gitDirectory))
            : undefined,
        );
      },
    );
  });
}

export async function resolveSessionProjectId(cwd: string): Promise<string> {
  const gitDirectory = await resolveGitCommonDirectory(cwd);
  const identity =
    gitDirectory !== undefined && gitDirectory !== ""
      ? `git:${gitDirectory}`
      : `cwd:${normalizedPath(cwd)}`;
  return createHash("sha256").update(identity).digest("hex");
}

function normalizedNames(sessions: readonly TargetIdentity[]): Set<string> {
  return new Set(
    sessions
      .map((session) => session.name?.trim().toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );
}

export function formatSessionTarget(
  session: TargetIdentity,
  allSessions: readonly TargetIdentity[] = [session],
): string {
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

export function formatTargetOptions(
  sessions: readonly TargetIdentity[],
  allSessions: readonly TargetIdentity[] = sessions,
): string {
  return sessions
    .map(
      (session) =>
        `${session.name === undefined || session.name === "" ? shortSessionId(session.id) : session.name} → ${formatSessionTarget(session, allSessions)}`,
    )
    .join(", ");
}

export function targetDisplayName(
  session: TargetIdentity,
  allSessions: readonly TargetIdentity[] = [session],
): string {
  if (session.name === undefined || session.name.trim() === "") {
    return session.id;
  }

  const lowerName = session.name.trim().toLowerCase();
  const duplicateName = allSessions.some(
    (candidate) =>
      candidate.id !== session.id && candidate.name?.trim().toLowerCase() === lowerName,
  );
  const nameConflictsWithOtherIdPrefix = allSessions.some(
    (candidate) => candidate.id !== session.id && candidate.id.toLowerCase().startsWith(lowerName),
  );

  return duplicateName || nameConflictsWithOtherIdPrefix
    ? `${session.name} (${formatSessionTarget(session, allSessions)})`
    : session.name;
}

// The hint is deliberately a constant: it is appended to the system prompt,
// which is the very start of the provider prompt-cache prefix. Any per-turn
// variation there (live peer counts, checkout counts) invalidates the entire
// cached context for every turn in which fleet membership changed, which is
// expensive on large sessions. Live details belong behind intercom list.
export const PEER_AWARENESS_HINT = `Other Pi sessions may be connected to this project. Use load_intercom({}) if needed, then intercom({ action: "list" }) before changing shared state or coordinating known overlapping work. Routine standalone read-only tasks do not need a peer check. Coordinate only when work overlaps; use subagent controls for managed child runs.`;

export function filterProjectSessions<T extends ProjectSessionIdentity>(
  sessions: readonly T[],
  currentSessionId: string,
): T[] {
  const current = sessions.find((session) => session.id === currentSessionId);
  if (!current) {
    return [];
  }

  return sessions.filter(
    (session) =>
      session.id === currentSessionId ||
      session.cwd === current.cwd ||
      (current.projectId !== undefined &&
        current.projectId !== "" &&
        session.projectId !== undefined &&
        session.projectId !== "" &&
        session.projectId === current.projectId),
  );
}

export function formatPeerAwarenessHint(
  sessions: readonly ProjectSessionIdentity[],
  currentSessionId: string,
): string | undefined {
  return filterProjectSessions(sessions, currentSessionId).some(
    (session) => session.id !== currentSessionId,
  )
    ? PEER_AWARENESS_HINT
    : undefined;
}

function matchedTargets<T extends TargetIdentity>(matches: readonly T[]): TargetResolution<T> {
  if (matches.length === 1) {
    return { status: "found", target: matches[0], matches };
  }
  return matches.length > 1 ? { status: "ambiguous", matches } : { status: "none", matches: [] };
}
function shortTargetResolution<T extends TargetIdentity>(
  names: readonly T[],
  prefixes: readonly T[],
): TargetResolution<T> {
  if (names.length === 0) {
    return {
      status: "prefix_too_short",
      matches: prefixes,
      minLength: MIN_SESSION_TARGET_PREFIX_LENGTH,
    };
  }
  const byId = new Map<string, T>();
  for (const session of [...names, ...prefixes]) {
    byId.set(session.id, session);
  }
  return matchedTargets([...byId.values()]);
}
export function resolveSessionTarget<T extends TargetIdentity>(
  sessions: readonly T[],
  rawTarget: string,
): TargetResolution<T> {
  const target = rawTarget.trim();
  const lowerTarget = target.toLowerCase();

  const exactIdMatches = sessions.filter((session) => session.id.toLowerCase() === lowerTarget);
  if (exactIdMatches.length > 0) {
    return matchedTargets(exactIdMatches);
  }

  const nameMatches = sessions.filter(
    (session) => session.name?.trim().toLowerCase() === lowerTarget,
  );
  const allPrefixMatches = sessions.filter((session) =>
    session.id.toLowerCase().startsWith(lowerTarget),
  );
  const prefixMatches = target.length >= MIN_SESSION_TARGET_PREFIX_LENGTH ? allPrefixMatches : [];
  if (
    target.length > 0 &&
    target.length < MIN_SESSION_TARGET_PREFIX_LENGTH &&
    allPrefixMatches.length > 0
  ) {
    return shortTargetResolution(nameMatches, allPrefixMatches);
  }

  const matchesById = new Map<string, T>();
  for (const session of [...nameMatches, ...prefixMatches]) {
    matchesById.set(session.id, session);
  }
  return matchedTargets(Array.from(matchesById.values()));
}
