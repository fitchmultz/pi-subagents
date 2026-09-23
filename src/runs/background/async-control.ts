import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { readStatus } from "../../shared/utils.ts";
import { readQuestionContract, readRunJson } from "../shared/supervisor-questions.ts";
import { checkPidLiveness } from "./stale-run-reconciler.ts";
import { readChildProcessIdentity, trySignalChildTree } from "../../shared/post-exit-stdio-guard.ts";

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
	const file = readStatus(asyncDir)?.controlRequestFiles === true || readRunJson<{ runtimeVersion?: number }>(path.join(asyncDir, "launch.json"))?.runtimeVersion === 2
		? path.join(asyncDir, "control-requests", `${requestId}.json`)
		: path.join(asyncDir, "control-request.json");
	writeAtomicJson(file, { requestId, runId, action, ...(index !== undefined ? { index } : {}), ...(extendMs !== undefined ? { extendMs } : {}), createdAt: Date.now() });
}

export function writeAsyncInterruptRequest(asyncDir: string, runId: string, index?: number): void {
	const status = readStatus(asyncDir);
	if (status?.runId === runId && status.state === "running" && status.pid && checkPidLiveness(status.pid) === "dead") {
		if (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || status.steps?.[index]?.status !== "running")) {
			throw new Error(`No running child at index ${index}. No siblings were stopped.`);
		}
		// Validate every target before signaling any: stale PIDs must never stop unrelated work.
		const children = (status.steps ?? []).flatMap((step, childIndex) => {
			if (step.status !== "running" || (index !== undefined && index !== childIndex)) return [];
			const contract = readQuestionContract(runId, childIndex, undefined, { readConfiguration: false });
			if (!contract?.pid || !Number.isSafeInteger(contract.pid) || contract.pid <= 0) throw new Error(`Cannot verify process ownership for child ${childIndex}.`);
			if (checkPidLiveness(contract.pid) === "dead") return [];
			if (!contract.processIdentity || readChildProcessIdentity(contract.pid) !== contract.processIdentity) {
				throw new Error(`Cannot verify process ownership for child ${childIndex}. No stop was sent.`);
			}
			return [{ pid: contract.pid, identity: contract.processIdentity }];
		});
		for (const { pid, identity } of children) {
			const child = { pid, kill: (signal?: NodeJS.Signals | number) => process.kill(pid, signal) };
			if (!trySignalChildTree(child, "SIGTERM")) throw new Error(`Could not signal orphaned child process ${pid}. Exit is unconfirmed.`);
			// Match normal Stop escalation, including descendants surviving their group leader.
			setTimeout(() => {
				if (checkPidLiveness(pid) === "dead") {
					try { process.kill(-pid, "SIGKILL"); } catch {}
				} else if (readChildProcessIdentity(pid) === identity) {
					trySignalChildTree(child, "SIGKILL");
				}
			}, 3000).unref();
		}
		return;
	}
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
