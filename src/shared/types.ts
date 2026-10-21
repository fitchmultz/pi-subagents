import * as os from "node:os";
import * as path from "node:path";

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function resolveTempScopeId(): string {
  if (typeof process.getuid === "function") {
    return `uid-${process.getuid()}`;
  }

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      return `user-${sanitizeTempScopeSegment(value)}`;
    }
  }

  try {
    const username = os.userInfo().username;
    if (username.length > 0) {
      return `user-${sanitizeTempScopeSegment(username)}`;
    }
  } catch {
    // Fall through to home-directory-based scoping.
  }

  return resolveHomeTempScopeId();
}

function resolveHomeTempScopeId(): string {
  const homedir = process.env.HOME;
  if (homedir !== undefined && homedir.length > 0) {
    return `home-${sanitizeTempScopeSegment(homedir)}`;
  }

  try {
    const fallbackHomedir = os.homedir();
    if (fallbackHomedir.length > 0) {
      return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
    }
  } catch {
    // Fall through to the last-resort shared scope.
  }

  return "shared";
}

export function resolveTempRootDir(configured = process.env.PI_SUBAGENT_TEMP_ROOT): string {
  const fallback = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
  if (configured === undefined || configured.trim().length === 0) {
    return fallback;
  }
  const resolved = path.resolve(configured);
  if (!path.basename(resolved).startsWith("pi-subagents-")) {
    throw new Error("PI_SUBAGENT_TEMP_ROOT must name a dedicated 'pi-subagents-*' directory.");
  }
  return resolved;
}
