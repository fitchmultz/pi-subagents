import * as fs from "node:fs";
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
	const receipt = { pid: process.pid, calls: 0, networkRequests: 0, errors: [], tools: [], sampling: [] };
	const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt));
	globalThis.fetch = async () => { receipt.networkRequests++; save(); throw new Error("Network forbidden in driver fixture"); };
	const faux = fauxProvider({ provider: "driver-fixture", tokensPerSecond: 1_000_000, tokenSize: { min: 1024, max: 1024 } });
	const textReport = (value) => `Initial answer\n\n\`\`\`acceptance-report\n${JSON.stringify(value)}\n\`\`\``;
	const submit = (value, id) => fauxAssistantMessage(fauxToolCall("structured_output", { value: { answer: "Reviewed answer", report: value } }, { id }), { stopReason: "toolUse" });
	const rejected = { ...report, criteriaSatisfied: [{ id: "deliver", status: "not-satisfied", evidence: "missing proof" }] };
	const blocked = { ...report, criteriaSatisfied: [{ id: "deliver", status: "blocked", evidence: "Native sign-in requests Touch ID", humanAction: "Complete Touch ID" }] };
	const responses = [
		scenario === "public-output" ? fauxAssistantMessage(fauxToolCall("structured_output", { value: { items: ["public payload"] } }), { stopReason: "toolUse" })
			: fauxAssistantMessage(textReport(scenario === "blocked" ? blocked : report)),
		scenario === "repair" ? submit(rejected, "rejected") : scenario === "stale" ? fauxAssistantMessage("Forgot to submit current report") : submit(report, "reviewed"),
		scenario === "stale-after-report" ? fauxAssistantMessage("Later activity without a current report") : submit(report, "repaired"),
	];
	faux.setResponses(responses.map((response, index) => async (context) => {
		receipt.calls++;
		const tools = context.tools ?? getCurrentTools(context.messages);
		receipt.tools.push(tools.map((tool) => tool.name));
		receipt.sampling.push(tools.find((tool) => tool.name === "structured_output")?.constrainedSampling);
		save();
		if (index === 1 && scenario === "stale-after-report") pi.sendMessage({ customType: "fixture", content: "Acknowledge this later request.", display: false }, { deliverAs: "steer" });
		if (index === 1 && scenario === "passive") pi.sendMessage({ customType: "fixture", content: "Passive context.", display: false }, { triggerTurn: false });
		if (scenario === "slow") await delay(1000);
		if (scenario === "per-attempt-time") await delay(180);
		return response;
	}));
	pi.registerProvider("driver-fixture", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture", models: faux.models, streamSimple: faux.provider.streamSimple });
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		return { message: { ...event.message, usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 5, cacheWrite1h: 2, reasoning: 4,
			totalTokens: 26, cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } } } };
	});
	pi.on("session_shutdown", () => { save(); if (scenario === "process-error") process.exitCode = 7; });
}
