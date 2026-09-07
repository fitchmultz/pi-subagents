import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

// The existing mock CLI chooses the leaf response; finalization itself runs in the real SDK.
export async function runNativeReport(args, fixture) {
	const sdkRoot = process.env.PI_INTERCOM_TEST_SDK;
	assert.ok(sdkRoot, "PI_INTERCOM_TEST_SDK must select the native SDK for this fixture");
	const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
	const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(path.join(sdkRoot, "dist/index.js"))));
	const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
	const cwd = process.cwd(), agentDir = sdk.getAgentDir();
	const { scenario, report, laterReport = report } = fixture;
	const valueAfter = (flag) => args[args.indexOf(flag) + 1];
	const schemaPath = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
	const capturePath = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	const receipt = { scenario, sdkRoot, schema: schemaPath ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : undefined,
		providerCalls: 0, networkRequests: 0, extensionErrors: [], events: [], messages: [] };
	const save = () => fs.writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
	globalThis.fetch = async () => { receipt.networkRequests++; save(); throw new Error("Network forbidden in native report fixture"); };
	const faux = ai.fauxProvider({ provider: "report-fixture", tokensPerSecond: 1_000_000, tokenSize: { min: 1024, max: 1024 } });
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let workCalls = 0;
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		systemPrompt: "Synthetic report-boundary fixture; no external work.",
		additionalExtensionPaths: args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1]] : []),
		extensionFactories: [(pi) => pi.registerTool({
			name: "fixture_work", label: "Fixture work", description: "Change only fixture-owned state",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async execute() {
				workCalls++;
				fs.writeFileSync(fixture.handoffPath ?? path.join(cwd, "work.txt"), fixture.handoff ?? "Work performed after the report");
				if (scenario.endsWith("failed-work") || (scenario === "repair" && workCalls === 1)) throw new Error("Fixture validation failed after the report");
				return { content: [{ type: "text", text: "Fixture work finished" }], details: {}, terminate: ["mixed", "different-work"].includes(scenario) };
			},
		})],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, modelRuntime,
		model: faux.getModel(), noTools: "builtin", tools: args.includes("--tools") ? valueAfter("--tools").split(",") : undefined,
		sessionManager: sdk.SessionManager.open(valueAfter("--session"), undefined, cwd) });
	await session.bindExtensions({ mode: "json", onError: (error) => receipt.extensionErrors.push(error) });
	receipt.sessionFile = session.sessionFile;
	const structured = session.agent.state.tools.some((tool) => tool.name === "structured_output");
	const submit = (value, id) => structured
		? ai.fauxAssistantMessage(ai.fauxToolCall("structured_output", { value: { report: value } }, { id }), { stopReason: "toolUse" })
		: ai.fauxAssistantMessage(value);
	const work = () => ai.fauxAssistantMessage(ai.fauxToolCall("fixture_work", {}), { stopReason: "toolUse" });
	const plain = ai.fauxAssistantMessage("Coordination acknowledged; no new task report.");
	const first = Promise.withResolvers(), release = Promise.withResolvers();
	const initial = scenario === "unsubmitted" ? ai.fauxAssistantMessage(report) : scenario === "child-file" ? work() : submit(report, "first-report");
	const tails = {
		resubmit: [submit(laterReport, "current-report")],
		"not-satisfied": [submit(laterReport, "current-report")],
		"child-file": [submit(report, "current-report")],
		"failed-work": [work(), plain],
		repair: [work(), work(), submit(report, "current-report")],
		"user-failed-work": [work(), plain],
		"different-work": [work()],
		"malformed-work": [ai.fauxAssistantMessage("```acceptance-report\n{malformed\n```")],
		"malformed-submission": [submit("```acceptance-report\n{malformed\n```", "malformed-report")],
		"invalid-tool-submission": [ai.fauxAssistantMessage(ai.fauxToolCall("structured_output", { value: { report: { invalid: true } } }), { stopReason: "toolUse" }), plain],
		"invalid-submission": [ai.fauxAssistantMessage(ai.fauxToolCall("structured_output", { value: { report: 42 } }), { stopReason: "toolUse" }), plain],
		mixed: [ai.fauxAssistantMessage([ai.fauxToolCall("structured_output", { value: { report: laterReport } }), ai.fauxToolCall("fixture_work", {})], { stopReason: "toolUse" })],
		error: [ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "Fixture provider failed after the report" })],
		"native-abort": [ai.fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Fixture native cancellation" })],
		cancel: [async () => {
			receipt.waiting = true;
			receipt.providerCalls = faux.state.callCount;
			save();
			await new Promise((resolve) => setTimeout(resolve, 30_000));
			return plain;
		}],
	};
	faux.setResponses([async () => { first.resolve(); await release.promise; return initial; }, ...(tails[scenario] ?? [plain])]);
	session.subscribe((event) => {
		if (event.type === "message_end") receipt.messages.push(event.message);
		if (["message_end", "tool_execution_start", "tool_execution_end", "agent_settled"].includes(event.type)) {
			receipt.events.push({ type: event.type, role: event.message?.role, toolName: event.toolName, isError: event.isError });
			receipt.providerCalls = faux.state.callCount;
			save();
			if (scenario === "missing-result" && event.message?.role === "toolResult" && event.message.toolName === "structured_output") return;
			const wireEvent = scenario === "wrong-result-id" && event.message?.role === "toolResult"
				? { ...event, message: { ...event.message, toolCallId: "unrelated-call" } } : event;
			process.stdout.write(`${JSON.stringify(wireEvent)}\n`);
		}
	});
	const rawTask = args.at(-1);
	const task = rawTask.startsWith("@") ? fs.readFileSync(rawTask.slice(1), "utf8") : rawTask;
	const pending = session.prompt(task);
	try {
		await first.promise;
		if (scenario === "user-failed-work") await session.steer("New task instruction: run another fixture validation.");
		else if (!["single", "unsubmitted", "child-file", "capture-mismatch", "missing-result", "missing-capture", "wrong-result-id", "invalid-capture"].includes(scenario)) {
			await session.sendCustomMessage({ customType: "intercom_message", content: scenario.endsWith("failed-work") ? "New task instruction: run another fixture validation." : "Additive coordination: acknowledge an overlap.", display: true },
				scenario === "passive" ? { triggerTurn: false } : { deliverAs: scenario === "follow-up" ? "followUp" : "steer" });
		}
		release.resolve();
		await pending;
		await session.waitForIdle();
		if (capturePath && scenario === "capture-mismatch") fs.writeFileSync(capturePath, JSON.stringify({ report: laterReport }));
		if (capturePath && scenario === "missing-capture") fs.rmSync(capturePath, { force: true });
		if (capturePath && scenario === "invalid-capture") fs.writeFileSync(capturePath, JSON.stringify({ report: false }));
		receipt.capture = capturePath && fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, "utf8")) : undefined;
		assert.deepEqual(receipt.extensionErrors, []);
		assert.equal(receipt.networkRequests, 0);
	} finally {
		release.resolve();
		await session.abort();
		session.dispose();
		receipt.providerCalls = faux.state.callCount;
		save();
	}
}
