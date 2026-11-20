import type { Static } from "typebox";
import type { ContractAmendment } from "../agent/contracts.ts";
import type { runContractSchema } from "./amendment-schema.ts";
import { isRecord } from "./unknown.ts";

type AmendmentFields = Static<typeof runContractSchema>;
export type ContractAmendmentInput = {
  readonly [Field in keyof AmendmentFields]: Readonly<AmendmentFields[Field]> | undefined;
};

export interface ChildContractTarget {
  readonly peerId: string;
  readonly rootSessionId?: string | undefined;
  readonly parentSessionId?: string | undefined;
}

export interface ChildContractAmendmentResult {
  readonly runId: string;
  readonly name?: string | undefined;
  readonly amendment: ContractAmendment;
  readonly summary: string;
}

/** A main intercom asks the agent runtime to amend an owned child's contract before replying. */
export const AMEND_CHILD_CONTRACT = "pi-subagents:amend-child-contract";

export interface AmendChildContractRequest {
  readonly target?: unknown;
  readonly contract?: unknown;
  readonly reply: (result: Promise<ChildContractAmendmentResult>) => void;
}

export function isTarget(value: unknown): value is ChildContractTarget {
  return (
    isRecord(value) &&
    typeof value.peerId === "string" &&
    (value.rootSessionId === undefined || typeof value.rootSessionId === "string") &&
    (value.parentSessionId === undefined || typeof value.parentSessionId === "string")
  );
}

export function isAmendChildContractRequest(value: unknown): value is AmendChildContractRequest {
  return isRecord(value) && typeof value.reply === "function";
}
