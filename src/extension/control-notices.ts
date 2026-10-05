import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  controlNotificationKey,
  formatControlNoticeMessage,
  isObsoleteIdleNotice,
} from "../runs/shared/subagent-control.ts";
import type { ControlEvent } from "../shared/types.ts";

export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

export interface SubagentControlMessageDetails {
  readonly event: ControlEvent;
  readonly source?: "foreground" | "async";
  readonly asyncDir?: string;
  readonly childIntercomTarget?: string;
  readonly noticeText?: string;
}

export function controlNoticeTarget(details: SubagentControlMessageDetails): string | undefined {
  return details.childIntercomTarget;
}

export function formatSubagentControlNotice(
  details: SubagentControlMessageDetails,
  content?: string,
): string {
  return (
    details.noticeText ??
    content ??
    formatControlNoticeMessage(details.event, controlNoticeTarget(details))
  );
}

/** The runtime supplies its mutable dedup owner; delivery adds exactly one visible-notice key. */
interface ControlNoticeDeliveryInput {
  readonly pi: Pick<ExtensionAPI, "sendMessage">;
  readonly visibleControlNotices: Set<string>;
  readonly details: SubagentControlMessageDetails;
}

export function handleSubagentControlNotice(input: ControlNoticeDeliveryInput): void {
  if (isObsoleteIdleNotice(input.details)) {
    return;
  }
  const childIntercomTarget = controlNoticeTarget(input.details);
  const key = controlNotificationKey(input.details.event, childIntercomTarget);
  if (input.visibleControlNotices.has(key)) {
    return;
  }
  input.visibleControlNotices.add(key);
  const noticeText =
    input.details.noticeText ??
    formatControlNoticeMessage(input.details.event, childIntercomTarget);
  input.pi.sendMessage(
    {
      customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
      content: noticeText,
      display: true,
      details: { ...input.details, childIntercomTarget, noticeText },
    },
    // Async completion-guard notices stay visible but let the matching completion
    // result deliver the single automatic wakeup. In a parallel group that result
    // arrives only after all siblings finish, so reaction to a mid-group guard
    // notice is bounded by the longest-running sibling.
    {
      triggerTurn: !(
        input.details.source === "async" && input.details.event.reason === "completion_guard"
      ),
    },
  );
}
