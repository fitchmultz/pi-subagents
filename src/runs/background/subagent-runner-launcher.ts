import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const RETRY_WINDOW_MS = 30_000;
const RETRY_DELAY_MS = 500;
const MAX_STDERR_LENGTH = 64 * 1024;

function run(runnerPath: string, configPath: string): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [runnerPath, configPath], {
			stdio: ["ignore", "inherit", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_LENGTH);
		});
		child.once("error", (error) => {
			const stderr = error.stack ?? error.message;
			process.stderr.write(`${stderr}\n`);
			resolve({ code: 1, stderr });
		});
		child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
	});
}

const [runnerPath, configPath] = process.argv.slice(2);
if (!runnerPath || !configPath) throw new Error("Usage: subagent-runner-launcher <runner> <config>");

let statusPath: string | undefined;
try {
	const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { asyncDir?: unknown };
	if (typeof config.asyncDir === "string") statusPath = path.join(config.asyncDir, "status.json");
} catch {}

// ponytail: bridge short in-place extension updates; use shared update locking if longer gaps appear.
const deadline = Date.now() + RETRY_WINDOW_MS;
let announcedRetry = false;
while (true) {
	const result = await run(runnerPath, configPath);
	const failedBeforeStartup = !statusPath || !fs.existsSync(statusPath);
	if (result.code === 0 || !failedBeforeStartup || !result.stderr.includes("ERR_MODULE_NOT_FOUND") || Date.now() >= deadline) {
		process.exitCode = result.code;
		break;
	}
	if (!announcedRetry) {
		process.stderr.write("[pi-subagents] Runner dependencies are being updated; retrying startup.\n");
		announcedRetry = true;
	}
	await delay(RETRY_DELAY_MS);
}
