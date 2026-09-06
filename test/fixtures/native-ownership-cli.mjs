// Controlled child transport. Session reads/writes are native Pi; no provider is invoked.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const { SessionManager } = await import(pathToFileURL(path.join(process.env.OWNERSHIP_SDK_ROOT, "dist/core/session-manager.js")).href);
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const file = value("--session");
if (!args.includes("--session") || !file) throw new Error("The ownership probe requires an explicit saved session.");
const session = SessionManager.open(file);
const previous = JSON.stringify(session.getEntries());
const modelArg = args.includes("--model") ? value("--model") : "openai/gpt-6-astra";
const suffix = modelArg.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[1];
const model = suffix ? modelArg.slice(0, -(suffix.length + 1)) : modelArg;
const slash = model.indexOf("/");
const provider = model.slice(0, slash), modelId = model.slice(slash + 1);
const thinking = suffix ?? "medium";
const task = args.filter((arg) => arg.startsWith("Task: ") || arg.startsWith("@")).map((arg) => arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8") : arg).join("\n");
const prompt = args.includes("--system-prompt") ? fs.readFileSync(value("--system-prompt"), "utf8") : args.includes("--append-system-prompt") ? fs.readFileSync(value("--append-system-prompt"), "utf8") : "";
const record = { pid: process.pid, cwd: process.cwd(), modelArg, model, thinking, sessionFile: file, previousMessages: session.getEntries().filter((entry) => entry.type === "message").length, task, prompt, tools: args.includes("--tools") ? value("--tools") : null, extensions: args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1]] : []), noExtensions: args.includes("--no-extensions"), noContextFiles: args.includes("--no-context-files"), noSkills: args.includes("--no-skills") };
fs.writeFileSync(path.join(process.env.OWNERSHIP_PROBE_DIR, `call-${Date.now()}-${randomUUID()}.json`), JSON.stringify(record));
session.appendModelChange(provider, modelId);
session.appendThinkingLevelChange(thinking);
session.appendMessage({ role: "user", content: task, timestamp: Date.now() });
const assistant = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], provider, model: modelId, api: "openai-responses", stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
const gate = task.match(/WAIT_GATE:(\w+)/)?.[1];
if (gate) {
	session.appendMessage(assistant("Checkpoint before controlled wait", "toolUse"));
	const end = Date.now() + 30_000;
	while (!fs.existsSync(path.join(process.env.OWNERSHIP_PROBE_DIR, gate))) {
		if (Date.now() > end) throw new Error("Controlled wait gate was not released.");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
if (task.includes("CREATE_QUESTION")) {
	session.appendMessage(assistant("Saved question checkpoint", "toolUse"));
	const { createSupervisorQuestion } = await import(pathToFileURL(path.join(process.env.OWNERSHIP_REPO, "dist/runs/shared/supervisor-questions.js")).href);
	createSupervisorQuestion({ runId: process.env.PI_SUBAGENT_RUN_ID, ownerTarget: "probe-parent", agent: "probe", index: Number(process.env.PI_SUBAGENT_CHILD_INDEX), childSessionId: session.getSessionId(), childTarget: "probe-child", sessionFile: file, cwd: process.cwd(), pid: process.pid, reason: "need_decision", message: "Choose a stable answer." });
}
let output = task.includes("RECALL_TOKEN") ? (previous.includes("FIRST_SESSION_TOKEN") ? "RECALLED FIRST_SESSION_TOKEN" : "TOKEN_MISSING") : "FIRST_SESSION_TOKEN";
const workflowResponse = task.match(/WORKFLOW_RESPONSE:([^\n]+)/)?.[1];
if (workflowResponse) {
	const response = JSON.parse(workflowResponse);
	output = response.text;
	if (Object.hasOwn(response, "value")) {
		const { default: register } = await import(pathToFileURL(path.join(process.env.OWNERSHIP_REPO, "dist/runs/shared/subagent-prompt-runtime.js")).href);
		let tool;
		register({ on() {}, registerTool(value) { if (value.name === "structured_output") tool = value; } });
		if (!tool) throw new Error("The workflow child requires the real structured_output tool.");
		const id = randomUUID();
		session.appendMessage({ ...assistant(output, "toolUse"), content: [{ type: "toolCall", id, name: tool.name, arguments: { value: response.value } }] });
		const result = await tool.execute(id, { value: response.value });
		session.appendMessage({ role: "toolResult", toolCallId: id, toolName: tool.name, ...result, isError: false, timestamp: Date.now() });
	}
}
if (task.includes("Supervisor answer to question")) output = "ANSWER_RECEIVED";
const failed = task.includes("PERMANENT_FAILURE");
if (failed) output = "Controlled permanent failure";
if (task.includes("Acceptance Contract") || task.includes("acceptance-report")) output += '\n```acceptance-report\n' + JSON.stringify({ criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Controlled child returned the requested token." }], manualNotes: "Native-session configuration probe", residualRisks: [] }) + '\n```';
const message = assistant(output, failed ? "error" : "stop");
if (failed) message.errorMessage = output;
session.appendMessage(message);
process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "agent_settled" })}\n`);
process.exitCode = failed ? 1 : 0;
