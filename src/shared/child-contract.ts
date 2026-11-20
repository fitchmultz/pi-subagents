import type { ContractAmendment } from "../agent/contracts.ts";
import { isRecord } from "./unknown.ts";

export interface ContractAmendmentInput {
  readonly scope?: readonly string[] | undefined;
  readonly verification?: readonly string[] | undefined;
  readonly baseBranch?: string | undefined;
  readonly requiredPrimitives?: readonly string[] | undefined;
  readonly nonGoals?: readonly string[] | undefined;
}

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
  readonly target: ChildContractTarget;
  readonly contract: ContractAmendmentInput;
  readonly reply: (result: Promise<ChildContractAmendmentResult>) => void;
}

function isTarget(value: unknown): value is ChildContractTarget {
  return (
    isRecord(value) &&
    typeof value.peerId === "string" &&
    (value.rootSessionId === undefined || typeof value.rootSessionId === "string") &&
    (value.parentSessionId === undefined || typeof value.parentSessionId === "string")
  );
}

export function isAmendChildContractRequest(value: unknown): value is AmendChildContractRequest {
  return (
    isRecord(value) &&
    isTarget(value.target) &&
    isRecord(value.contract) &&
    typeof value.reply === "function"
  );
}
