import { execFile } from "node:child_process";
import { hash } from "node:crypto";
import path from "node:path";
import { safeLabel } from "./validation.ts";

export interface TargetIdentity {
  readonly id: string;
  readonly name?: string | undefined;
}

export interface ProjectSessionIdentity extends TargetIdentity {
  readonly cwd: string;
  readonly projectId?: string | undefined;
}

export interface SessionGitContext {
  readonly projectId: string;
  readonly gitRepo?: string | undefined;
  readonly gitBranch?: string | undefined;
}

export const MIN_SESSION_TARGET_PREFIX_LENGTH = 8;

export function nativePeerId(sessionId: string): string {
  return `pi-${hash("sha256", sessionId, "hex").slice(0, 32)}`;
}

export interface TargetResolution<T extends TargetIdentity> {
  readonly status: "none" | "found" | "ambiguous" | "prefix_too_short";
  readonly target?: T;
  readonly matches: readonly T[];
}

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, MIN_SESSION_TARGET_PREFIX_LENGTH);
}

function normalizedPath(value: string): string {
  return path.resolve(value);
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        cwd: path.dirname(process.execPath),
        encoding: "utf8",
        env: sanitizedGitEnv(),
        maxBuffer: 4096,
        timeout: 500,
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        const output = error ? "" : stdout.trim();
        resolve(output !== "" && !/[\0\r\n]/.test(output) ? output : undefined);
      },
    );
  });
}

async function resolveGitCommonDirectory(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const gitDirectory = await runGit(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  return gitDirectory === undefined ? undefined : normalizedPath(path.resolve(cwd, gitDirectory));
}

function repoNameFromGitCommonDirectory(gitDirectory: string): string | undefined {
  const base = path.basename(gitDirectory);
  const raw = base === ".git" ? path.basename(path.dirname(gitDirectory)) : base;
  const name = raw.endsWith(".git") && raw.length > 4 ? raw.slice(0, -4) : raw;
  return safeLabel(name) ? name : undefined;
}

async function resolveGitBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const branch =
    (await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)) ??
    (await runGit(cwd, ["rev-parse", "--short", "HEAD"], signal));
  return branch !== undefined && safeLabel(branch) ? branch : undefined;
}

function projectIdFromGitCommonDirectory(cwd: string, gitDirectory: string | undefined): string {
  const identity =
    gitDirectory !== undefined && gitDirectory !== ""
      ? `git:${gitDirectory}`
      : `cwd:${normalizedPath(cwd)}`;
  return hash("sha256", identity, "hex");
}

export async function resolveSessionProjectId(cwd: string): Promise<string> {
  return projectIdFromGitCommonDirectory(cwd, await resolveGitCommonDirectory(cwd));
}

export async function resolveSessionGitContext(
  cwd: string,
  signal?: AbortSignal,
): Promise<SessionGitContext> {
  const gitDirectory = await resolveGitCommonDirectory(cwd, signal);
  const projectId = projectIdFromGitCommonDirectory(cwd, gitDirectory);
  if (gitDirectory === undefined) {
    return { projectId };
  }
  const gitRepo = repoNameFromGitCommonDirectory(gitDirectory);
  const gitBranch = await resolveGitBranch(cwd, signal);
  return {
    projectId,
    ...(gitRepo !== undefined ? { gitRepo } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
  };
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

/** `at` is the `@device` ending of each target when another device will print the options. */
export function formatTargetOptions(
  sessions: readonly TargetIdentity[],
  allSessions: readonly TargetIdentity[] = sessions,
  at = "",
): string {
  return sessions
    .map(
      (session) =>
        `${session.name === undefined || session.name === "" ? shortSessionId(session.id) : session.name} → ${formatSessionTarget(session, allSessions)}${at}`,
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

function matchedTargets<T extends TargetIdentity>(matches: readonly T[]): TargetResolution<T> {
  const [target] = matches;
  if (matches.length === 1 && target !== undefined) {
    return { status: "found", target, matches };
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
