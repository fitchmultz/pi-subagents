import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { controlNotificationKey, formatControlNoticeMessage, isObsoleteIdleNotice } from "../runs/shared/subagent-control.ts";
import type { ControlEvent } from "../shared/types.ts";

export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

export interface SubagentControlMessageDetails {
	event: ControlEvent;
	source?: "foreground" | "async";
	asyncDir?: string;
	childIntercomTarget?: string;
	noticeText?: string;
}

export function controlNoticeTarget(details: SubagentControlMessageDetails): string | undefined {
	return details.childIntercomTarget;
}

export function formatSubagentControlNotice(details: SubagentControlMessageDetails, content?: string): string {
	return details.noticeText ?? content ?? formatControlNoticeMessage(details.event, controlNoticeTarget(details));
}

export function handleSubagentControlNotice(input: {
	pi: Pick<ExtensionAPI, "sendMessage">;
	visibleControlNotices: Set<string>;
	details: SubagentControlMessageDetails;
}): void {
	if (!input.details?.event || isObsoleteIdleNotice(input.details)) return;
	const childIntercomTarget = controlNoticeTarget(input.details);
	const key = controlNotificationKey(input.details.event, childIntercomTarget);
	if (input.visibleControlNotices.has(key)) return;
	input.visibleControlNotices.add(key);
	const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event, childIntercomTarget);
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
		{ triggerTurn: !(input.details.source === "async" && input.details.event.reason === "completion_guard") },
	);
}
