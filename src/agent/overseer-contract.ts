import * as path from "node:path";
import {
  contractStateSchema,
  type ContractAmendment,
  type ContractField,
  type ContractState,
  type DelegationContract,
  type Launch,
} from "./contracts.ts";
import { normalizeDelegationContract, validateDelegationScope } from "./overseer-scope.ts";
import {
  ensureScratchDirectory,
  latest,
  read,
  runDirectory,
  write,
  type SuccessorOptions,
} from "./storage.ts";
import type { RunsInput } from "./tool-schemas.ts";

export interface ContractAmendmentInput {
  readonly scope?: readonly string[] | undefined;
  readonly verification?: readonly string[] | undefined;
  readonly baseBranch?: string | undefined;
  readonly requiredPrimitives?: readonly string[] | undefined;
  readonly nonGoals?: readonly string[] | undefined;
}

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

export function formatInspectionContractLines(
  contract: DelegationContract | undefined,
  amendments: readonly ContractAmendment[] | undefined,
  formatTime: (at: number) => string,
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
  const lines = [`Contract: ${fields.join(" | ")}`];
  if (amendments !== undefined && amendments.length > 0) {
    lines.push(
      `Contract amendments (${amendments.length}):`,
      ...amendments.map(
        (entry) => `  ${formatTime(entry.at)}: ${formatContractAmendmentSummary(entry)}`,
      ),
    );
  }
  return lines;
}
