import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import type { SingleResult } from "../../shared/types.ts";

type CoordinationTool = "contact_supervisor" | "intercom";

interface CoordinationRequest {
	tool: CoordinationTool;
	reasonOrAction?: string;
	message?: string;
	target?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			return asRecord(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	return asRecord(value);
}

function oneLine(value: string, maxLength = 500): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractDetachedCoordinationRequest(result: Pick<SingleResult, "messages" | "toolCalls">): CoordinationRequest | undefined {
	for (let messageIndex = (result.messages?.length ?? 0) - 1; messageIndex >= 0; messageIndex -= 1) {
		const message = result.messages?.[messageIndex];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = asRecord(message.content[partIndex]);
			if (part?.type !== "toolCall") continue;
			const tool = part.name;
			if (tool !== "contact_supervisor" && tool !== "intercom") continue;
			const args = parseArgs(part.arguments);
			if (!args) return { tool };
			if (tool === "contact_supervisor") {
				return {
					tool,
					reasonOrAction: stringValue(args.reason),
					message: stringValue(args.message),
				};
			}
			return {
				tool,
				reasonOrAction: stringValue(args.action),
				message: stringValue(args.message),
				target: stringValue(args.to),
			};
		}
	}

	const expandedText = [...(result.toolCalls ?? [])]
		.reverse()
		.map((call) => call.expandedText ?? call.text)
		.find((text) => text?.startsWith("contact_supervisor ") || text?.startsWith("intercom "));
	if (!expandedText) return undefined;
	return { tool: expandedText.startsWith("contact_supervisor ") ? "contact_supervisor" : "intercom", message: oneLine(expandedText, 240) };
}

export function formatDetachedIntercomGuidance(input: {
	headline: string;
	runId: string;
	result: Pick<SingleResult, "agent" | "messages" | "toolCalls">;
	childIndex: number;
	includeStatusHint?: boolean;
}): string {
	const request = extractDetachedCoordinationRequest(input.result);
	const childTarget = resolveSubagentIntercomTarget(input.runId, input.result.agent, input.childIndex);
	const lines = [
		input.headline,
		"Child is waiting on a parent/coordinator reply.",
		"",
	];

	if (request) {
		const kind = request.reasonOrAction ? `${request.tool} ${request.reasonOrAction}` : request.tool;
		lines.push(`Request: ${kind}`);
		if (request.target) lines.push(`Requested target: ${request.target}`);
		if (request.message) lines.push(`Question: ${oneLine(request.message)}`);
		lines.push("");
	}

	lines.push(
		"Do this now:",
		"1. Inspect pending asks: intercom({ action: \"pending\" })",
		`2. Reply: intercom({ action: \"reply\", to: \"${childTarget}\", message: \"<answer>\" })`,
	);
	if (input.includeStatusHint !== false) {
		lines.push(`3. Then inspect the child: subagent({ action: \"status\", id: \"${input.runId}\" })`);
	}
	lines.push("After the child exits, start a fresh follow-up if needed.");

	return lines.join("\n");
}
