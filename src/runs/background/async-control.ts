import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { readStatus } from "../../shared/utils.ts";

interface AsyncControlRequest {
	requestId: string;
	runId: string;
	action: "interrupt" | "cancel" | "extend";
	index?: number;
	extendMs?: number;
}

export function writeAsyncControlRequest(asyncDir: string, runId: string, action: AsyncControlRequest["action"], index?: number, extendMs?: number): void {
	if (action === "extend" && (typeof extendMs !== "number" || !Number.isSafeInteger(extendMs) || extendMs <= 0 || index !== undefined)) throw new Error("extendMs must be a positive integer.");
	const requestId = randomUUID();
	const file = readStatus(asyncDir)?.controlRequestFiles === true
		? path.join(asyncDir, "control-requests", `${requestId}.json`)
		: path.join(asyncDir, "control-request.json");
	writeAtomicJson(file, { requestId, runId, action, ...(index !== undefined ? { index } : {}), ...(extendMs !== undefined ? { extendMs } : {}), createdAt: Date.now() });
}

export function writeAsyncInterruptRequest(asyncDir: string, runId: string, index?: number): void {
	writeAsyncControlRequest(asyncDir, runId, "interrupt", index);
}

export function readAsyncControlRequests(asyncDir: string, runId: string): AsyncControlRequest[] {
	const directory = path.join(asyncDir, "control-requests");
	const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => path.join(directory, file)) : [];
	files.push(path.join(asyncDir, "control-request.json"));
	const requests: AsyncControlRequest[] = [];
	for (const file of files) {
		const claimed = `${file}.${randomUUID()}.reading`;
		try {
			// Claim before reading, so a legacy writer's replacement remains for the next poll.
			fs.renameSync(file, claimed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to claim async control request '${file}':`, error);
			continue;
		}
		try {
			if (fs.statSync(claimed).size > 64 * 1024) throw new Error("control request exceeds 64 KiB");
			const request = JSON.parse(fs.readFileSync(claimed, "utf-8")) as Partial<AsyncControlRequest>;
			if (!request || (request.action !== "interrupt" && request.action !== "cancel" && request.action !== "extend") || request.runId !== runId || typeof request.requestId !== "string" || !request.requestId) continue;
			if (request.index !== undefined && (!Number.isSafeInteger(request.index) || request.index < 0)) continue;
			if (request.action === "extend" && (typeof request.extendMs !== "number" || !Number.isSafeInteger(request.extendMs) || request.extendMs <= 0 || request.index !== undefined)) continue;
			requests.push(request as AsyncControlRequest);
		} catch (error) {
			console.error(`Failed to read async control request '${file}':`, error);
		} finally {
			fs.rmSync(claimed, { force: true });
		}
	}
	return requests;
}
