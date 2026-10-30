import type { NativeHistory } from "../pi-intercom/last-message.ts";
import type { WakeResult } from "../pi-intercom/types.ts";
import { isRecord } from "./unknown.ts";

export type { WakeResult } from "../pi-intercom/types.ts";

/** A child actor asks its intercom to fence broker input before parking, or to release it. */
export const PARK = "pi-subagents:park";
export interface ParkRequest {
  readonly park: boolean;
  readonly reply: (parked: Promise<boolean>) => void;
}
/** A main intercom wakes or reads an exited parked child through the agent runtime. */
export const WAKE = "pi-subagents:wake";
export const PARKED_HISTORY = "pi-subagents:parked-history";
export interface WakeRequest {
  readonly peer: string;
  readonly signal?: AbortSignal;
  readonly reply: (result: Promise<WakeResult>) => void;
}
export interface HistoryRequest {
  readonly peer: string;
  readonly reply: (history: Promise<NativeHistory | undefined>) => void;
}
export function isParkRequest(value: unknown): value is ParkRequest {
  return isRecord(value) && typeof value.park === "boolean" && typeof value.reply === "function";
}
export function isWakeRequest(value: unknown): value is WakeRequest {
  return (
    isRecord(value) &&
    typeof value.peer === "string" &&
    typeof value.reply === "function" &&
    (value.signal === undefined || value.signal instanceof AbortSignal)
  );
}
export function isHistoryRequest(value: unknown): value is HistoryRequest {
  return isRecord(value) && typeof value.peer === "string" && typeof value.reply === "function";
}
