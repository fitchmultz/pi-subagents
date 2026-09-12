import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findPackageJSON } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";

const args = process.argv.slice(2), cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK;
assert.ok(sdkRoot && process.env.PI_FEEDBACK_RELEASE_FILE, "Run only through the private native feedback test");
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const { toJsonEvent } = await import(pathToFileURL(path.join(sdkRoot, "dist/modes/json-event.js")).href);
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const releasePath = process.env.PI_FEEDBACK_RELEASE_FILE.replace("{index}", process.env.PI_SUBAGENT_CHILD_INDEX ?? "0");
const receiptPath = `${releasePath}.json`;
const receipt = { pid: process.pid, networkRequests: 0, modelCalls: 0, errors: [], events: [] };
const save = () => writeAtomicJson(receiptPath, receipt);
globalThis.fetch = async () => { receipt.networkRequests++; save(); throw new Error("Network forbidden in native feedback fixture"); };
const streaming = process.env.PI_FEEDBACK_SCENARIO === "streaming";
const faux = ai.fauxProvider({ provider: "feedback-fixture", ...(streaming ? { tokensPerSecond: 40, tokenSize: { min: 1, max: 1 } } : {}) });
const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(!streaming ? faux.provider : { ...faux.provider, streamSimple(model, context, options) {
	const source = faux.provider.streamSimple(model, context, options), output = ai.createAssistantMessageEventStream();
	void (async () => {
		let text = "", held = false;
		try {
			for await (const event of source) {
				output.push(structuredClone(event));
				if (event.type === "text_delta") text += event.delta;
				if (!held && text.includes("Second live text")) {
					held = true; receipt.waitingForStreamRelease = true; save();
					while (!fs.existsSync(releasePath)) await sleep(10, undefined, { signal: options?.signal });
				}
			}
			output.end(await source.result());
		} catch (cause) {
			const reason = options?.signal?.aborted ? "aborted" : "error";
			const error = { ...ai.fauxAssistantMessage("", { stopReason: reason, errorMessage: String(cause) }), api: model.api, provider: model.provider, model: model.id };
			output.push({ type: "error", reason, error }); output.end(error);
		}
	})();
	return output;
} });
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
	systemPrompt: "Synthetic feedback test; no external work.",
	additionalExtensionPaths: [process.env.PI_INTERCOM_TEST_EXTENSION ?? fileURLToPath(new URL("../../src/pi-intercom/index.ts", import.meta.url))],
	extensionFactories: [(pi) => pi.registerTool({ name: "bash", label: "Bash", description: "Synthetic bounded tool, no command execution", parameters: ai.Type.Object({}), async execute() {
		const deadline = Date.now() + 15_000;
		while (!fs.existsSync(releasePath)) { assert.ok(Date.now() < deadline, "Native fixture tool was not released"); await sleep(10); }
		return { content: [{ type: "text", text: "Synthetic command finished normally" }], details: {} };
	} })],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const sessionFile = args[args.indexOf("--session") + 1];
assert.ok(args.includes("--session") && sessionFile);
const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader, model: faux.getModel(), noTools: "builtin", sessionManager: sdk.SessionManager.open(sessionFile, undefined, cwd) });
await session.bindExtensions({ mode: "json", onError: (error) => receipt.errors.push(error) });
const tool = process.env.PI_FEEDBACK_SCENARIO === "question" ? "contact_supervisor" : "bash";
faux.setResponses(streaming ? [ai.fauxAssistantMessage([{ type: "text", text: "First live text block." }, { type: "text", text: "Second live text block continues before message end." }])] : [ai.fauxAssistantMessage(ai.fauxToolCall(tool, tool === "contact_supervisor" ? { reason: "need_decision", message: "Which synthetic path should I use?" } : {}), { stopReason: "toolUse" }), ai.fauxAssistantMessage("Synthetic child finished normally")]);
session.subscribe((event) => {
	if (!["tool_execution_start", "tool_execution_end", "message_start", "message_update", "message_end", "agent_settled"].includes(event.type)) return;
	receipt.events.push({ type: event.type, role: event.message?.role, toolName: event.toolName, timestamp: Date.now() });
	receipt.modelCalls = faux.state.callCount;
	receipt.sessionFile = session.sessionFile;
	save();
	process.stdout.write(`${JSON.stringify(toJsonEvent(event))}\n`);
});
const watchdog = setTimeout(() => { void session.abort(); }, 15_000);
try {
	const prompt = args.at(-1);
	await session.prompt(prompt.startsWith("@") ? fs.readFileSync(prompt.slice(1), "utf8") : prompt);
	await session.waitForIdle();
	assert.deepEqual(receipt.errors, []);
	assert.equal(receipt.networkRequests, 0);
} finally {
	clearTimeout(watchdog);
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	await session.abort();
	session.dispose();
	receipt.modelCalls = faux.state.callCount;
	save();
}
