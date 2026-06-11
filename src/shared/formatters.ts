/**
 * Formatting utilities for display output
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Usage, SingleResult } from "./types.ts";
import type { ChainStep } from "./settings.ts";
import { isDynamicParallelStep, isParallelStep } from "./settings.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS } from "./model-info.ts";

/**
 * Format token count with k suffix for large numbers
 */
export function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export function formatModelThinking(model?: string, thinking?: string): string {
	const parsed = model ? splitKnownThinkingSuffix(model) : undefined;
	let displayModel = parsed?.baseModel ?? model;
	const explicitThinking = THINKING_LEVELS.find((level) => level === thinking?.trim());
	const displayThinking = parsed?.thinkingSuffix ? parsed.thinkingSuffix.slice(1) : explicitThinking;
	if (displayModel) {
		const slashIdx = displayModel.lastIndexOf("/");
		if (slashIdx !== -1) displayModel = displayModel.slice(slashIdx + 1);
	}
	return [displayModel, displayThinking ? `thinking ${displayThinking}` : undefined].filter(Boolean).join(" · ");
}

/**
 * Format usage statistics into a compact string
 */
export function formatUsage(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`in:${formatTokens(u.input)}`);
	if (u.output) parts.push(`out:${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function clipChainOutput(value: string, maxChars = 500): string {
	const trimmed = value.trim();
	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}…` : trimmed;
}

function formatChainOutputsSummary(results: SingleResult[]): string {
	const lines: string[] = [];
	for (const [index, result] of results.entries()) {
		if (result.outputReference) {
			lines.push(`  ${index + 1}. ${result.agent}: ${result.outputReference.path} (${result.outputReference.bytes} B, ${result.outputReference.lines} ${result.outputReference.lines === 1 ? "line" : "lines"})`);
			continue;
		}
		if (result.finalOutput?.trim()) lines.push(`  ${index + 1}. ${result.agent}: ${clipChainOutput(result.finalOutput)}`);
	}
	if (lines.length === 0) return "";
	const visible = lines.slice(-5);
	const hidden = lines.length - visible.length;
	return `📤 Outputs:${hidden > 0 ? ` (${hidden} earlier omitted)` : ""}\n${visible.join("\n")}`;
}

/**
 * Build a summary string for a completed/failed chain
 */
export function buildChainSummary(
	steps: ChainStep[],
	results: SingleResult[],
	chainDir: string,
	status: "completed" | "failed",
	failedStep?: { index: number; error: string },
): string {
	const stepNames = steps
		.map((step) => (isParallelStep(step) ? `parallel[${step.parallel.length}]` : isDynamicParallelStep(step) ? `expand:${step.parallel.agent}` : step.agent))
		.join(" → ");

	const totalDuration = results.reduce((sum, r) => sum + (r.progress?.durationMs || 0), 0);
	const durationStr = formatDuration(totalDuration);

	const progressPath = path.join(chainDir, "progress.md");
	const hasProgress = fs.existsSync(progressPath);
	const allSkills = new Set<string>();
	for (const r of results) {
		if (r.skills) r.skills.forEach((s) => allSkills.add(s));
	}
	const skillsLine = allSkills.size > 0 ? `🔧 Skills: ${[...allSkills].join(", ")}` : "";
	const outputsSummary = formatChainOutputsSummary(results);

	if (status === "completed") {
		const stepWord = results.length === 1 ? "step" : "steps";
		return `✅ Chain completed: ${stepNames} (${results.length} ${stepWord}, ${durationStr})${skillsLine ? `\n${skillsLine}` : ""}

📋 Progress: ${hasProgress ? progressPath : "(none)"}${outputsSummary ? `\n${outputsSummary}` : ""}
📁 Artifacts: ${chainDir}`;
	} else {
		const stepInfo = failedStep ? ` at step ${failedStep.index + 1}` : "";
		const errorInfo = failedStep?.error ? `: ${failedStep.error}` : "";
		return `❌ Chain failed${stepInfo}${errorInfo}${skillsLine ? `\n${skillsLine}` : ""}

📋 Progress: ${hasProgress ? progressPath : "(none)"}${outputsSummary ? `\n${outputsSummary}` : ""}
📁 Artifacts: ${chainDir}`;
	}
}

/**
 * Format a tool call for display
 */
export function formatToolCall(name: string, args: Record<string, unknown>, expanded = false): string {
	switch (name) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "";
			const maxLength = expanded ? 240 : 60;
			return `$ ${command.slice(0, maxLength)}${command.length > maxLength ? "..." : ""}`;
		}
		case "read":
		case "write":
		case "edit": {
			const target = typeof args.path === "string"
				? args.path
				: typeof args.file_path === "string"
					? args.file_path
					: "";
			return `${name} ${shortenPath(target)}`;
		}
		default: {
			const s = JSON.stringify(args);
			const maxLength = expanded ? 160 : 40;
			return `${name} ${s.slice(0, maxLength)}${s.length > maxLength ? "..." : ""}`;
		}
	}
}

/**
 * Shorten a path by replacing home directory with ~
 */
export function shortenPath(p: string): string {
	const home = process.env.HOME;
	if (home && p.startsWith(home)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}
