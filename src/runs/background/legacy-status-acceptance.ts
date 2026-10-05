import { isRecord, isUnknownArray } from "../../shared/unknown.ts";
import { DEFAULT_FINALIZATION_MAX_TURNS } from "../shared/acceptance-contract.ts";

function normalizeLegacyStep(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.acceptance)) {
    return value;
  }
  const acceptance = value.acceptance;
  const effective = acceptance.effectiveAcceptance;
  if (
    !isRecord(effective) ||
    effective.explicit !== true ||
    Object.hasOwn(effective, "finalization")
  ) {
    return value;
  }
  return {
    ...value,
    acceptance: {
      ...acceptance,
      effectiveAcceptance: {
        ...effective,
        finalization: {
          mode: "self-review-loop",
          maxTurns: DEFAULT_FINALIZATION_MAX_TURNS,
        },
      },
    },
  };
}

/** Restore the pre-v2 finalization default without repairing any other contract fields. */
export function normalizeLegacyStatusAcceptance(value: unknown): unknown {
  if (!isRecord(value) || value.runtimeVersion !== undefined || !isUnknownArray(value.steps)) {
    return value;
  }
  return { ...value, steps: value.steps.map(normalizeLegacyStep) };
}
