import {
  connectIntercom,
  type DeliveryGuard,
  type IntercomClient,
  type IntercomClientOptions,
  type ReceiptResult,
} from "@fitchmultz/pi-subagents/intercom-client";

export async function consume(
  options: IntercomClientOptions,
  guard: DeliveryGuard,
): Promise<ReceiptResult> {
  const client: IntercomClient = await connectIntercom(options);
  try {
    await client.listSessions();
    await client.last(guard.peerId, { entryId: "pinned", offset: 0, limit: 10 });
    const send = { text: "original", guard, expectsReply: false, delivery: "passive" } as const;
    // @ts-expect-error A caller must record an immutable original message ID before sending.
    await client.send(guard.peerId, send);
    await client.send(guard.peerId, { ...send, messageId: "original-id" });
    return await client.receipt(guard.peerId, {
      rootSessionId: guard.rootSessionId,
      messageId: "original-id",
    });
  } finally {
    await client.disconnect();
  }
}
