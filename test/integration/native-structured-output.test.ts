import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../src/runs/shared/structured-output.ts";

const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)!);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(sdkEntry.href);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, getCurrentTools } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);

for (const explicit of [false, true]) test(`resumed structured output reaches the provider and captures its report (${explicit ? "explicit tools" : "saved tools"})`, async (t) => {
	const evidenceDir = process.env.PI_INTERCOM_TEST_EVIDENCE_DIR;
	if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
	const root = mkdtempSync(path.join(evidenceDir ?? tmpdir(), "native-structured-output-"));
	const previous = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
	Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1" });
	t.after(() => {
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		if (!evidenceDir) rmSync(root, { recursive: true, force: true });
	});
	const faux = fauxProvider({ provider: "structured-output-resume" });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loaderOptions = {
		cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	};
	const initialLoader = new DefaultResourceLoader(loaderOptions);
	await initialLoader.reload();
	const { session: initial } = await createAgentSession({
		cwd: root, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: initialLoader,
		sessionManager: SessionManager.create(root, path.join(root, "sessions")), tools: ["read"],
	});
	faux.setResponses([fauxAssistantMessage("Initial work finished")]);
	await initial.prompt("Perform initial work");
	const sessionFile = initial.sessionManager.getSessionFile();
	initial.dispose();

	const output = path.join(root, "report.json");
	process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = output;
	process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = path.join(root, "schema.json");
	writeFileSync(process.env[STRUCTURED_OUTPUT_SCHEMA_ENV], JSON.stringify({ type: "object", properties: { report: { type: "string" } }, required: ["report"] }));
	const loader = new DefaultResourceLoader({ ...loaderOptions, additionalExtensionPaths: [process.env.PI_STRUCTURED_OUTPUT_TEST_EXTENSION ?? path.resolve("src/runs/shared/subagent-prompt-runtime.ts")] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: root, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.open(sessionFile), ...(explicit ? { tools: ["read", "structured_output"] } : {}),
	});
	t.after(async () => { await session.abort(); session.dispose(); });
	const restoredTools = session.getActiveToolNames();
	t.diagnostic(`Native restored tools before extension startup: ${restoredTools.join(", ")}`);
	await session.bindExtensions({ mode: "print" });
	let providerTools: string[] = [];
	faux.setResponses([(context: { tools?: Array<{ name: string }>; messages: unknown[] }) => {
		providerTools = (context.tools ?? getCurrentTools(context.messages)).map((tool: { name: string }) => tool.name);
		return fauxAssistantMessage(fauxToolCall("structured_output", { value: { report: "Verified final report" } }), { stopReason: "toolUse" });
	}, fauxAssistantMessage("Done")]);
	await session.prompt("Submit the final report");
	assert.ok(providerTools.includes("structured_output"), "resumed provider request must advertise structured_output");
	assert.ok(providerTools.includes("read"), "existing tool selection survives");
	assert.deepEqual(providerTools.sort(), [...new Set([...restoredTools, "structured_output"])].sort(), "startup activation must preserve the host's restored selection without enabling unrelated tools");
	if (explicit) assert.deepEqual(providerTools, ["read", "structured_output"]);
	assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { report: "Verified final report" });
});
