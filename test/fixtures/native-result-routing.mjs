// Real native parents, owning async runner/watcher and intercom relay; only child transport is controlled.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [root, repo, sdkRoot, phase] = process.argv.slice(2);
const cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), callsDir = path.join(root, "calls");
for (const dir of [cwd, agentDir, callsDir, path.join(cwd, ".pi/agents"), path.join(root, "bin")]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, { HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"), PI_OFFLINE: "1", OWNERSHIP_SDK_ROOT: sdkRoot, OWNERSHIP_PROBE_DIR: callsDir, OWNERSHIP_REPO: repo });
fs.writeFileSync(path.join(root, "bin/pi"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-ownership-cli.mjs")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`;
fs.writeFileSync(path.join(cwd, ".pi/agents/probe.md"), "---\nname: probe\ndescription: Native result delivery probe\nmodel: openai/gpt-6-astra\nextensions:\ninheritProjectContext: false\ninheritSkills: false\n---\nReturn the controlled native-session result.\n");
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const { IntercomClient } = await import(pathToFileURL(path.join(repo, "dist/pi-intercom/broker/client.js")).href);
const { resolveOrchestratorIntercomTarget } = await import(pathToFileURL(path.join(repo, "dist/intercom/intercom-bridge.js")).href);
const { RESULTS_DIR } = await import(pathToFileURL(path.join(repo, "dist/shared/types.js")).href);
const { getRunMetadataDir } = await import(pathToFileURL(path.join(repo, "dist/runs/shared/supervisor-questions.js")).href);
const seed = phase === "seed" ? undefined : JSON.parse(fs.readFileSync(path.join(root, "seed-evidence.json"), "utf8"));
const evidence = { phase, pid: process.pid, nativeProviderRequests: 0, stoppedNativeTurns: 0, checks: [], failures: [], events: [], extensionErrors: [] };
const verify = (name, run) => { try { run(); evidence.checks.push(name); } catch (error) { evidence.failures.push(`${name}: ${error.stack ?? error}`); } };
const wait = async (predicate, label) => {
	const deadline = Date.now() + 20_000;
	while (!predicate()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await sleep(20); }
};
const bus = sdk.createEventBus();
for (const channel of ["subagent:intercom-identity-request", "subagent:intercom-identity-response", "subagent:result-intercom", "subagent:result-intercom-delivery", "subagent:async-complete"]) bus.on(channel, (payload) => evidence.events.push({ channel, payload }));
const events = (channel) => evidence.events.filter((event) => event.channel === channel).map((event) => event.payload);
const resultPath = (run) => path.join(RESULTS_DIR, `${run.id}.json`);
const calls = () => fs.readdirSync(callsDir).filter((name) => name.startsWith("call-")).map((name) => JSON.parse(fs.readFileSync(path.join(callsDir, name), "utf8")));
let session, reservation;
const invoke = (name, args) => session.agent.state.tools.find((tool) => tool.name === name).execute(randomUUID(), args, new AbortController().signal);
const visible = (run) => session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && ["intercom_message", "subagent-notify"].includes(entry.customType) && String(entry.content).includes(run.output));
const completed = (run) => events("subagent:async-complete").filter((event) => event.runId === run.id);
const errorsFor = (run) => session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "intercom_result_error" && entry.data.message.includes(run.output));
const release = (run) => fs.writeFileSync(path.join(callsDir, `release_${run.name}`), "release");

async function open() {
	const sessionManager = phase === "seed" ? sdk.SessionManager.create(cwd, path.join(root, "sessions"))
		: phase === "foreign" ? sdk.SessionManager.forkFrom(seed.sessionFile, cwd, path.join(root, "forks"))
		: sdk.SessionManager.open(seed.sessionFile);
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	settingsManager.setProjectTrusted(true);
	const loader = new sdk.DefaultResourceLoader({
		cwd, agentDir, settingsManager, eventBus: bus,
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		additionalExtensionPaths: [path.join(repo, "dist/pi-intercom/index.js"), path.join(repo, "dist/extension/index.js")],
		extensionFactories: [(pi) => {
			pi.on("session_start", () => pi.setSessionName("native-result-owner"));
			pi.on("before_provider_request", () => { evidence.nativeProviderRequests++; throw new Error("This fixture must not invoke a provider."); });
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), refreshOnCreate: false });
	const model = modelRuntime.getModel("openai", "gpt-6-astra");
	assert.ok(model);
	({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager, modelRuntime, model }));
	// Stop the native turn after its message is really persisted, before a provider call.
	// Neither the watcher acknowledgment nor the visible message is fabricated.
	session.agent.subscribe((event, signal) => {
		if (event.type === "message_end" && event.message.role === "custom") {
			evidence.stoppedNativeTurns++;
			session.agent.abort();
			signal.throwIfAborted();
		}
	});
	if (phase === "seed") {
		// The real broker assigns a fresh runtime ID when the requested stable ID is occupied.
		// Release the reservation before restart so the same saved parent gets a different ID.
		reservation = new IntercomClient();
		evidence.reservedTarget = `pi-${createHash("sha256").update(sessionManager.getSessionId()).digest("hex").slice(0, 32)}`;
		await reservation.connect({ name: "fixture-reservation", cwd, model: "fixture" }, evidence.reservedTarget);
	}
	await session.bindExtensions({ mode: "json", onError: (error) => evidence.extensionErrors.push(error) });
	if (phase !== "fallback") await invoke("intercom", { action: "status" });
	evidence.sessionId = sessionManager.getSessionId();
	evidence.sessionFile = sessionManager.getSessionFile();
	evidence.intercomTarget = resolveOrchestratorIntercomTarget(bus, "");
	if (reservation) { await reservation.disconnect(); reservation = undefined; }
}

async function verifyResult(run, grouped) {
	await wait(() => completed(run).length === 1 && visible(run).length > 0 && session.isIdle, `${run.name} native delivery`);
	const terminal = JSON.parse(fs.readFileSync(path.join(getRunMetadataDir(run.id), "result.json"), "utf8"));
	const inspection = await invoke("agent_runs", { action: "inspect", id: run.id });
	(evidence.results ??= []).push({ name: run.name, terminal, inspection, visible: visible(run), errors: errorsFor(run) });
	verify(`${run.name}: original successful child and ownership survive restart`, () => {
		assert.equal(terminal.sessionId, seed.sessionFile);
		assert.equal(terminal.intercomTarget, seed.intercomTarget);
		assert.equal(terminal.results[0].success, true);
		assert.equal(terminal.results[0].exitCode, 0);
		assert.equal(terminal.results[0].output, run.output);
		const messages = sdk.SessionManager.open(terminal.results[0].sessionFile).getEntries();
		assert.ok(messages.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "text" && part.text === run.output)));
		assert.equal(inspection.details.run.state, "completed");
		assert.equal(inspection.details.run.children[0].result.finalOutput, run.output);
	});
	verify(`${run.name}: exactly one grouped or fallback result, never both`, () => {
		assert.equal(visible(run).length, 1);
		assert.equal(visible(run)[0].customType, completed(run)[0].intercomResultDelivered ? "intercom_message" : "subagent-notify");
		assert.equal(fs.existsSync(resultPath(run)), false);
	});
	if (grouped !== undefined) verify(`${run.name}: ${grouped ? "current owner gets grouped delivery" : "unavailable intercom keeps fallback and diagnosis"}`, () => {
		const payloads = events("subagent:result-intercom").filter((event) => event.runId === run.id);
		assert.equal(payloads.length, 1);
		assert.equal(completed(run)[0].intercomResultDelivered, grouped);
		assert.equal(payloads[0].to, grouped ? evidence.intercomTarget : seed.intercomTarget);
		const acks = events("subagent:result-intercom-delivery").filter((event) => event.requestId === payloads[0].requestId);
		assert.equal(acks.length, 1);
		assert.equal(acks[0].delivered, grouped);
		if (grouped) assert.deepEqual(errorsFor(run), []);
		else {
			assert.equal(errorsFor(run).length, 1);
			assert.equal(errorsFor(run)[0].data.to, seed.intercomTarget);
			assert.match(errorsFor(run)[0].data.error, /Failed to spawn intercom broker:.*ENOENT/);
		}
	});
}

