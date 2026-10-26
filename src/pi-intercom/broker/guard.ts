import type { Message, SessionInfo } from "../types.ts";

/** Guarded commands use an exact main, never convenience names or a replacement context. */
export function guardedDeliveryError(
  sessions: ReadonlyMap<string, { readonly info: SessionInfo }>,
  to: string,
  message: Message,
): string | null {
  const guard = message.guard;
  if (!guard) {
    return null;
  }
  const registered = sessions.get(to);
  if (!registered || to !== guard.peerId) {
    return "Guarded target not found";
  }
  const target = registered.info;
  if (target.guardedDelivery !== 1) {
    return "Recipient does not support guarded delivery";
  }
  if (
    target.parentSessionId !== undefined ||
    target.rootSessionId !== guard.rootSessionId ||
    target.incarnation !== guard.incarnation ||
    target.applicationGuard !== guard.applicationGuard
  ) {
    return "Guarded target changed";
  }
  const mains = [...sessions.values()].filter(
    ({ info }) => info.rootSessionId === guard.rootSessionId && info.parentSessionId === undefined,
  );
  return mains.length === 1 ? null : "Guarded root is ambiguous";
}
