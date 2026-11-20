import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  contractStateSchema,
  type ContractAmendment,
  type ContractField,
  type ContractState,
  type DelegationContract,
  type Launch,
} from "./contracts.ts";
import { isChild } from "./host.ts";
import { notifyInventory } from "./inventory-events.ts";
import { normalizeDelegationContract, validateDelegationScope } from "./overseer-scope.ts";
import { readRunState } from "./run-state.ts";
import {
  ensureScratchDirectory,
  latest,
  launchAt,
  list,
  read,
  runDirectory,
  write,
  type SuccessorOptions,
} from "./storage.ts";
import type { RunsInput } from "./tool-schemas.ts";
import { nativePeerId } from "../pi-intercom/session-targets.ts";
import {
  AMEND_CHILD_CONTRACT,
  isAmendChildContractRequest,
  isTarget,
  type ChildContractAmendmentResult,
  type ChildContractTarget,
  type ContractAmendmentInput,
} from "../shared/child-contract.ts";

import { compile } from "@earendil-works/pi-schema";
import { runContractSchema } from "../shared/amendment-schema.ts";

export type { ContractAmendmentInput } from "../shared/child-contract.ts";

export interface PreparedContractAmendment {
  readonly contract: DelegationContract;
  readonly changedFields: ContractField[];
  readonly previous: DelegationContract | undefined;
}

function contractFile(base: string, runId: string): string {
  return path.join(runDirectory(base, runId), "contract.json");
}

function readContractState(base: string, runId: string): ContractState | undefined {
  return read(contractFile(base, runId), contractStateSchema);
}

/** Active contract for a run: latest persisted amendment, falling back to launch.json. */
export function activeContract(
  base: string,
  launch: Pick<Launch, "id" | "contract">,
): DelegationContract | undefined {
  return readContractState(base, launch.id)?.current ?? launch.contract;
}

/** Recorded contract amendments for this run, oldest first. */
export function readContractAmendments(
  base: string,
  launch: Pick<Launch, "id">,
): ContractAmendment[] {
  return readContractState(base, launch.id)?.history ?? [];
}

function providedContractFields(patch: ContractAmendmentInput): ContractField[] {
  const fields: ContractField[] = [];
  if (patch.scope !== undefined) {
    fields.push("scope");
  }
  if (patch.verification !== undefined) {
    fields.push("verification");
  }
  if (patch.baseBranch !== undefined) {
    fields.push("baseBranch");
  }
  if (patch.requiredPrimitives !== undefined) {
    fields.push("requiredPrimitives");
  }
  if (patch.nonGoals !== undefined) {
    fields.push("nonGoals");
  }
  return fields;
}

function optionalList(
  patch: readonly string[] | undefined,
  existing: readonly string[] | undefined,
): string[] | undefined {
  const chosen = patch ?? existing;
  return chosen === undefined ? undefined : [...chosen];
}

