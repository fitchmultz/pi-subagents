import * as fs from "node:fs";
import type { AsyncResultChild, AsyncResultFile, AsyncResultTerminalState } from "../../shared/types.ts";

export type ParsedAsyncResultFile = Omit<AsyncResultFile, "results"> & {
	results?: AsyncResultChild[];
	terminalState: AsyncResultTerminalState;
};

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function deriveAsyncResultTerminalState(input: Pick<AsyncResultFile, "success" | "state" | "exitCode">): AsyncResultTerminalState {
	if (input.success === true) return "complete";
	if (input.success === false) return input.state === "paused" ? "paused" : "failed";
	if (input.state === "complete" || input.state === "failed" || input.state === "paused") return input.state;
	if (input.exitCode === 0) return "paused";
	return "failed";
}

function normalizeResultChild(value: unknown, index: number, resultPath: string): AsyncResultChild {
	if (!isRecord(value)) throw new Error(`Invalid async result file '${resultPath}': results[${index}] must be an object.`);
	return value as AsyncResultChild;
}

export function parseAsyncResultFileContent(content: string, resultPath = "<inline>"): ParsedAsyncResultFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (!isRecord(parsed)) {
		throw new Error(`Failed to parse async result file '${resultPath}': expected a JSON object.`);
	}

	const data = parsed as AsyncResultFile;
	if (data.results !== undefined && !Array.isArray(data.results)) {
		throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
	}
	const results = Array.isArray(data.results) ? data.results.map((child, index) => normalizeResultChild(child, index, resultPath)) : undefined;
	return {
		...data,
		...(results ? { results } : {}),
		terminalState: deriveAsyncResultTerminalState(data),
	};
}

export function readAsyncResultFile(resultPath: string): ParsedAsyncResultFile {
	let content: string;
	try {
		content = fs.readFileSync(resultPath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	return parseAsyncResultFileContent(content, resultPath);
}

export function readAsyncResultFileIfExists(resultPath: string): ParsedAsyncResultFile | undefined {
	try {
		return readAsyncResultFile(resultPath);
	} catch (error) {
		if (isNotFoundError(error instanceof Error ? error.cause : undefined)) return undefined;
		throw error;
	}
}
