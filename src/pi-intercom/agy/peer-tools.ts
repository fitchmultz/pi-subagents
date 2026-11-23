import { randomUUID } from "node:crypto";
import { resolveConnectedTarget } from "../connected-target.ts";
import type { IntercomConfig } from "../config.ts";
import type { DeviceTarget, RemoteDevices } from "../devices.ts";
import { formatAttachments, normalizeLine, pendingAskPreview } from "../message-format.ts";
import {
  askFailure,
  deliveryFailure,
  replyDeliveryFailure,
  replyFailure,
  replySent,
  sendFailure,
  sendHint,
} from "../outbound-results.ts";
import type { ReplyTracker } from "../reply-tracker.ts";
import type { ReplyWait } from "../reply-wait.ts";
import {
  RECIPIENT_TURN_FAILED_ATTACHMENT,
  type IntercomToolParams,
  type ToolResultLike,
} from "../runtime-types.ts";
import { formatSessionTarget } from "../session-targets.ts";
import { sendOptions, toolError, toolText, validateIntercomArguments } from "../tool-arguments.ts";
import { failureDetails, type SendProgress } from "../tool-results.ts";
import type { IntercomTransport } from "../transport.ts";
import type { LastMessageResult, Message, SendResult } from "../types.ts";
import {
  formatDeviceListings,
  formatSessionListSections,
  sessionsForScope,
} from "../ui/session-format.ts";
import { errorMessage, MAX_WORKING_ON_LENGTH } from "../validation.ts";

export interface AgyToolPeer {
  readonly ensureConnected: () => Promise<IntercomTransport>;
  readonly replies: ReplyTracker;
  readonly wait: ReplyWait;
  readonly devices: RemoteDevices;
  readonly config: IntercomConfig;
  readonly wakeReady: () => boolean;
  readonly queuedInboundCount: () => number;
  readonly setWorkingOn: (value: string | undefined) => void;
  readonly markActivity: () => void;
  readonly syncPresence: () => void;
}

function formatLastPage(
  result: Exclude<LastMessageResult, { readonly error: string }>,
): ToolResultLike {
  const identity = `${result.session.name ?? result.session.id} (${result.session.id})`;
  const page =
    result.entryId === null
      ? "No completed assistant response."
      : `Entry: ${result.entryId}\nCharacters (UTF-16): ${result.offset}–${result.offset + result.text.length} of ${result.totalLength}`;
  const failure =
    result.latestTurnError === undefined
      ? ""
      : `\nLatest turn failed (${result.latestTurnError.entryId}): ${result.latestTurnError.error}`;
  const next =
    result.nextOffset === undefined
      ? ""
      : `\nNext page: intercom(${JSON.stringify({ action: "last", to: result.session.id, entryId: result.entryId, offset: result.nextOffset })})`;
  return {
    content: [
      { type: "text", text: result.text },
      {
        type: "text",
        text: `Session: ${identity}\nStatus: ${result.session.status ?? "unknown"}${failure}\n${page}${next}`,
      },
    ],
    details: { ...result },
  };
}

function formatAskReply(to: string, reply: Message, questionId: string): ToolResultLike {
  const text = reply.content.text;
  if (
    reply.content.attachments?.some(
      (attachment) => attachment.name === RECIPIENT_TURN_FAILED_ATTACHMENT,
    ) === true
  ) {
    return toolError(
      text,
      failureDetails(
        "recipient_turn_failed",
        [
          { action: "status" },
          { action: "send", guidance: "Send recovery context after the recipient is healthy." },
        ],
        { error: true, recipientTurnFailed: true, messageId: reply.id, replyTo: questionId },
      ),
    );
  }
  const attachments = reply.content.attachments;
  const attachmentText =
    attachments !== undefined && attachments.length > 0 ? formatAttachments(attachments) : "";
  return toolText(`**Reply from ${to}:**\n${text}${attachmentText}`);
}

