// Controlled child transport with a real native journal; the parent and detached owner are unmodified.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { SessionManager } = await import(pathToFileURL(path.join(process.env.NATIVE_ASYNC_SDK, "dist/index.js")).href);
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
if (!args.includes("--session")) throw new Error("The native async fixture requires a saved child session.");
const manager = SessionManager.open(sessionFile);
manager.appendModelChange("child-fixture", "actual-model");
manager.appendMessage({ role: "user", content: "Return the fixture result after release", timestamp: Date.now() });
const root = process.env.NATIVE_ASYNC_ROOT;
const started = { pid: process.pid, sessionFile, runId: process.env.PI_SUBAGENT_RUN_ID };
fs.appendFileSync(path.join(root, "child-starts.jsonl"), `${JSON.stringify(started)}\n`);
fs.writeFileSync(path.join(root, `child-${started.runId}.json`), JSON.stringify(started));
const deadline = Date.now() + 60_000;
while (!fs.existsSync(path.join(root, "release-child"))) {
	if (Date.now() > deadline) throw new Error("The native async fixture child was never released.");
	await delay(20);
}
const message = { role: "assistant", provider: "child-fixture", model: "actual-model", api: "openai-responses", stopReason: "stop", timestamp: Date.now(),
	content: [{ type: "text", text: "NATIVE_ORIGINAL_CALL_RESULT" }],
	usage: { input: 5, output: 7, cacheRead: 11, cacheWrite: 13, cacheWrite1h: 3, reasoning: 2, totalTokens: 36,
		cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } };
manager.appendMessage(message);
process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "agent_settled" })}\n`);
