import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

const sdkEntry = pathToFileURL(path.join(process.env.PI_INTERCOM_TEST_SDK, "dist/index.js"));
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);

export default function (pi) {
	const input = process.env.PI_FINAL_REPORT_CLI_INPUT;
	const { pidDir } = JSON.parse(fs.readFileSync(input, "utf8"));
	const receiptPath = path.join(path.dirname(input), `initial-${process.pid}.json`);
	const receipt = { pid: process.pid, cli: fs.realpathSync(process.argv[1]), networkRequests: 0, events: [] };
	const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt));
	globalThis.fetch = async () => { receipt.networkRequests++; save(); throw new Error("Network forbidden in native CLI fixture"); };
	const faux = fauxProvider({ provider: "report-cli-fixture", tokensPerSecond: 1_000_000, tokenSize: { min: 1024, max: 1024 } });
	faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", {
		command: `printf '%s' "$$" > '${pidDir}/shell.pid'; sleep 30 & printf '%s' "$!" > '${pidDir}/descendant.pid'; printf ready > '${pidDir}/ready'; wait`,
	}), { stopReason: "toolUse" })]);
	pi.registerProvider("report-cli-fixture", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	for (const type of ["message_end", "agent_settled"]) pi.on(type, (event) => { receipt.events.push(event); save(); });
	process.on("exit", save);
}