function formatPendingAsks(replies: ReplyTracker): ToolResultLike {
  const asks = replies.listPending();
  if (asks.length === 0) {
    return toolText("No unresolved inbound asks.");
  }
  const now = Date.now();
  const senders = asks.map((ask) => ask.from);
  const lines = asks.map(({ from, message, receivedAt }) => {
    const sender =
      from.name !== undefined && from.name !== ""
        ? `${from.name} (${formatSessionTarget(from, senders)})`
        : from.id;
    const replyTo = JSON.stringify(message.id);
    const elapsed = Math.max(0, Math.floor((now - receivedAt) / 1000));
    return `- ${sender} · replyTo: ${replyTo} · ${elapsed}s ago · ${pendingAskPreview(message)}\n  Reply: intercom({ action: "reply", replyTo: ${replyTo}, message: "..." })`;
  });
  return toolText(`**Pending asks:**\n${lines.join("\n")}`);
}

async function executeList(
  peer: AgyToolPeer,
  active: IntercomTransport,
  params: IntercomToolParams,
  signal: AbortSignal | undefined,
): Promise<ToolResultLike> {
  if (params.device !== undefined) {
    const result = await peer.devices.list(params.device, signal);
    if ("refusal" in result) {
      return toolError(result.refusal);
    }
    return toolText(formatDeviceListings(result.listings, params.to), {
      sessionCount: result.listings.reduce(
        (count, listing) => count + ("sessions" in listing ? listing.sessions.length : 0),
        0,
      ),
    });
  }
  try {
    const id = active.sessionId;
    if (id === null || id === "") {
      throw new Error("Current intercom session id is unavailable.");
    }
    const all = await active.listSessions();
    const view = { scope: params.scope, query: params.to, children: params.children };
    return toolText(formatSessionListSections(all, id, view), {
      sessionCount: sessionsForScope(all, id, params.scope ?? "all").length,
    });
  } catch (error) {
    return toolError(`Failed to list sessions: ${errorMessage(error)}`);
  }
}

async function executeStatus(
  peer: AgyToolPeer,
  active: IntercomTransport,
  params: IntercomToolParams,
): Promise<ToolResultLike> {
  try {
    const id = active.sessionId;
    if (id === null || id === "") {
      throw new Error("Current intercom session id is unavailable.");
    }
    const scope = params.scope ?? "all";
    const all = await active.listSessions();
    const wakeNote = peer.wakeReady()
      ? "Idle wake: Ready (agentapi)"
      : "Idle wake: Pending first shell command (active-turn hook delivery active)";
    return toolText(
      [
        "**Intercom Status:**",
        "Connected: Yes",
        `Session ID: ${id}`,
        wakeNote,
        `Queued inbound messages: ${peer.queuedInboundCount()}`,
        `Connected sessions in scope: ${sessionsForScope(all, id, scope).length}`,
        "",
        formatSessionListSections(all, id, { scope }),
      ].join("\n"),
    );
  } catch (error) {
    return toolError(`Failed to get status: ${errorMessage(error)}`);
  }
}

async function executeLast(
  active: IntercomTransport,
  params: IntercomToolParams,
): Promise<ToolResultLike> {
  if (params.to === undefined || params.to === "") {
    return toolError("Missing 'to' parameter");
  }
  try {
    const target = (await resolveConnectedTarget(active, params.to)) ?? params.to;
    const result = await active.last(target, {
      entryId: params.entryId,
      offset: params.offset,
      limit: params.limit,
    });
    return "error" in result ? toolError(result.error) : formatLastPage(result);
  } catch (error) {
    return toolError(`Failed to read last response: ${errorMessage(error)}`);
  }
}

function executeClaim(peer: AgyToolPeer, params: IntercomToolParams): ToolResultLike {
  const normalized = normalizeLine(params.message);
  if (normalized !== undefined && normalized.length > MAX_WORKING_ON_LENGTH) {
    return toolError(`Shorten the claim to ${MAX_WORKING_ON_LENGTH} UTF-16 code units or fewer.`);
  }
  peer.setWorkingOn(normalized);
  if (normalized === undefined) {
    return toolText("Cleared workingOn claim.", { workingOn: null });
  }
  return toolText(`Updated workingOn claim: ${normalized}`, { workingOn: normalized });
}

