import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { findPackageJSON } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(process.env.PI_PROMPT_TEST_EVIDENCE_DIR ?? os.tmpdir(), "pi-prompt-sections-"));
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
Object.assign(process.env, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" });
const sdkRoot = process.env.PI_PROMPT_TEST_SDK;
const sdkURL = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkURL));
const sdk = await import(sdkURL.href);
const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")));
const responses = await import(pathToFileURL(path.join(aiRoot, "dist/api/openai-responses.js")));
const { default: childRuntime, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_FANOUT_BOUNDARY_INSTRUCTIONS } = await import(pathToFileURL(process.env.PI_PROMPT_TEST_RUNTIME ?? path.join(repo, "src/runs/shared/subagent-prompt-runtime.ts")));
const { default: intercom } = await import(pathToFileURL(process.env.PI_PROMPT_TEST_INTERCOM ?? path.join(repo, "src/pi-intercom/index.ts")));
const sessions = [];
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("No network allowed in native prompt tests"); };
after(async () => {
	for (const session of sessions) {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	assert.equal(networkAttempts, 0);
	if (!process.env.PI_PROMPT_TEST_EVIDENCE_DIR) fs.rmSync(root, { recursive: true, force: true });
});
const toolNames = ["subagent", "delegate", "agent_runs"];
const skills = ["safe-skill", "pi-subagents"].map((name) => ({ name, description: `${name} catalog sentinel`,
	filePath: path.join(root, name, "SKILL.md"), baseDir: root, disableModelInvocation: false,
	sourceInfo: { path: root, source: "fixture", scope: "temporary", origin: "top-level" } }));

async function make({ child = true, fanout = false, inherited = true, sessionFile, profile = "CHILD PROFILE", replacement,
	full = false, fullAfter = false, peer = false, script = [ai.fauxAssistantMessage("done")] } = {}) {
	process.env.PI_SUBAGENT_INHERIT_SKILLS = inherited ? "1" : "0";
	process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = inherited ? "1" : "0";
	process.env.PI_SUBAGENT_FANOUT_CHILD = fanout ? "1" : "0";
	const faux = ai.fauxProvider({ provider: "prompt-fixture", api: "openai-responses" });
	const model = { ...faux.getModel(), compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } };
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } });
	const captures = [];
	const fullWriter = (pi) => pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nOPAQUE FULL OVERRIDE` }));
	const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		systemPromptOverride: () => replacement,
		appendSystemPromptOverride: () => [profile, '<skill name="explicit">SELECTED SKILL BODY</skill>'],
		agentsFilesOverride: () => ({ agentsFiles: inherited ? [{ path: "/fixture/AGENTS.md", content: "PROJECT POLICY" }] : [] }),
		skillsOverride: () => ({ skills: inherited ? skills : [], diagnostics: [] }),
		extensionFactories: [...(full && !fullAfter ? [fullWriter] : []), ...(child ? [childRuntime] : []), ...(peer ? [intercom] : []), ...(fullAfter ? [fullWriter] : [])],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const sm = sessionFile ? sdk.SessionManager.open(sessionFile) : sdk.SessionManager.create(root, path.join(root, "sessions"));
	const { session } = await sdk.createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, model,
		resourceLoader: loader, settingsManager: settings, sessionManager: sm, tools: ["read", ...toolNames],
		customTools: toolNames.map((name) => ({ name, label: name, description: "Synthetic history only; no delegation", parameters: ai.Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: `${name} nested result` }], details: {} }) })),
	});
	const errors = [];
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
	sessions.push(session);
	faux.setResponses(script.map((message) => (context) => { captures.push(structuredClone(context)); return message; }));
	return { session, sm, captures, payloads: [], model, faux, errors };
}
async function run(instance, text = "ASSIGNED TASK") {
	await instance.session.prompt(text);
	await instance.session.waitForIdle();
	assert.deepEqual(instance.errors, []);
	for (const context of instance.captures.slice(instance.payloads.length)) {
		let payload;
		// Use the real Responses payload builder and stop before transport dispatch.
		await responses.stream({ ...instance.model, baseUrl: "https://invalid.invalid/v1" }, context, {
			apiKey: "fixture", transport: "sse", fetch: globalThis.fetch,
			onPayload(value) { payload = structuredClone(value); throw new Error("STOP_BEFORE_NETWORK"); },
		}).result();
		assert.ok(payload, "real provider payload built before the network tripwire");
		instance.payloads.push(payload);
	}
	return instance;
}
const currentPrompt = (instance, index = 0) => ai.getCurrentSystemPrompt(instance.captures[index].messages);
const wire = (instance, index = 0) => instance.payloads[index].input;
function save(label, instance) {
	if (process.env.PI_PROMPT_TEST_EVIDENCE_DIR) fs.writeFileSync(path.join(root, `${label}.json`), JSON.stringify({ captures: instance.captures, payloads: instance.payloads, entries: instance.sm.getEntries() }, null, 2));
}

test("unchanged-history forks preserve provider input prefix; fresh and disabled inheritance preserve selected text", async () => {
	const parent = await run(await make({ child: false, profile: "PARENT PROFILE", script: [ai.fauxAssistantMessage([
		{ type: "thinking", thinking: "", redacted: true, thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_exact", encrypted_content: "OPAQUE_REASONING", summary: [] }) },
		{ type: "text", text: "PARENT ANSWER", textSignature: JSON.stringify({ v: 1, id: "msg_exact", phase: "commentary" }) },
	])] }), "PARENT TASK");
	const parentFile = parent.sm.getSessionFile();
	const parentBytes = fs.readFileSync(parentFile, "utf8");
	const forkFile = parent.sm.createBranchedSession(parent.sm.getLeafId());
	const baseline = await run(await make({ child: false, sessionFile: parentFile, profile: "PARENT PROFILE" }), "PARENT CONTINUATION");
	const forkBytes = fs.readFileSync(forkFile, "utf8");
	const fork = await run(await make({ sessionFile: forkFile }));
	const prefix = wire(baseline).slice(0, -1);
	assert.deepEqual(wire(fork).slice(0, prefix.length), prefix, "unchanged history must keep every inherited provider input item");
	assert.match(currentPrompt(fork), /<subagent_role>/);
	assert.match(currentPrompt(fork), /Do not propose or run subagents/);
	assert.doesNotMatch(currentPrompt(fork), /pi-subagents catalog sentinel/);
	assert.match(currentPrompt(fork), /safe-skill catalog sentinel/);
	assert.ok(wire(fork).some((item) => item.id === "rs_exact" && item.encrypted_content === "OPAQUE_REASONING"));
	assert.ok(wire(fork).some((item) => item.id === "msg_exact" && item.phase === "commentary"));
	assert.ok(fs.readFileSync(forkFile, "utf8").startsWith(forkBytes), "fork journal remains append-only");
	assert.ok(fs.readFileSync(parentFile, "utf8").startsWith(parentBytes), "parent journal remains append-only");
	const fresh = await run(await make({ inherited: false, replacement: "INTENTIONAL REPLACEMENT" }));
	assert.match(currentPrompt(fresh), /^INTENTIONAL REPLACEMENT/);
	assert.match(currentPrompt(fresh), /SELECTED SKILL BODY/);
	assert.doesNotMatch(JSON.stringify(fresh.captures), /PARENT TASK|PARENT ANSWER|PROJECT POLICY|safe-skill catalog sentinel/);
	const disabledFork = await run(await make({ sessionFile: parent.sm.createBranchedSession(parent.sm.getLeafId()), inherited: false }));
	assert.doesNotMatch(currentPrompt(disabledFork), /PROJECT POLICY|safe-skill catalog sentinel/);
	assert.match(JSON.stringify(wire(disabledFork)), /PROJECT POLICY/, "inheritance flags do not scrub existing history");
	for (const [label, instance] of Object.entries({ baseline, fork, fresh, disabledFork })) save(label, instance);
});

test("default children filter all parent orchestration tool names without rewriting raw history", async () => {
	const parent = await run(await make({ child: false }));
	for (const name of toolNames) {
		parent.sm.appendMessage({ ...ai.fauxAssistantMessage([ai.fauxToolCall(name, {}, { id: `call_${name}|fc_${name}` })], { stopReason: "toolUse" }),
			provider: parent.model.provider, model: parent.model.id, api: parent.model.api });
		parent.sm.appendMessage({ role: "toolResult", toolName: name, toolCallId: `call_${name}|fc_${name}`, content: [{ type: "text", text: `${name} inherited result` }], isError: false, timestamp: Date.now() });
	}
	parent.sm.appendCustomMessageEntry("subagent-orchestration-instructions", "PARENT ONLY MESSAGE", false);
	const forkFile = parent.sm.createBranchedSession(parent.sm.getLeafId());
	const raw = fs.readFileSync(forkFile, "utf8");
	const fork = await run(await make({ sessionFile: forkFile }));
	assert.doesNotMatch(JSON.stringify(wire(fork)), /inherited result|PARENT ONLY MESSAGE|call_subagent|call_delegate|call_agent_runs/);
	assert.notDeepEqual(wire(fork)[0], wire(parent)[0], "a filtered fork has a different provider prefix");
	assert.ok(fs.readFileSync(forkFile, "utf8").startsWith(raw));
	assert.match(fs.readFileSync(forkFile, "utf8"), /PARENT ONLY MESSAGE/);
	save("filtered-fork", fork);
});

test("authorized fanout children retain their own nested calls and results through native resume", async () => {
	const calls = toolNames.map((name) => ai.fauxToolCall(name, {}, { id: `own_${name}|fc_own_${name}` }));
	const child = await run(await make({ fanout: true, script: [ai.fauxAssistantMessage(calls, { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")] }));
	assert.match(currentPrompt(child), /explicit fanout responsibility/);
	assert.doesNotMatch(currentPrompt(child), /Do not propose or run subagents/);
	for (const name of toolNames) assert.match(JSON.stringify(wire(child, 1)), new RegExp(`${name} nested result`));
	const file = child.sm.getSessionFile();
	const raw = fs.readFileSync(file, "utf8");
	const resumed = await run(await make({ fanout: true, sessionFile: file }));
	for (const name of toolNames) {
		assert.ok(wire(resumed).some((item) => item.type === "function_call" && item.call_id === `own_${name}`));
		assert.ok(wire(resumed).some((item) => item.type === "function_call_output" && item.call_id === `own_${name}` && item.output.includes(`${name} nested result`)));
	}
	assert.ok(fs.readFileSync(file, "utf8").startsWith(raw));
	save("fanout-resume", resumed);
});

test("opaque full writers before and after child sections keep provider-visible instructions", async () => {
	for (const fullAfter of [false, true]) {
		const child = await run(await make({ full: true, fullAfter }));
		assert.match(currentPrompt(child), /OPAQUE FULL OVERRIDE/);
		assert.match(currentPrompt(child), /PROJECT POLICY/);
		assert.match(currentPrompt(child), /SELECTED SKILL BODY/);
		assert.ok(currentPrompt(child).includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(!currentPrompt(child).includes(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
		save(`full-${fullAfter ? "after" : "before"}`, child);
	}
});

test("intercom uses a stable provider-visible section and preserves earlier opaque overrides", async () => {
	const { IntercomClient } = await import("../../src/pi-intercom/broker/client.ts");
	const broker = spawn(process.execPath, [path.join(repo, "src/pi-intercom/broker/broker.ts")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	let log = "";
	broker.stdout.on("data", (chunk) => { log += chunk; });
	broker.stderr.on("data", (chunk) => { log += chunk; });
	const client = new IntercomClient();
	try {
		const deadline = Date.now() + 5_000;
		while (!log.includes("Intercom broker started")) { assert.ok(Date.now() < deadline, log); await sleep(10); }
		await client.connect({ name: "prompt-peer", cwd: root, model: "fixture" });
		for (const full of [false, true]) {
			const instance = await make({ child: false, peer: true, full });
			const brokerId = `pi-${createHash("sha256").update(instance.session.sessionId).digest("hex").slice(0, 32)}`;
			const connectedBy = Date.now() + 5_000;
			while (!(await client.listSessions()).some((peer) => peer.id === brokerId)) {
				assert.ok(Date.now() < connectedBy, "native intercom registration");
				await sleep(10);
			}
			await run(instance);
			assert.match(currentPrompt(instance), /<intercom_peers>\nOther Pi sessions may be connected/);
			assert.equal(currentPrompt(instance).includes("OPAQUE FULL OVERRIDE"), full);
			assert.doesNotMatch(currentPrompt(instance), /prompt-peer/);
			instance.faux.appendResponses([(context) => { instance.captures.push(structuredClone(context)); return ai.fauxAssistantMessage("done"); }]);
			await run(instance, "SECOND TURN");
			assert.equal(currentPrompt(instance, 1), currentPrompt(instance));
			save(`intercom-${full ? "opaque" : "sections"}`, instance);
		}
	} finally {
		await client.disconnect();
		for (const session of sessions) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		if (broker.exitCode === null) { const exited = once(broker, "exit"); broker.kill("SIGTERM"); await exited; }
	}
});
