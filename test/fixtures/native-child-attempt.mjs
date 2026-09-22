import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const sdkEntry = pathToFileURL(path.join(process.env.PI_INTERCOM_TEST_SDK, "dist/index.js"));
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);

export default function (pi) {
	const config = JSON.parse(fs.readFileSync(process.env.PI_DRIVER_FIXTURE, "utf8"));
	const { scenario, receiptPath, report } = config;
	const repairStaged = scenario === "staged-repair" || scenario === "staged-repair-restage";
	const receipt = { pid: process.pid, calls: 0, networkRequests: 0, errors: [], tools: [], sampling: [], shutdownStarted: false, shutdownFinished: false, events: [] };
	const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt));
	pi.on("session_start", (_event, ctx) => {
		const marker = path.join(path.dirname(receiptPath), "startup-exit");
		if (config.startupExit && (!config.startupExit.model || config.startupExit.model === ctx.model?.id)
			&& (!config.startupExit.once || !fs.existsSync(marker))) {
			fs.writeFileSync(marker, String(process.pid));
			if (config.startupExit.stderr) fs.writeSync(2, config.startupExit.stderr);
			save();
			process.exit(config.startupExit.code);
		}
	});
	globalThis.fetch = async () => { receipt.networkRequests++; save(); throw new Error("Network forbidden in driver fixture"); };
	const faux = fauxProvider({ provider: "driver-fixture", models: [{ id: "faux-1" }, { id: "faux-2" }], tokensPerSecond: 1_000_000, tokenSize: { min: 1024, max: 1024 } });
	const textReport = (value) => `Initial answer\n\n\`\`\`acceptance-report\n${JSON.stringify(value)}\n\`\`\``;
	const submit = (value, id, answer = "Reviewed answer") => fauxAssistantMessage(fauxToolCall("structured_output", { value: { answer, report: value } }, { id }), { stopReason: "toolUse" });
	const rejected = { ...report, criteriaSatisfied: [{ id: "deliver", status: "not-satisfied", evidence: "missing proof" }] };
	const blocked = { ...report, criteriaSatisfied: [{ id: "deliver", status: "blocked", evidence: "Native sign-in requests Touch ID", humanAction: "Complete Touch ID" }] };
	const responses = [
		scenario === "public-output" ? fauxAssistantMessage(fauxToolCall("structured_output", { value: { items: config.items ?? ["public payload"] } }), { stopReason: "toolUse" })
			: fauxAssistantMessage(textReport(scenario === "blocked" ? blocked : report)),
		scenario === "repair" ? submit(rejected, "rejected") : ["stale", "missing-then-repair"].includes(scenario) ? fauxAssistantMessage("Forgot to submit current report")
			: scenario === "retry" ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded; native fixture" }) : submit(report, "reviewed"),
		repairStaged ? fauxAssistantMessage(fauxToolCall("bash", { command: "git rm --cached -- staged.txt" }), { stopReason: "toolUse" })
			: scenario === "stale-after-report" ? fauxAssistantMessage("Later activity without a current report")
			: scenario === "final-error" ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Fixture final provider failure" }) : submit(report, "repaired"),
		...(repairStaged ? [submit(report, "unstaged", "Repaired answer")] : []),
	];
	if (scenario === "question-initial") responses.unshift(fauxAssistantMessage(fauxToolCall("contact_supervisor", { reason: "need_decision", message: "Choose before initial work" }), { stopReason: "toolUse" }));
	if (scenario === "question-review") responses.splice(1, 0, fauxAssistantMessage(fauxToolCall("contact_supervisor", { reason: "need_decision", message: "Choose during review" }), { stopReason: "toolUse" }));
	faux.setResponses(responses.map((response, index) => async (context) => {
		receipt.calls++;
		const tools = context.tools ?? getCurrentTools(context.messages);
		receipt.tools.push(tools.map((tool) => tool.name));
		receipt.sampling.push(tools.find((tool) => tool.name === "structured_output")?.constrainedSampling);
		if (repairStaged && index === 2) receipt.sawStagedFailure = JSON.stringify(context.messages).includes("Staged files present:");
		save();
		if (index === 1 && ["stale-after-report", "resubmit", "final-error"].includes(scenario)) pi.sendMessage({ customType: "fixture", content: "Acknowledge this later request.", display: false }, { deliverAs: "steer" });
		if (index === 1 && scenario === "passive") pi.sendMessage({ customType: "fixture", content: "Passive context.", display: false }, { triggerTurn: false });
		if (scenario === "slow") await delay(1000);
		if (scenario === "per-attempt-time") await delay(2000);
		return response;
	}));
	pi.registerProvider("driver-fixture", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture", models: faux.models, streamSimple: faux.provider.streamSimple });
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (event.message.errorMessage) { receipt.errors.push(event.message.errorMessage); save(); }
		return { message: { ...event.message, usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 5, cacheWrite1h: 2, reasoning: 4,
			totalTokens: 26, cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } } } };
	});
	pi.on("agent_settled", (event) => { receipt.events.push(event); save(); });
	pi.on("session_shutdown", async () => {
		receipt.shutdownStarted = true; save();
		if (scenario === "linger") await delay(3000);
		if (scenario === "process-error") process.exitCode = 7;
		if (scenario === "staged-repair-restage") execFileSync("git", ["add", "staged.txt"], { cwd: path.dirname(receiptPath) });
		receipt.shutdownFinished = true; save();
	});
}