async function resolveSendTarget(
  peer: AgyToolPeer,
  active: IntercomTransport,
  to: string,
  replyTo: string | undefined,
): Promise<string | DeviceTarget> {
  const asker = (replyTo ?? "") === "" ? null : await resolveConnectedTarget(active, to);
  return asker ?? peer.devices.address(to) ?? (await resolveConnectedTarget(active, to)) ?? to;
}

function formatSentResult(
  peer: AgyToolPeer,
  sent: {
    readonly to: string;
    readonly params: IntercomToolParams;
    readonly result: SendResult;
    readonly local: boolean;
  },
): ToolResultLike {
  const { to, params, result, local } = sent;
  peer.markActivity();
  if (local && (params.replyTo ?? "") !== "") {
    peer.replies.markReplied(params.replyTo ?? "");
  }
  peer.syncPresence();
  return toolText(
    result.queued === true
      ? `Message queued for ${to} (${result.reason ?? "queued"})`
      : `Message sent to ${to}${sendHint(params)}`,
    {
      messageId: result.id,
      accepted: result.accepted,
      delivered: result.delivered,
      queued: result.queued === true,
      reasonCode: result.queued === true ? "message_queued" : "message_accepted",
    },
  );
}

async function executeSend(
  peer: AgyToolPeer,
  active: IntercomTransport,
  params: IntercomToolParams,
  signal: AbortSignal | undefined,
): Promise<ToolResultLike> {
  if ((params.to ?? "") === "" || (params.message ?? "") === "") {
    return toolError("Missing 'to' or 'message' parameter");
  }
  const to = params.to ?? "";
  let progress: SendProgress = { kind: "not-sent" };
  try {
    const target = await resolveSendTarget(peer, active, to, params.replyTo);
    if (target === active.sessionId) {
      return toolError("Cannot message the current session");
    }
    const options = sendOptions(params);
    const local = typeof target === "string";
    progress = { kind: "unconfirmed" };
    const result = await (local
      ? active.send(target, options)
      : peer.devices.send(active, target, { options, signal }));
    progress = { kind: "acknowledged", result };
    if (!result.accepted) {
      return deliveryFailure(to, result);
    }
    return formatSentResult(peer, { to, params, result, local });
  } catch (error) {
    return sendFailure(error, progress);
  }
}

async function executeAskDevice(
  peer: AgyToolPeer,
  active: IntercomTransport,
  params: IntercomToolParams,
  signal: AbortSignal | undefined,
): Promise<ToolResultLike | undefined> {
  const to = params.to ?? "";
  const questionId = randomUUID();
  const options = sendOptions(params);
  let progress: SendProgress = { kind: "not-sent" };
  try {
    const device = peer.devices.address(to);
    if (device === undefined) {
      return;
    }
    const reply = await peer.devices.ask(active, device, {
      options: { ...options, messageId: questionId },
      signal,
      onSent: (result) => {
        progress = { kind: "acknowledged", result };
        peer.markActivity();
        peer.syncPresence();
      },
    });
    return formatAskReply(to, reply, questionId);
  } catch (error) {
    return askFailure(error, { to, questionId, progress });
  }
}

async function prepareLocalAskTarget(
  active: IntercomTransport,
  to: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly target: string } | { readonly error: ToolResultLike }> {
  const target = await resolveConnectedTarget(active, to);
  if (signal?.aborted === true) {
    return { error: toolError("Cancelled") };
  }
  if (target === null) {
    return {
      error: toolError(
        `Ask to "${to}" was not sent: connected session not found.`,
        failureDetails(
          "delivery_failed",
          [
            { action: "list" },
            { action: "send", guidance: "Retry with an exact active recipient target." },
          ],
          { accepted: false, delivered: false },
        ),
      ),
    };
  }
  if (target === active.sessionId) {
    return { error: toolError("Cannot message the current session") };
  }
  return { target };
}

