import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AcceptanceLedger, ResolvedAcceptanceConfig } from "../../shared/types.ts";
import { setPromptSection } from "../../shared/prompt-sections.ts";
import { detectSubagentError, getFinalOutput } from "../../shared/utils.ts";
import {
	acceptanceFailureMessage, acceptanceSelfReviewConfig, createFinalizationReportRuntime,
	evaluateAcceptance, formatAcceptanceFinalizationPrompt, readFinalizationReport,
	resolveFinalizationOutput, stripAcceptanceReport,
} from "./acceptance.ts";
import { captureSingleOutputSnapshot, resolveSingleOutput, type SingleOutputSnapshot } from "./single-output.ts";
import { readStructuredOutput, validateStructuredOutputValue, type StructuredOutputRuntime } from "./structured-output.ts";

const CONFIG_ENV = "PI_SUBAGENT_FINALIZATION_CONFIG";
export const FINALIZATION_EVENT = "subagent.finalization";

export interface NativeFinalizationConfig {
	nonce: string;
	acceptance: ResolvedAcceptanceConfig;
	reportRuntime: ReturnType<typeof createFinalizationReportRuntime>;
	publicOutput?: StructuredOutputRuntime;
	outputPath?: string;
	outputSnapshot?: SingleOutputSnapshot;
}

export interface NativeFinalizationEvent {
	type: typeof FINALIZATION_EVENT;
	nonce: string;
	turn: number;
	lastEntryId?: string;
	messageCount: number;
	at: number;
	submission: ReturnType<typeof readFinalizationReport> & { error?: string };
	acceptance?: AcceptanceLedger;
	resolvedOutput: ReturnType<typeof resolveSingleOutput>;
	nextPrompt?: string;
}

export function createNativeFinalization(acceptance: ResolvedAcceptanceConfig, publicOutput?: StructuredOutputRuntime, outputPath?: string): NativeFinalizationConfig {
	return { nonce: randomUUID(), acceptance, reportRuntime: createFinalizationReportRuntime(publicOutput?.schema), publicOutput,
		outputPath, outputSnapshot: captureSingleOutputSnapshot(outputPath) };
}

export function nativeFinalizationLaunch(config: NativeFinalizationConfig): { extension: string; env: Record<string, string> } {
	const configPath = path.join(path.dirname(config.reportRuntime.schemaPath), "finalization.json");
	fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
	return { extension: fileURLToPath(new URL(`native-finalization${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url)), env: { [CONFIG_ENV]: configPath } };
}

/** Self-review includes structural and workspace checks; configured verification stays owner-run. */
export default function registerNativeFinalization(pi: ExtensionAPI): void {
	const configPath = process.env[CONFIG_ENV];
	if (!configPath) return;
	const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as NativeFinalizationConfig;
	const { acceptance, reportRuntime } = config;
	const selfReview = acceptanceSelfReviewConfig(acceptance);
	const messages: Message[] = [];
	let messageOffset = 0;
	let turn = 0;
	let initialOutput = "";
	let initialLedger: AcceptanceLedger | undefined;
	let resolvedOutput: ReturnType<typeof resolveSingleOutput> = { fullOutput: "" };
	const registerOutput = (runtime: StructuredOutputRuntime) => pi.registerTool({
		name: "structured_output", label: "Structured Output", description: "Submit the complete output matching the current schema.",
		parameters: Type.Object({ value: Type.Unsafe(runtime.schema) }, { additionalProperties: false }),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		execute: async (_id, args: { value: unknown }) => {
			const validation = validateStructuredOutputValue(runtime.schema, args.value);
			if (validation.status === "invalid") throw new Error(validation.message);
			fs.writeFileSync(runtime.outputPath, JSON.stringify(args.value), { mode: 0o600 });
			return { content: [{ type: "text", text: "Structured output captured." }], details: {}, terminate: true };
		},
	});
	if (config.publicOutput) {
		registerOutput(config.publicOutput);
		pi.on("before_agent_start", (event) => setPromptSection(event.systemPromptOptions, "subagent_output",
			"Your final action must call structured_output with JSON matching the current schema. Prose alone does not complete this output contract."));
	}
	pi.on("message_end", (event) => {
		if (["assistant", "user", "toolResult"].includes(event.message.role)) messages.push(event.message as Message);
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const submission: NativeFinalizationEvent["submission"] = turn === 0
			? { output: getFinalOutput(messages) }
			: readFinalizationReport(messages, reportRuntime, { messageOffset });
		if (turn === 0) {
			initialOutput = submission.output;
			const hiddenError = detectSubagentError(messages);
			if (hiddenError.hasError) submission.error = hiddenError.details ?? `${hiddenError.errorType} failed`;
			if (config.publicOutput) submission.error ??= readStructuredOutput(config.publicOutput).error;
		}
		const ledger = await evaluateAcceptance({ acceptance: selfReview, governing: acceptance, cwd: ctx.cwd,
			output: submission.reportSubmissionError ? "" : submission.output, report: submission.reportSubmissionError ? undefined : submission.report });
		initialLedger ??= ledger;
		if (!submission.error && !submission.reportSubmissionError) {
			const output = turn === 0 ? stripAcceptanceReport(submission.output) : resolveFinalizationOutput(submission.output, resolvedOutput.fullOutput);
			resolvedOutput = resolveSingleOutput(config.outputPath, output, turn === 0 ? config.outputSnapshot : resolvedOutput.writtenSnapshot);
			if (resolvedOutput.saveError) submission.error = `Failed to save output file '${config.outputPath}': ${resolvedOutput.saveError}`;
		}
		const continueReview = !submission.error && ledger.status !== "blocked" && turn < acceptance.finalization.maxTurns
			&& (turn === 0 || Boolean(submission.reportSubmissionError) || ledger.status === "rejected");
		const nextPrompt = continueReview ? formatAcceptanceFinalizationPrompt({ acceptance, initialOutput, initialLedger,
			turn: turn + 1, maxTurns: acceptance.finalization.maxTurns,
			previousFailure: submission.reportSubmissionError ?? acceptanceFailureMessage(ledger), nativeReport: true, outputSchema: config.publicOutput?.schema }) : undefined;
		const marker: NativeFinalizationEvent = { type: FINALIZATION_EVENT, nonce: config.nonce, turn, lastEntryId: ctx.sessionManager.getLeafId() ?? undefined, messageCount: messages.length, at: Date.now(), submission, acceptance: ledger, resolvedOutput, nextPrompt };
		fs.appendFileSync(path.join(path.dirname(reportRuntime.schemaPath), "boundaries.jsonl"), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
		if (!nextPrompt) return;
		if (turn === 0) {
			// Native registration refreshes the active schema after the public payload is captured.
			registerOutput(reportRuntime);
			pi.setActiveTools([...new Set([...pi.getActiveTools(), "structured_output"])]);
		}
		turn++;
		messageOffset = messages.length;
		return { entries: [...event.entries, { type: "custom_message", customType: "subagent-self-review", content: nextPrompt, display: false }], continue: true };
	});
}