function mergeContractDraft(
  existing: DelegationContract | undefined,
  patch: ContractAmendmentInput,
  rawScope: readonly string[],
): DelegationContract {
  const verification = optionalList(patch.verification, existing?.verification);
  const baseBranch = patch.baseBranch ?? existing?.baseBranch;
  const requiredPrimitives = optionalList(patch.requiredPrimitives, existing?.requiredPrimitives);
  const nonGoals = optionalList(patch.nonGoals, existing?.nonGoals);
  return normalizeDelegationContract({
    scope: [...rawScope],
    ...(verification !== undefined ? { verification } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(requiredPrimitives !== undefined ? { requiredPrimitives } : {}),
    ...(nonGoals !== undefined ? { nonGoals } : {}),
  });
}

/** Merges, normalizes, and validates a partial or full contract amendment against `cwd`. */
export function prepareContractAmendment(
  existing: DelegationContract | undefined,
  patch: ContractAmendmentInput,
  cwd: string,
): PreparedContractAmendment {
  const changedFields = providedContractFields(patch);
  if (changedFields.length === 0) {
    throw new Error(
      "Contract amendment must specify at least one field (scope, verification, baseBranch, requiredPrimitives, or nonGoals).",
    );
  }
  const rawScope = patch.scope ?? existing?.scope;
  if (rawScope === undefined) {
    throw new Error(
      "Adding a delegation contract requires scope (use scope: [] to disable repo edit tools).",
    );
  }
  const contract = mergeContractDraft(existing, patch, rawScope);
  validateDelegationScope(cwd, contract.scope);
  return { contract, changedFields, previous: existing };
}

/** Atomically persists a contract amendment in the run directory and appends it to history. */
export function recordContractAmendment(
  base: string,
  runId: string,
  amendment: PreparedContractAmendment,
): ContractAmendment {
  const prior = readContractState(base, runId);
  const entry: ContractAmendment = {
    at: Date.now(),
    contract: amendment.contract,
    changedFields: amendment.changedFields,
    ...(amendment.previous !== undefined ? { previous: amendment.previous } : {}),
  };
  const next: ContractState = {
    current: amendment.contract,
    history: [...(prior?.history ?? []), entry],
  };
  write(contractFile(base, runId), next);
  return entry;
}

export function assertUnadmittedContract(runId: string, contract: unknown): void {
  if (contract !== undefined) {
    throw new Error(
      `Run ${runId} is awaiting native admission; wait for admission or inspect it before amending its contract.`,
    );
  }
}

export function assertContractActionAllowed(input: RunsInput): void {
  if (input.contract === undefined) {
    return;
  }
  if (input.action === "continue") {
    return;
  }
  if (input.action === "review" && input.verdict === "changes_requested") {
    return;
  }
  throw new Error(
    'contract is only supported with action="continue" or action="review" (verdict="changes_requested").',
  );
}

export function validateReviewContract(base: string, original: Launch, input: RunsInput): void {
  if (input.contract === undefined) {
    return;
  }
  const tip = latest(base, original);
  prepareContractAmendment(activeContract(base, tip), input.contract, tip.cwd);
}

export function prepareContinuationContract(
  base: string,
  launch: Launch,
  patch: ContractAmendmentInput | undefined,
): {
  readonly existing: DelegationContract | undefined;
  readonly amendment: PreparedContractAmendment | undefined;
} {
  const existing = activeContract(base, launch);
  const amendment =
    patch === undefined ? undefined : prepareContractAmendment(existing, patch, launch.cwd);
  return { existing, amendment };
}

export function applyLiveContractAmendment(
  base: string,
  launch: Launch,
  prompt: string,
  amendment: PreparedContractAmendment | undefined,
): string {
  if (amendment !== undefined) {
    ensureScratchDirectory(base, launch);
    recordContractAmendment(base, launch.id, amendment);
  }
  return formatAmendedSteerPrompt(prompt, amendment);
}

/** Validates ownership and atomically persists a contract amendment for an owned child peer. */
export function amendOwnedChildContract(
  base: string,
  owner: string,
  target: ChildContractTarget,
  patch: ContractAmendmentInput,
): ChildContractAmendmentResult {
  if (target.parentSessionId !== owner || target.rootSessionId !== owner) {
    throw new Error(
      "Contract amendment on intercom reply requires the ask sender to be an owned child run of this session.",
    );
  }
  const matched = list(base)
    .map((id) => launchAt(base, id, owner))
    .find((candidate) => nativePeerId(candidate.sessionId) === target.peerId);
  if (matched === undefined) {
    throw new Error(`Peer "${target.peerId}" does not match an owned child run of this session.`);
  }
  const launch = latest(base, matched);
  const state = readRunState(base, launch);
  if (state.kind === "saved-unadmitted") {
    assertUnadmittedContract(launch.id, patch);
  }
  const amendment = prepareContractAmendment(activeContract(base, launch), patch, launch.cwd);
  ensureScratchDirectory(base, launch);
  const entry = recordContractAmendment(base, launch.id, amendment);
  notifyInventory(base, launch.id);
  return {
    runId: launch.id,
    ...(launch.name !== undefined ? { name: launch.name } : {}),
    amendment: entry,
    summary: formatContractAmendmentSummary(entry),
  };
}

const amendmentValidator = compile(runContractSchema);

/** Handles intercom-initiated contract amendments for this owner's child runs. */
export function serveChildContractAmendments(
  pi: ExtensionAPI,
  resolveOwner: () => Promise<{ readonly base: string; readonly owner: string }>,
): void {
  pi.events.on(AMEND_CHILD_CONTRACT, (request) => {
    if (!isAmendChildContractRequest(request)) {
      return;
    }
    request.reply(
      Promise.resolve().then(async () => {
        if (isChild()) {
          throw new Error("Only the owning main session may amend a child's delegation contract.");
        }
        if (!isTarget(request.target)) {
          throw new Error("Invalid child contract target.");
        }
        const contract = amendmentValidator.validate(request.contract);
        if (!contract.ok) {
          throw new Error(
            `Invalid contract amendment: ${contract.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`,
          );
        }
        const { base, owner } = await resolveOwner();
        return amendOwnedChildContract(base, owner, request.target, contract.value);
      }),
    );
  });
}

/** Builds successor launch options carrying the active or newly amended contract and scratch dir. */
export function successorContractOptions(
  base: string,
  launch: Launch,
  existing: DelegationContract | undefined,
  amendment?: PreparedContractAmendment,
): SuccessorOptions {
  const contract = amendment?.contract ?? existing;
  const scratchDir =
    contract === undefined ? launch.scratchDir : ensureScratchDirectory(base, launch);
  const contractState: ContractState | undefined =
    amendment === undefined
      ? undefined
      : {
          current: amendment.contract,
          history: [
            {
              at: Date.now(),
              contract: amendment.contract,
              changedFields: amendment.changedFields,
              ...(amendment.previous !== undefined ? { previous: amendment.previous } : {}),
            },
          ],
        };
  return {
    ...(contract !== undefined ? { contract } : {}),
    ...(scratchDir !== undefined ? { scratchDir } : {}),
    ...(contractState !== undefined ? { contractState } : {}),
  };
}

function formatAmendedField(contract: DelegationContract, field: ContractField): string {
  switch (field) {
    case "scope":
      return `scope: ${contract.scope.length === 0 ? "[] (read-only)" : contract.scope.join(", ")}`;
    case "verification":
      return `verification: ${contract.verification?.join("; ") ?? "(cleared)"}`;
    case "baseBranch":
      return `baseBranch: ${contract.baseBranch ?? "(cleared)"}`;
    case "requiredPrimitives":
      return `requiredPrimitives: ${contract.requiredPrimitives?.join("; ") ?? "(cleared)"}`;
    case "nonGoals":
      return `nonGoals: ${contract.nonGoals?.join("; ") ?? "(cleared)"}`;
  }
}

export function formatContractAmendmentSummary(
  amendment: Pick<ContractAmendment, "contract" | "changedFields">,
): string {
  return amendment.changedFields
    .map((field) => formatAmendedField(amendment.contract, field))
    .join("; ");
}

export function formatAmendedSteerPrompt(
  prompt: string,
  amendment: Pick<ContractAmendment, "contract" | "changedFields"> | undefined,
): string {
  if (amendment === undefined) {
    return prompt;
  }
  return `[Delegation contract updated: ${formatContractAmendmentSummary(amendment)}]\n\n${prompt}`;
}

function formatAmendmentHistoryLines(
  amendments: readonly ContractAmendment[] | undefined,
  formatTime: (at: number) => string,
  totalAmendments: number,
): string[] {
  if (amendments === undefined || amendments.length === 0) {
    return [];
  }
  const countLabel =
    totalAmendments > amendments.length
      ? `latest ${amendments.length} of ${totalAmendments}`
      : String(amendments.length);
  return [
    `Contract amendments (${countLabel}):`,
    ...amendments.map(
      (entry) => `  ${formatTime(entry.at)}: ${formatContractAmendmentSummary(entry)}`,
    ),
  ];
}

export function formatInspectionContractLines(
  contract: DelegationContract | undefined,
  amendments: readonly ContractAmendment[] | undefined,
  formatTime: (at: number) => string,
  totalAmendments = amendments?.length ?? 0,
): string[] {
  if (contract === undefined) {
    return [];
  }
  const fields: string[] = [
    `scope=${contract.scope.length === 0 ? "[]" : contract.scope.join(", ")}`,
    ...(contract.verification !== undefined
      ? [`verification=${contract.verification.join("; ")}`]
      : []),
    ...(contract.baseBranch !== undefined ? [`baseBranch=${contract.baseBranch}`] : []),
    ...(contract.requiredPrimitives !== undefined
      ? [`requiredPrimitives=${contract.requiredPrimitives.join("; ")}`]
      : []),
    ...(contract.nonGoals !== undefined ? [`nonGoals=${contract.nonGoals.join("; ")}`] : []),
  ];
  return [
    `Contract: ${fields.join(" | ")}`,
    ...formatAmendmentHistoryLines(amendments, formatTime, totalAmendments),
  ];
}