try {
	await open();
	if (phase === "seed") {
		assert.ok(evidence.intercomTarget);
		assert.notEqual(evidence.intercomTarget, evidence.reservedTarget);
		await session.sendCustomMessage({ customType: "fixture-seed", content: "Saved native parent", display: false }, { triggerTurn: true });
		evidence.runs = [];
		for (const name of ["foreign", "repaired", "fallback"]) {
			const output = `NATIVE_DELIVERY_${name.toUpperCase()}`;
			const launch = await invoke("delegate", { agent: "probe", task: `WAIT_GATE:release_${name}\nWORKFLOW_RESPONSE:${JSON.stringify({ text: output })}`, async: true, output: false, context: "fresh" });
			assert.ok(launch.details.asyncId, JSON.stringify(launch));
			evidence.runs.push({ name, output, id: launch.details.asyncId, launch });
		}
		await wait(() => calls().length === 3, "three actual gated child launches");
		assert.ok(fs.existsSync(evidence.sessionFile));
		assert.equal(session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent-run").some((entry) => entry.data.ownerSessionId === evidence.sessionId), true);
		evidence.checks.push("native parent owns three running children before its process exits; old runtime identity is recorded at launch");
	} else if (phase === "foreign") {
		const run = seed.runs.find((run) => run.name === "foreign");
		const identityQueries = events("subagent:intercom-identity-request").length;
		release(run);
		await wait(() => fs.existsSync(resultPath(run)), "foreign owner's real result file");
		await sleep(350);
		verify("a native fork with the same cwd/name and copied receipts cannot adopt or retarget its parent's result", () => {
			assert.notEqual(evidence.sessionId, seed.sessionId);
			assert.notEqual(evidence.sessionFile, seed.sessionFile);
			assert.ok(session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.ownerSessionId === seed.sessionId));
			assert.equal(fs.existsSync(resultPath(run)), true);
			assert.equal(JSON.parse(fs.readFileSync(resultPath(run), "utf8")).sessionId, seed.sessionFile);
			assert.equal(events("subagent:intercom-identity-request").length, identityQueries);
			assert.deepEqual(events("subagent:result-intercom"), []);
			assert.deepEqual(events("subagent:async-complete"), []);
			assert.deepEqual(visible(run), []);
		});
		assert.deepEqual((await invoke("agent_runs", { action: "list" })).details.runs, []);
	} else {
		assert.notEqual(evidence.pid, seed.pid);
		assert.equal(evidence.sessionId, seed.sessionId);
		assert.equal(evidence.sessionFile, seed.sessionFile);
		const run = seed.runs.find((run) => run.name === phase);
		if (phase === "resume") {
			assert.ok(evidence.intercomTarget);
			assert.notEqual(evidence.intercomTarget, seed.intercomTarget);
			await verifyResult(seed.runs.find((run) => run.name === "foreign"));
			const repaired = seed.runs.find((run) => run.name === "repaired");
			release(repaired);
			await verifyResult(repaired, true);
		} else {
			assert.equal(evidence.intercomTarget, "");
			release(run);
			await verifyResult(run, false);
		}
		const visibleBefore = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		const completionsBefore = events("subagent:async-complete").length;
		await session.reload();
		await sleep(600);
		await session.waitForIdle();
		verify("native reload does not redeliver consumed results or lose the saved delivery diagnosis", () => {
			assert.deepEqual(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message"), visibleBefore);
			assert.equal(events("subagent:async-complete").length, completionsBefore);
			if (phase === "fallback") assert.equal(errorsFor(run).length, 1);
		});
	}
	assert.equal(evidence.nativeProviderRequests, 0);
	assert.deepEqual(evidence.extensionErrors, []);
} catch (error) {
	evidence.failures.push(error.stack ?? String(error));
} finally {
	if (reservation) await reservation.disconnect();
	if (session) {
		evidence.entries = session.sessionManager.getEntries();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await session.abort();
		session.dispose();
	}
	fs.writeFileSync(path.join(root, `${phase}-evidence.json`), JSON.stringify(evidence, null, 2));
	console.log(JSON.stringify({ phase, checks: evidence.checks, failures: evidence.failures, nativeProviderRequests: evidence.nativeProviderRequests }));
	if (evidence.failures.length) process.exitCode = 1;
}
