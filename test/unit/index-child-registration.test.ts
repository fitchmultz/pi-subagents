import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function parentToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	delete env[SUBAGENT_FANOUT_CHILD_ENV];
	env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), `pi-subagent-index-probe-${process.pid}`);
	return env;
}

function runProbe(script: string, options: { env?: NodeJS.ProcessEnv } = {}): void {
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			String.raw`${script}`,
		],
		{ cwd: projectRoot, stdio: "pipe", ...options },
	);
}

describe("subagent extension child mode", () => {
	it("preserves tool output expansion before direct subagent tool execution", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await import("./src/extension/index.ts");
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			if (!registeredTool.promptSnippet?.includes("Delegate bounded work")) throw new Error("missing parent promptSnippet");
			const parentGuidelines = registeredTool.promptGuidelines ?? [];
			if (!parentGuidelines.some((line) => line.includes("action: \"list\""))) throw new Error("missing list-before-execute guideline");
			if (!parentGuidelines.some((line) => line.includes("parent session responsible"))) throw new Error("missing parent-owns-final-decision guideline");
			if (!parentGuidelines.some((line) => line.includes("review-only tasks") && line.includes("omit acceptance"))) throw new Error("missing lightweight-review guideline");
			if (!parentGuidelines.some((line) => line.includes("end the turn") && line.includes("completion wakes the parent"))) throw new Error("missing async no-poll guideline");
			if (!parentGuidelines.some((line) => line.includes("incomplete active Pi goal") && line.includes("async:false") && line.includes("do not end the turn"))) throw new Error("missing active-goal foreground exception guideline");
			if (!parentGuidelines.some((line) => line.includes("non-blocking steer") && line.includes("supplements the active task"))) throw new Error("missing steer-first nudge guideline");
			const calls = [];
			let expanded = false;
			const ctx = {
				cwd: process.cwd(),
				hasUI: true,
				ui: {
					getToolsExpanded() { return expanded; },
					setToolsExpanded(value) { expanded = value; calls.push(value); },
					setWidget() {},
					requestRender() {},
					theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } },
				},
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			await registeredTool.execute("already-collapsed", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (calls.length !== 0) throw new Error("unexpected setToolsExpanded call: " + JSON.stringify(calls));
			expanded = true;
			await registeredTool.execute("expanded", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (calls.length !== 0) throw new Error("unexpected setToolsExpanded call: " + JSON.stringify(calls));
			if (!expanded) throw new Error("tool output expansion was not preserved");
		`;

		runProbe(script, { env: parentToolEnv() });
	});

	it("renders the effective async default and foreground escapes", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await import("./src/extension/index.ts");
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
			const defaultSingle = registeredTool.renderCall({ agent: "worker" }, theme).text;
			const defaultParallel = registeredTool.renderCall({ tasks: [{ agent: "worker", task: "a" }, { agent: "reviewer", task: "b" }] }, theme).text;
			const explicitForeground = registeredTool.renderCall({ agent: "worker", async: false }, theme).text;
			const timeoutForeground = registeredTool.renderCall({ agent: "worker", timeoutMs: 1000 }, theme).text;
			const clarifyChain = registeredTool.renderCall({ chain: [{ agent: "worker" }, { agent: "reviewer" }], clarify: true }, theme).text;
			if (!defaultSingle.includes("[async]")) throw new Error("expected default async single badge, got " + defaultSingle);
			if (!defaultParallel.includes("[async]")) throw new Error("expected default async parallel badge, got " + defaultParallel);
			if (explicitForeground.includes("[async]")) throw new Error("unexpected explicit foreground async badge: " + explicitForeground);
			if (timeoutForeground.includes("[async]")) throw new Error("unexpected timeout foreground async badge: " + timeoutForeground);
			if (clarifyChain.includes("[async]")) throw new Error("unexpected clarify async badge: " + clarifyChain);
		`;

		runProbe(script, { env: parentToolEnv() });
	});

	it("returns before registering anything for non-fanout children", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await import("./src/extension/index.ts");
			const { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } = await import("./src/runs/shared/pi-args.ts");
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
			const calls = [];
			const fakePi = new Proxy({}, {
				get(_target, prop) {
					return (..._args) => {
						calls.push(String(prop));
						return undefined;
					};
				},
			});
			registerSubagentExtension(fakePi);
			if (calls.length > 0) {
				throw new Error("Unexpected child-mode registrations: " + calls.join(", "));
			}
		`;

		runProbe(script);
	});

	it("returns before registering anything for fanout children", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await import("./src/extension/index.ts");
			const { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } = await import("./src/runs/shared/pi-args.ts");
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
			const calls = [];
			const fakePi = new Proxy({}, {
				get(_target, prop) {
					return (..._args) => {
						calls.push(String(prop));
						return undefined;
					};
				},
			});
			registerSubagentExtension(fakePi);
			if (calls.length > 0) {
				throw new Error("Unexpected child-mode registrations: " + calls.join(", "));
			}
		`;

		runProbe(script);
	});

	it("lets fanout children call read-only list but blocks mutating management actions", () => {
		const script = String.raw`
			const { default: registerFanoutChildSubagentExtension } = await import("./src/extension/fanout-child.ts");
			const { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } = await import("./src/runs/shared/pi-args.ts");
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
			let registeredTool;
			const fakePi = {
				events: { on() { return () => {}; }, emit() {} },
				registerTool(tool) { registeredTool = tool; },
				on() {},
				getSessionName() { return undefined; },
			};
			registerFanoutChildSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			if (!(registeredTool.promptGuidelines ?? []).some((line) => line.includes("Nested execution defaults to foreground") && line.includes("async:false") && line.includes("async:true"))) throw new Error("missing nested foreground-default guideline");
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			const list = await registeredTool.execute("list-check", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (list.isError) throw new Error("list should be allowed: " + JSON.stringify(list.content));
			let createError;
			try {
				await registeredTool.execute("create-check", { action: "create", config: { name: "x" } }, new AbortController().signal, undefined, ctx);
			} catch (error) {
				createError = error;
			}
			const text = createError instanceof Error ? createError.message : "";
			if (!text.includes("not available from child-safe subagent fanout mode")) throw new Error("unexpected create error: " + text);
		`;

		runProbe(script, { env: parentToolEnv() });
	});
});
