import { formatTargetOptions, resolveSessionTarget } from "./session-targets.ts";
import { RecoveryError } from "./tool-results.ts";
import type { IntercomTransport } from "./transport.ts";
import type { SessionInfo } from "./types.ts";

/** `at` is the `@device` ending that another device uses for this one's targets. */
export async function resolveConnectedTarget(
  active: IntercomTransport,
  name: string,
  at = "",
): Promise<string | null> {
  const sessions = await active.listSessions();
  const resolution = resolveSessionTarget(sessions, name);
  if (resolution.status === "found" && resolution.target) {
    return resolution.target.id;
  }
  if (resolution.status === "ambiguous") {
    throw new RecoveryError(
      "ambiguous_target",
      `Target "${name}${at}" matches multiple sessions. Use one of these targets: ${formatTargetOptions(resolution.matches, sessions, at)}.`,
    );
  }
  if (resolution.status === "prefix_too_short") {
    throw new RecoveryError(
      "ambiguous_target",
      `Target "${name}${at}" is too short. Use the displayed target from intercom list, such as ${formatTargetOptions(resolution.matches, sessions, at)}.`,
    );
  }
  return null;
}
export async function resolvePeerHealth(
  active: IntercomTransport,
  id: string,
): Promise<SessionInfo | null> {
  try {
    return (await active.listSessions()).find((session) => session.id === id) ?? null;
  } catch {
    return null; /* Unknown health must not skip an ordinary blocking reply. */
  }
}
