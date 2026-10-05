import type { ControlEvent, ResolvedControlConfig } from "../../shared/types.ts";

export function shouldNotifyControlEvent(
  config: ResolvedControlConfig,
  event: ControlEvent,
): boolean {
  return config.enabled && config.notifyOn.includes(event.type);
}

export function controlNotificationKey(event: ControlEvent, childIntercomTarget?: string): string {
  const childKey =
    childIntercomTarget ??
    (event.index !== undefined ? `${event.runId}:${event.index}` : event.runId);
  return `${childKey}:${event.type}:${event.reason ?? "idle"}`;
}
