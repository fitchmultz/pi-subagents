// Controlled child transport. Sessions and acceptance use native Pi; no external provider is invoked.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { findPackageJSON } from "node:module";
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
Object.assign(record, { sessionCwd: session.getCwd(), headerCwd: session.getHeader()?.cwd,
	sessionCwdOverride: process.env.PI_SUBAGENT_SESSION_CWD, nodeOptions: process.env.NODE_OPTIONS });
const callName = `call-${Date.now()}-${randomUUID()}.json`;
const temporaryCall = path.join(process.env.OWNERSHIP_PROBE_DIR, `.${callName}.tmp`);
fs.writeFileSync(temporaryCall, JSON.stringify(record));
fs.renameSync(temporaryCall, path.join(process.env.OWNERSHIP_PROBE_DIR, callName));
const report = { criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Controlled child returned the requested token." }], manualNotes: "Native-session configuration probe", residualRisks: [] };
if (process.env.PI_SUBAGENT_FINALIZATION_CONFIG) {
	const sdkEntry = pathToFileURL(path.join(process.env.OWNERSHIP_SDK_ROOT, "dist/index.js"));
	const sdk = await import(sdkEntry.href);
	const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
	const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
	globalThis.fetch = async () => { throw new Error("Network forbidden in native ownership fixture"); };
	const faux = ai.fauxProvider({ provider, models: [{ id: modelId, reasoning: true }], tokensPerSecond: 1_000_000, tokenSize: { min: 1024, max: 1024 } });
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: process.cwd(), agentDir: sdk.getAgentDir(), settingsManager,
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		additionalExtensionPaths: record.extensions, systemPrompt: prompt });
	await loader.reload();
	if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const { session: driver } = await sdk.createAgentSession({ cwd: process.cwd(), agentDir: sdk.getAgentDir(), settingsManager,
		resourceLoader: loader, modelRuntime, sessionManager: session, model: faux.getModel(),
		noTools: "builtin", tools: record.tools?.split(",") });
	driver.setThinkingLevel(thinking);
	await driver.bindExtensions({ mode: "json", onError: (error) => { throw new Error(JSON.stringify(error)); } });
	const answer = task.includes("Supervisor answer to question") ? "ANSWER_RECEIVED" : task.includes("RECALL_TOKEN")
		? previous.includes("FIRST_SESSION_TOKEN") ? "RECALLED FIRST_SESSION_TOKEN" : "TOKEN_MISSING" : "FIRST_SESSION_TOKEN";
	faux.setResponses([
		async () => {
			if (task.includes("CREATE_QUESTION")) {
				const { createSupervisorQuestion } = await import(pathToFileURL(path.join(process.env.OWNERSHIP_REPO, "dist/runs/shared/supervisor-questions.js")).href);
				createSupervisorQuestion({ runId: process.env.PI_SUBAGENT_RUN_ID, ownerTarget: "probe-parent", agent: "probe", index: Number(process.env.PI_SUBAGENT_CHILD_INDEX), childSessionId: session.getSessionId(), childTarget: "probe-child", sessionFile: file, cwd: process.cwd(), pid: process.pid, reason: "need_decision", message: "Choose a stable answer." });
			}
			return ai.fauxAssistantMessage(`${answer}\n\n\`\`\`acceptance-report\n${JSON.stringify(report)}\n\`\`\``);
		},
		ai.fauxAssistantMessage(ai.fauxToolCall("structured_output", { value: { answer, report } }), { stopReason: "toolUse" }),
	]);
	driver.subscribe((event) => { process.stdout.write(`${JSON.stringify(event)}\n`); });
	try {
		await driver.prompt(task);
		await driver.waitForIdle();
		record.providerCalls = faux.state.callCount;
		fs.writeFileSync(path.join(process.env.OWNERSHIP_PROBE_DIR, callName), JSON.stringify(record));
	} finally { driver.dispose(); }
} else {
session.appendModelChange(provider, modelId);
session.appendThinkingLevelChange(thinking);
session.appendMessage({ role: "user", content: task, timestamp: Date.now() });
const assistant = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], provider, model: modelId, api: "openai-responses", stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
async function submitStructuredOutput(value) {
	const { default: register } = await import(pathToFileURL(path.join(process.env.OWNERSHIP_REPO, "dist/runs/shared/subagent-prompt-runtime.js")).href);
	let tool;
	register({ on() {}, registerTool(value) { if (value.name === "structured_output") tool = value; } });
	if (!tool) throw new Error("The workflow child requires the real structured_output tool.");
	const id = randomUUID();
	const message = { ...assistant("", "toolUse"), content: [{ type: "toolCall", id, name: tool.name, arguments: { value } }] };
	session.appendMessage(message);
	const result = await tool.execute(id, { value });
	const toolResult = { role: "toolResult", toolCallId: id, toolName: tool.name, ...result, isError: false, timestamp: Date.now() };
	session.appendMessage(toolResult);
	return [message, toolResult];
}
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
	if (Object.hasOwn(response, "value")) await submitStructuredOutput(response.value);
}
if (task.includes("Supervisor answer to question")) output = "ANSWER_RECEIVED";
const failed = task.includes("PERMANENT_FAILURE");
if (failed) output = "Controlled permanent failure";
const message = assistant(output, failed ? "error" : "stop");
if (failed) message.errorMessage = output;
session.appendMessage(message);
process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
process.exitCode = failed ? 1 : 0;

}
