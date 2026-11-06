// Decode the RPC evidence used by the standalone live smoke without requiring local Pi peers.
import assert from "node:assert/strict";
import { isRecord, isUnknownArray } from "../src/shared/unknown.ts";

/** @typedef {Record<string, unknown>} RpcEvent */
/**
 * The fields consumed from a native launch/continuation receipt, plus stream position.
 * @typedef {{ [K in "id" | "name" | "sessionFile" | "context" | "predecessor"]: import("../src/agent/contracts.ts").Launch[K] | undefined } & { receipt: string, tool: string, index: number }} SessionReceipt
 */
/** @typedef {ReturnType<typeof completionNotice>} SessionNotice */
/**
 * @typedef {object} SessionView
 * @property {RpcEvent[]} events
 * @property {SessionReceipt[]} receipts
 * @property {Map<string | undefined, SessionNotice>} notices
 * @property {{ index: number, text: string, stopReason: string | undefined }[]} replies
 */

/**
 * @param {Record<string, unknown>} details
 * @param {unknown} tool
 * @param {number} index
 * @returns {SessionReceipt}
 */
function sessionReceipt(details, tool, index) {
  const { id, name, sessionFile, context, predecessor, receipt } = details;
  assert.ok(id === undefined || typeof id === "string");
  assert.ok(name === undefined || typeof name === "string");
  assert.ok(sessionFile === undefined || typeof sessionFile === "string");
  assert.ok(context === undefined || context === "fresh" || context === "fork");
  assert.ok(predecessor === undefined || typeof predecessor === "string");
  assert.ok(typeof receipt === "string" && typeof tool === "string");
  return { id, name, sessionFile, context, predecessor, receipt, tool, index };
}

function completionNotice(/** @type {unknown} */ details, /** @type {number} */ index) {
  assert.ok(isRecord(details));
  const { id, result, page } = details;
  assert.ok(id === undefined || typeof id === "string");
  assert.ok(result === undefined || isRecord(result));
  assert.ok(page === undefined || isRecord(page));
  const status = result?.status;
  const text = page?.text;
  assert.ok(status === undefined || typeof status === "string");
  assert.ok(text === undefined || typeof text === "string");
  return { id, index, result: { status }, page: { text } };
}

function addMessage(
  /** @type {SessionView} */ view,
  /** @type {unknown} */ message,
  /** @type {number} */ index,
) {
  if (!isRecord(message)) {
    return;
  }
  if (message.customType === "agent-completion" && message.details !== undefined) {
    const notice = completionNotice(message.details, index);
    view.notices.set(notice.id, notice);
  } else if (message.role === "assistant") {
    const content = message.content ?? [];
    assert.ok(isUnknownArray(content));
    const text = content
      .filter(isRecord)
      .filter((part) => part.type === "text")
      .map((part) => {
        assert.ok(part.text === undefined || typeof part.text === "string");
        return part.text;
      });
    assert.ok(message.stopReason === undefined || typeof message.stopReason === "string");
    view.replies.push({ index, text: text.join("\n"), stopReason: message.stopReason });
  }
}

/** @param {RpcEvent[]} events @returns {SessionView} */
export function sessionView(events) {
  /** @type {SessionView} */
  const view = { events, receipts: [], notices: new Map(), replies: [] };
  for (const [index, event] of events.entries()) {
    const details = isRecord(event.result) ? event.result.details : undefined;
    if (event.type === "message_end") {
      addMessage(view, event.message, index);
    } else if (
      event.type === "tool_execution_end" &&
      isRecord(details) &&
      (details.receipt === "launch" || details.receipt === "continuation")
    ) {
      view.receipts.push(sessionReceipt(details, event.toolName, index));
    }
  }
  return view;
}