async function executeAskLocal(
  peer: AgyToolPeer,
  active: IntercomTransport,
  params: IntercomToolParams,
  signal: AbortSignal | undefined,
): Promise<ToolResultLike> {
  const to = params.to ?? "";
  let questionId: string | undefined;
  let progress: SendProgress = { kind: "not-sent" };
  try {
    if (peer.wait.waiting) {
      throw new Error("Already waiting for a reply");
    }
    if (signal?.aborted === true) {
      throw new Error("Cancelled");
    }
    const prepared = await prepareLocalAskTarget(active, to, signal);
    if ("error" in prepared) {
      return prepared.error;
    }
    questionId = randomUUID();
    const reply = await peer.wait.transact(active, {
      to: prepared.target,
      questionId,
      options: sendOptions(params),
      signal,
      onSending: () => {
        progress = { kind: "unconfirmed" };
      },
      onSent: (result) => {
        progress = { kind: "acknowledged", result };
        peer.syncPresence();
      },
    });
    return formatAskReply(to, reply, questionId);
  } catch (error) {
    return askFailure(error, {
      to,
      ...(questionId === undefined ? {} : { questionId }),
      progress,
    });
  }
}

async function executeAsk(
  peer: AgyToolPeer,
  active: IntercomTransport,
  params: IntercomToolParams,
  signal: AbortSignal | undefined,
): Promise<ToolResultLike> {
  if ((params.to ?? "") === "" || (params.message ?? "") === "") {
    return toolError("Missing 'to' or 'message' parameter");
  }
  return (
    (await executeAskDevice(peer, active, params, signal)) ??
    (await executeAskLocal(peer, active, params, signal))
  );
}

async function executeReply(
  peer: AgyToolPeer,
  active: IntercomTransport,
  params: IntercomToolParams,
): Promise<ToolResultLike> {
  const body = params.message ?? "";
  if (body === "") {
    return toolError("Missing 'message' parameter");
  }
  let progress: SendProgress = { kind: "not-sent" };
  try {
    const target = peer.replies.resolveReplyTarget({ to: params.to, replyTo: params.replyTo });
    if (target.from.id === active.sessionId) {
      return toolError("Cannot message the current session");
    }
    progress = { kind: "unconfirmed" };
    const result = await active.send(target.from.id, {
      text: body,
      attachments: params.attachments,
      replyTo: target.message.id,
    });
    progress = { kind: "acknowledged", result };
    const sender = target.from.name ?? target.from.id;
    if (!result.accepted) {
      return replyDeliveryFailure(sender, target.message.id, result);
    }
    peer.replies.markReplied(target.message.id);
    peer.markActivity();
    peer.syncPresence();
    return replySent(sender, target.message.id, result);
  } catch (error) {
    return replyFailure(error, params.replyTo, progress);
  }
}

export async function executeAgyIntercomTool(
  peer: AgyToolPeer,
  params: IntercomToolParams,
  signal: AbortSignal | undefined,
): Promise<ToolResultLike> {
  const invalid = validateIntercomArguments(params);
  if (invalid) {
    return invalid;
  }
  if (params.contract !== undefined) {
    return toolError("Child contract amendments are not supported from agy sessions.");
  }
  let active: IntercomTransport;
  try {
    active = await peer.ensureConnected();
  } catch (error) {
    return toolError(`Intercom not connected: ${errorMessage(error)}`);
  }
  switch (params.action) {
    case "list":
      return await executeList(peer, active, params, signal);
    case "status":
      return await executeStatus(peer, active, params);
    case "pending":
      return formatPendingAsks(peer.replies);
    case "last":
      return await executeLast(active, params);
    case "send":
      return await executeSend(peer, active, params, signal);
    case "ask":
      return await executeAsk(peer, active, params, signal);
    case "reply":
      return await executeReply(peer, active, params);
    case "claim":
      return executeClaim(peer, params);
  }
}
