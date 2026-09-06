// Credential-free CLI double: real detached launcher, runner, child, and broker processes.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(import.meta.url);
const evidence = process.env.SMOKE_CLEANUP_EVIDENCE;
const scenario = process.env.SMOKE_CLEANUP_SCENARIO;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const root = dirname(agentDir);
const runtime = process.env.PI_SUBAGENT_TEMP_ROOT ?? join(tmpdir(), `pi-subagents-uid-${process.getuid()}`);
const runId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const asyncDir = join(runtime, "async-subagent-runs", runId);
const sessions = join(root, "sessions");
const sessionFile = join(sessions, "parent.jsonl");
const args = process.argv.slice(2);
const role = args[0];
const record = (event, extra = {}) => appendFileSync(join(evidence, "events.jsonl"), `${JSON.stringify({ event, role, pid: process.pid, time: Date.now(), ...extra })}\n`);
const resourcesPresent = () => ({ auth: existsSync(join(agentDir, "auth.json")), models: existsSync(join(agentDir, "models.json")), artifacts: existsSync(asyncDir) });
const launch = (kind, detached = true) => spawn(process.execPath, [fixture, kind], { detached, stdio: "ignore", env: process.env });
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };

if (["launcher", "runner", "child", "broker"].includes(role)) {
	record("started");
	process.on("SIGTERM", () => {
		record("stopping", resourcesPresent());
		if (role !== "child") setTimeout(() => process.exit(0), 150);
	});
	process.on("exit", () => record("exiting", resourcesPresent()));
	if (role === "launcher") {
		const runner = launch("runner", false);
		runner.on("exit", () => process.exit(0));
	} else if (role === "runner") {
		mkdirSync(asyncDir, { recursive: true });
		const child = launch("child");
		save(join(agentDir, "sessions", "subagent-runs", runId, "contracts", "0.json"), { pid: child.pid, sessionFile: join(sessions, "child.jsonl"), updatedAt: Date.now() });
		while (!existsSync(join(evidence, "child-ready"))) await delay(10);
		const state = scenario === "success" ? "complete" : scenario === "async-failure" ? "failed" : "running";
		writeFileSync(join(asyncDir, "output-0.log"), "real-pi-smoke async ok\n");
		save(join(asyncDir, "status.json"), { runId, sessionId, pid: process.pid, state, startedAt: Date.now(), mode: "single" });
		writeFileSync(join(evidence, "runner-ready"), "ready");
		if (scenario === "success") {
			await delay(1200); // Terminal status is published before the runner's final artifact write.
			record("finalizing", resourcesPresent());
			writeFileSync(join(asyncDir, "final-result.json"), "{}\n");
			process.exit(0);
		}
	} else if (role === "child") {
		const writeAt = Date.now() + 6000;
		save(join(evidence, "child-ready"), { writeAt });
		if (scenario === "success") setTimeout(() => process.exit(0), 200);
		else setTimeout(() => {
			record("delayed-write", resourcesPresent());
			writeFileSync(join(evidence, "delayed-child-write"), "orphan wrote after the smoke ended\n");
		}, 6000);
	} else {
		save(join(evidence, "broker-ready"), { pid: process.pid });
		if (scenario.startsWith("startup-")) await delay(10000); // Detached before publishing broker.pid, like slow module startup.
		mkdirSync(join(agentDir, "intercom"), { recursive: true });
		writeFileSync(join(agentDir, "intercom", "broker.pid"), `${process.pid}\n`);
	}
	setInterval(() => {}, 1000);
} else if (role === "install") {
	save(join(evidence, "install.json"), { repo: args[1], root });
} else if (role === "list") {
	console.log(JSON.parse(readFileSync(join(evidence, "install.json"), "utf8")).repo);
} else if (role === "--version") {
	console.log("credential-free-fixture");
} else if (args.includes("rpc")) {
	console.log(JSON.stringify({ type: "response", id: "commands", success: true, data: { commands: ["intercom", "subagents-doctor", "skill:pi-intercom", "skill:pi-subagents"].map(name => ({ name })) } }));
} else {
	const prompt = args.at(-1);
	const kind = prompt.includes("intercom tool") ? "intercom" : prompt.includes("action profiles") ? "list"
		: prompt.includes("Set async true") ? "async" : prompt.includes("parallel mode") ? "parallel"
			: prompt.includes("chain mode") ? "chain" : prompt.includes("outputMode") ? "output"
				: prompt.includes("acceptance criteria") ? "acceptance" : "foreground";
	record("prompt", { kind });
	mkdirSync(sessions, { recursive: true });
	if (!existsSync(sessionFile)) appendFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
	if (kind === "intercom") {
		launch("broker").unref();
		while (!existsSync(join(evidence, "broker-ready"))) await delay(10);
	}
	if (kind === "async" || (kind === "intercom" && !["success", "async-failure", "async-timeout"].includes(scenario))) {
		const launcher = launch("launcher");
		launcher.unref();
		appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType: "subagent-run", data: { runId, ownerSessionId: sessionId, source: "async", pid: launcher.pid, asyncDir } })}\n`);
		while (!existsSync(join(evidence, "runner-ready"))) await delay(10);
		save(join(evidence, "parent-ready"), resourcesPresent());
		if (scenario === "startup-failure") await delay(600); // Parent's broker startup wait fails before PID publication.
		if (scenario === "failure" || scenario === "startup-failure") process.exit(19);
		if (["timeout", "startup-timeout", "SIGINT", "SIGTERM"].includes(scenario)) {
			setInterval(() => {}, 1000);
			await new Promise(() => {});
		}
	}
	if (kind === "output") {
		const outputPath = JSON.parse(prompt.match(/output to ("[^"]+")/)[1]);
		writeFileSync(outputPath, "real-pi-smoke output ok\n");
	}
	const text = `real-pi-smoke ${kind === "async" ? `async launched ok Async: real-smoke [${runId}]` : `${kind} ok`}`;
	const message = { role: "assistant", provider: "fixture", model: "smoke", content: [{ type: "text", text }] };
	appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message })}\n`);
	const toolName = kind === "intercom" ? "intercom" : kind === "list" ? "agent_runs" : ["foreground", "async"].includes(kind) ? "delegate" : "subagent";
	for (const event of [{ type: "tool_execution_start", toolName }, { type: "tool_execution_end", toolName, isError: false }, { type: "message_end", message }, { type: "agent_settled" }]) console.log(JSON.stringify(event));
}
