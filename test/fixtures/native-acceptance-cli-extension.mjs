import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const sdkEntry = pathToFileURL(path.join(process.env.PI_INTERCOM_TEST_SDK, "dist/index.js"));
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);

export default function (pi) {
	const input = process.env.PI_FINAL_REPORT_CLI_INPUT;
	const { scenario, report, initialReport } = JSON.parse(fs.readFileSync(input, "utf8"));
	const capturePath = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	const finalizing = Boolean(capturePath);
	const receiptPath = path.join(path.dirname(input), `${finalizing ? "final" : "initial"}-${process.pid}.json`);
	const receipt = { pid: process.pid, cli: fs.realpathSync(process.argv[1]), argv: process.argv, finalizing, scenario,
		providerCalls: 0, networkRequests: 0, events: [], shutdownStarted: false, shutdownFinished: false };
	const faux = fauxProvider({ provider: "report-cli-fixture", tokensPerSecond: 1_000_000, tokenSize: { min: 1024, max: 1024 } });
	const save = () => {
		receipt.providerCalls = faux.state.callCount;
		if (capturePath && fs.existsSync(capturePath)) receipt.capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
		fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
	};
	globalThis.fetch = async () => { receipt.networkRequests++; save(); throw new Error("Network forbidden in native CLI fixture"); };
	const success = finalizing
		? fauxAssistantMessage(fauxToolCall("structured_output", { value: { report } }, { id: `report-${process.pid}` }), { stopReason: "toolUse" })
		: fauxAssistantMessage(initialReport);
	faux.setResponses([
		...(finalizing && scenario === "retry" ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded; native CLI fixture" })] : []),
		() => {
			if (finalizing && scenario === "final-error") pi.sendMessage({ customType: "fixture", content: "Continue with the final failing request.", display: false }, { deliverAs: "steer" });
			return success;
		},
		...(finalizing && scenario === "final-error" ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "Fixture final provider failure" })] : []),
	]);
	pi.registerProvider("report-cli-fixture", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	for (const type of ["message_end", "agent_settled"]) pi.on(type, (event) => { receipt.events.push(event); save(); });
	pi.on("session_shutdown", async () => {
		receipt.shutdownStarted = true;
		save();
		if (finalizing && scenario === "linger") await delay(2500);
		if (finalizing && scenario === "process-exit") process.exitCode = 7;
		receipt.shutdownFinished = true;
		save();
	});
	process.on("exit", (code) => { receipt.exitCode = code; save(); });
}
