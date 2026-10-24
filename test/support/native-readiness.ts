import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { nativePeerId } from "../../src/pi-intercom/session-targets.ts";
import type { SessionInfo } from "../../src/pi-intercom/types.ts";
import { assertDefined } from "./assertions.ts";

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Each native readiness observation must finish before retrying it.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    // Back off only after observing the preceding readiness check.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(5);
  }
}

/** Observe this native session's registration without driving its connection startup. */
export async function registeredSession(
  client: IntercomClient,
  sessionId: string,
  options: {
    readonly observer?: Omit<SessionInfo, "id">;
    readonly timeoutMs?: number;
  } = {},
): Promise<SessionInfo> {
  const id = nativePeerId(sessionId);
  let peer: SessionInfo | undefined;
  await waitFor(
    async () => {
      if (options.observer && !client.isConnected()) {
        try {
          await client.connect(options.observer);
        } catch {
          return false;
        }
      }
      peer = (await client.listSessions()).find((candidate) => candidate.id === id);
      return peer !== undefined;
    },
    `broker registration for native session ${sessionId}`,
    options.timeoutMs,
  );
  assertDefined(peer);
  return peer;
}
