import type { ControlEvent, ResolvedControlConfig } from "../../shared/types.ts";
import { controlNotificationKey, shouldNotifyControlEvent } from "./control-event-policy.ts";

/** Explicit mutation contract: the caller owns seenKeys; a successful claim adds one key. */
export function claimControlNotification(
  config: ResolvedControlConfig,
  event: ControlEvent,
  seenKeys: Set<string>,
  childIntercomTarget?: string,
): boolean {
  if (!shouldNotifyControlEvent(config, event)) {
    return false;
  }
  const key = controlNotificationKey(event, childIntercomTarget);
  if (seenKeys.has(key)) {
    return false;
  }
  seenKeys.add(key);
  return true;
}
