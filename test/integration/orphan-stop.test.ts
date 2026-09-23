import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { interruptAsyncRun } from "../../src/runs/foreground/foreground-control.ts";
import { ownedRunView } from "../../src/runs/shared/run-records.ts";
import { getRunMetadataDir, readQuestionContract, saveQuestionContract } from "../../src/runs/shared/supervisor-questions.ts";
import { readStatus } from "../../src/shared/utils.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { createEventBus, createTempDir, makeAgent, makeMinimalCtx } from "../support/helpers.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, message: string) {
	const deadline = Date.now() + 10_000;
	while (!check()) { assert.ok(Date.now() < deadline, message); await delay(20); }
}

for (const scenario of ["whole run", "selected child", "mismatched identity"] as const) {
	test(`Stop after runner crash: ${scenario}`, { timeout: 25_000 }, async (t) => {
		const cwd = createTempDir("orphan-stop-");
		const bin = path.join(cwd, "bin");
		fs.mkdirSync(bin);
		const ticker = path.join(cwd, "ticker.mjs");
		fs.writeFileSync(ticker, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
const heartbeat = ${JSON.stringify(cwd)} + '/heartbeat-' + process.pid;
process.title = 'pi';
process.on('SIGTERM', () => {});
if (!process.argv.includes('--descendant')) {
 const child = spawn(process.execPath, [${JSON.stringify(ticker)}, '--descendant'], { stdio: 'ignore' });
 fs.writeFileSync(${JSON.stringify(cwd)} + '/descendant-' + process.pid, String(child.pid));
 console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'scratch heartbeat' } }));
}
setInterval(() => fs.appendFileSync(heartbeat, 'tick\\n'), 30);
`);
		fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nunset NODE_OPTIONS\nexec '${process.execPath}' '${ticker}' "$@"\n`, { mode: 0o755 });
		const originalPath = process.env.PATH;
		process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
		const state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), ownedRuns: new Map() } as SubagentState;
		const executor = createSubagentExecutor({ pi: { events: createEventBus(), getSessionName: () => undefined }, state,
			config: {}, asyncByDefault: false, tempArtifactsDir: path.join(cwd, "artifacts"), getSubagentSessionRoot: () => path.join(cwd, "sessions"),
			expandTilde: (value) => value, discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }) });
		const pids: number[] = [];
		let id: string | undefined;
		t.after(async () => {
			process.env.PATH = originalPath;
			for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
			await delay(100);
			if (id) fs.rmSync(getRunMetadataDir(id), { recursive: true, force: true });
			fs.rmSync(cwd, { recursive: true, force: true });
		});
		const started = await executor.execute("start", { tasks: [{ agent: "worker", task: "Scratch heartbeat", output: false }, { agent: "worker", task: "Scratch heartbeat", output: false }], async: true }, undefined, undefined, makeMinimalCtx(cwd));
		assert.ok(!started.isError, JSON.stringify(started));
		id = started.details.asyncId!;
		const dir = started.details.asyncDir!;
		pids.push(started.details.asyncPid!);
		await until(() => Boolean(readQuestionContract(id!, 0)?.pid && readQuestionContract(id!, 1)?.pid), "children must start");
		const children = [0, 1].map((index) => readQuestionContract(id!, index)!.pid!);
		pids.push(...children);
		await until(() => children.every((pid) => fs.existsSync(path.join(cwd, `descendant-${pid}`))), "descendants must start");
		const descendants = children.map((pid) => Number(fs.readFileSync(path.join(cwd, `descendant-${pid}`), "utf8")));
		pids.push(...descendants);
		await until(() => [...children, ...descendants].every((pid) => fs.existsSync(path.join(cwd, `heartbeat-${pid}`))), "heartbeats must start");
		const runnerPid = readStatus(dir)!.pid!;
		pids.push(runnerPid);
		process.kill(runnerPid, "SIGKILL");
		await until(() => !alive(runnerPid), "runner must exit");
		const heartbeat = path.join(cwd, `heartbeat-${children[0]}`);
		const before = fs.statSync(heartbeat).size;
		await delay(100);
		assert.ok(fs.statSync(heartbeat).size > before, "child must still execute after the runner dies");
		assert.equal(ownedRunView(state.ownedRuns!.get(id)!, state).canInterrupt, true, "Stop must remain available for live orphaned children");
		if (scenario === "mismatched identity") saveQuestionContract(id, 1, { processIdentity: "different process birth" });
		const receipt = interruptAsyncRun(state, id, scenario === "selected child" ? 0 : undefined)!;
		if (scenario === "mismatched identity") {
			assert.equal(receipt.isError, true, "unverified PID ownership must reject Stop");
			assert.match(receipt.content[0]!.text, /ownership|session/i);
			assert.ok(children.every(alive), "unrelated process and sibling must survive");
			return;
		}
		assert.ok(!receipt.isError, JSON.stringify(receipt));
		assert.match(receipt.content[0]!.text, /exit are not yet confirmed/);
		assert.equal(readStatus(dir)!.steps![0]!.agentProcessExit, undefined, "Stop must not fabricate an exit receipt");
		const stopped = scenario === "whole run" ? [...children, ...descendants] : [children[0]!, descendants[0]!];
		await until(() => stopped.every((pid) => !alive(pid)), "orphaned child and commands must stop");
		const stoppedSize = fs.statSync(heartbeat).size;
		await delay(100);
		assert.equal(fs.statSync(heartbeat).size, stoppedSize, "stopped child must stop writing");
		if (scenario === "selected child") {
			assert.ok(alive(children[1]!) && alive(descendants[1]!), "selected Stop must preserve sibling and its commands");
			assert.ok(!interruptAsyncRun(state, id)!.isError, "whole-run Stop must also work after one child has exited");
			await until(() => !alive(children[1]!) && !alive(descendants[1]!), "remaining sibling must stop");
		}
		assert.equal(fs.existsSync(path.join(dir, "control-requests")), false, "dead runner must not receive an unread control request");
	});
}
