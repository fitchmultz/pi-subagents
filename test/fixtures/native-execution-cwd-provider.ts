import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const script = JSON.parse(process.env.PI_CWD_FIXTURE_SCRIPT!) as Array<{ name: string; input: Record<string, unknown> }>;
	const faux = fauxProvider();
	faux.setResponses([
		...script.map(({ name, input }) => fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" })),
		fauxAssistantMessage("done"),
	]);
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture", models: faux.models, streamSimple: faux.provider.streamSimple });
	const results: unknown[] = [];
	pi.on("tool_result", (event) => { results.push({ name: event.toolName, content: event.content, isError: event.isError }); });
	pi.on("session_shutdown", (_event, ctx) => {
		writeFileSync(process.env.PI_CWD_FIXTURE_OUTPUT!, JSON.stringify({ calls: faux.state.callCount, results, cwd: ctx.cwd,
			id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), entries: ctx.sessionManager.getEntries(),
			tools: pi.getAllTools(), commands: pi.getCommands() }));
	});
}
