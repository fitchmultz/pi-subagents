import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Contract fixture; PI_CWD_TEST_OWNER can replace it with the real directory extension.
export default function (pi: ExtensionAPI) {
	let context: ExtensionContext | undefined;
	let cwd: string;
	const initialize = (ctx: ExtensionContext) => {
		if (context?.sessionManager === ctx.sessionManager) return;
		context = ctx;
		const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "change-working-dir");
		cwd = (entry?.type === "custom" ? (entry.data as { dir?: string }).dir : undefined) ?? ctx.cwd;
	};
	const change = (value: string, ctx: ExtensionContext) => {
		initialize(ctx);
		cwd = resolve(cwd, value);
		pi.appendEntry("change-working-dir", { dir: cwd === ctx.cwd ? undefined : cwd });
		return cwd;
	};
	pi.on("session_start", (_event, ctx) => initialize(ctx));
	pi.on("before_agent_start", (event, ctx) => {
		initialize(ctx);
		event.systemPromptOptions.cwd = cwd;
	});
	pi.on("tool_call", (event) => {
		if (event.toolName === "read" && typeof event.input.path === "string") event.input.path = resolve(cwd, event.input.path);
	});
	for (const name of ["resolve", "set"]) pi.events.on(`pi-change-working-dir:${name}-execution-cwd`, (data) => {
		const request = data as { sessionManager: ExtensionContext["sessionManager"]; path: string; result?: { cwd: string; error?: string } };
		if (!context || request.sessionManager !== context.sessionManager) return;
		request.result = { cwd: name === "set" ? change(request.path, context) : cwd };
	});
	pi.registerCommand("cwd", { handler: async (value, ctx) => { change(value, ctx); } });
	pi.registerTool({ name: "change_dir", label: "Change Directory", description: "Fixture directory owner", parameters: Type.Object({ path: Type.String() }),
		executionMode: "sequential", execute: async (_id, { path }, _signal, _update, ctx) => ({ content: [{ type: "text", text: change(path, ctx) }], details: {} }) });
}
