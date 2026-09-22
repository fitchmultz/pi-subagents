import { Compile } from "typebox/compile";
import { AgentRunsValidationParams } from "./schemas.ts";

const runArguments = Compile(AgentRunsValidationParams);

export function normalizeEverydayParams(params: Record<string, unknown>, control = false): Record<string, unknown> {
	const acceptance = params.acceptance as { verify?: Array<{ env?: Array<{ name: string; value: string }> }> } | undefined;
	const normalized = acceptance?.verify ? {
		...params,
		acceptance: { ...acceptance, verify: acceptance.verify.map((verify) => {
			if (!Array.isArray(verify.env)) return verify;
			const names = verify.env.map(({ name }) => name);
			if (new Set(names).size !== names.length) throw new Error("Verification environment contains duplicate names.");
			return { ...verify, env: Object.fromEntries(verify.env.map(({ name, value }) => [name, value])) };
		}) },
	} : params;
	if (control && !runArguments.Check(normalized)) throw new Error(`Invalid agent_runs arguments: ${[...runArguments.Errors(normalized)].map((error) => error.message).join("; ")}`);
	return normalized;
}
