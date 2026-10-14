import { resolveSessionTarget, formatSessionTarget, nativePeerId } from "./session-targets.ts";
import { Fault } from "./bridge-protocol.ts";
import type { SessionInfo } from "./types.ts";

export function bridgeSessionList(
  peers: readonly SessionInfo[],
): readonly (SessionInfo & { readonly target: string })[] {
  return peers.map(({ topics: _topics, subscriptions: _subscriptions, ...entry }) => ({
    ...entry,
    target: formatSessionTarget(entry, peers),
  }));
}

export function resolveBridgeTarget(
  peers: readonly SessionInfo[],
  to: string,
  self: string | null,
): SessionInfo {
  const exactNative = peers.find((peer) => peer.id === nativePeerId(to));
  const resolution = resolveSessionTarget(peers, exactNative?.id ?? to);
  if (resolution.status === "none") {
    throw new Fault(404, "peer_offline", "Peer is not connected.");
  }
  if (resolution.status !== "found" || !resolution.target) {
    throw new Fault(
      409,
      "ambiguous_target",
      "Use an unambiguous peer name or session ID (prefixes need at least 8 characters).",
    );
  }
  if (resolution.target.id === self) {
    throw new Fault(400, "self_target", "Choose another peer.");
  }
  return resolution.target;
}
