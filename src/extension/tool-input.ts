import { Compile } from "../shared/native-typebox.ts";
import { isRecord } from "../shared/unknown.ts";
import { AgentRunsValidationParams } from "./schemas.ts";

const runArguments = Compile(AgentRunsValidationParams);

function normalizeVerificationEnvironment(verify: unknown): unknown {
  if (!isRecord(verify) || !Array.isArray(verify.env)) {
    return verify;
  }
  const entries = verify.env.map((entry: unknown): [string, string] => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
      throw new Error("Verification environment entries require string names and values.");
    }
    return [entry.name, entry.value];
  });
  if (new Set(entries.map(([name]) => name)).size !== entries.length) {
    throw new Error("Verification environment contains duplicate names.");
  }
  return { ...verify, env: Object.fromEntries(entries) };
}

export function normalizeEverydayParams(
  params: Readonly<Record<string, unknown>>,
  control = false,
): Readonly<Record<string, unknown>> {
  const acceptance = params.acceptance;
  const normalized =
    isRecord(acceptance) && Array.isArray(acceptance.verify)
      ? {
          ...params,
          acceptance: {
            ...acceptance,
            verify: acceptance.verify.map((verify: unknown) =>
              normalizeVerificationEnvironment(verify),
            ),
          },
        }
      : params;
  if (control && !runArguments.Check(normalized)) {
    throw new Error(
      `Invalid agent_runs arguments: ${[...runArguments.Errors(normalized)].map((error) => error.message).join("; ")}`,
    );
  }
  return normalized;
}
