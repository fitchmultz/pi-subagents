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
	it("loads the full subagent tool on demand without losing guidance or output state", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await import("./src/extension/index.ts");
			const events = { on() { return () => {}; }, emit() {} };
			const registeredTools = new Map();
			const handlers = new Map();
			const activeSets = [];
			let activeTools = ["read", "load_subagent", "subagent"];
			const fakePi = new Proxy({
				events,
				registerTool(tool) { registeredTools.set(tool.name, tool); },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
				getActiveTools() { return [...activeTools]; },
				getAllTools() { return [...registeredTools.values()]; },
				setActiveTools(names) { activeTools = [...names]; activeSets.push([...names]); },
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			const registeredTool = registeredTools.get("subagent");
			const loader = registeredTools.get("load_subagent");
			if (!registeredTool) throw new Error("subagent tool not registered");
			if (!loader) throw new Error("subagent loader not registered");
			if (registeredTool.promptSnippet !== undefined) throw new Error("full tool promptSnippet should load lazily");
			if (registeredTool.promptGuidelines !== undefined) throw new Error("full tool promptGuidelines should load lazily");
			if (!loader.promptSnippet?.includes("subagent orchestration")) throw new Error("missing loader discovery snippet");
			const description = registeredTool.description;
			for (const builtinName of ["scout", "worker", "planner"]) {
				if (description.includes(builtinName)) throw new Error("description advertises hardcoded builtin: " + builtinName);
			}
			if (!description.includes('{ action: "list" }')) throw new Error("description is missing list discovery");
			if (!description.includes("executable/non-disabled")) throw new Error("description is missing executable guidance");
			if (!description.includes("output?,reads?,progress?")) throw new Error("description is missing parallel overrides");
			if (!description.includes("maxOutput") || !description.includes("bytes?: number, lines?: number")) throw new Error("description is missing maxOutput guidance");

			const sessionStartHandlers = handlers.get("session_start") ?? [];
			const sessionTreeHandlers = handlers.get("session_tree") ?? [];
			const sessionCompactHandlers = handlers.get("session_compact") ?? [];
			const resetHandler = sessionTreeHandlers.find((handler) => sessionStartHandlers.includes(handler) && sessionCompactHandlers.includes(handler));
			if (!resetHandler) throw new Error("missing shared lifecycle activation reset");
			await resetHandler();
			if (JSON.stringify(activeTools) !== JSON.stringify(["read", "load_subagent"])) {
				throw new Error("session start did not preserve active tools while hiding subagent: " + JSON.stringify(activeTools));
			}

			const loadResult = await loader.execute("load", {}, new AbortController().signal);
			if (JSON.stringify(activeTools) !== JSON.stringify(["read", "load_subagent", "subagent"])) {
				throw new Error("loader did not add subagent: " + JSON.stringify(activeTools));
			}
			const loaderText = loadResult.content.map((part) => part.type === "text" ? part.text : "").join("\n");
			if (!loaderText.startsWith("Subagent enabled.")) throw new Error("loader did not report activation");
			if (!loaderText.includes('action: "list"')) throw new Error("missing list-before-execute guidance");
			if (!loaderText.includes("parent session responsible")) throw new Error("missing parent-owns-final-decision guidance");
			if (!loaderText.includes("review-only tasks") || !loaderText.includes("omit acceptance")) throw new Error("missing lightweight-review guidance");
			if (!loaderText.includes("incomplete active Pi goal") || !loaderText.includes("async:false")) throw new Error("missing foreground-exception guidance");
			if (!loaderText.includes("non-blocking steer") || !loaderText.includes("supplements the active task")) throw new Error("missing steer-first guidance");
			const activeSetCount = activeSets.length;
			const repeatedLoad = await loader.execute("load-again", {}, new AbortController().signal);
			if (activeSets.length !== activeSetCount) throw new Error("repeated load rewrote the active tool set");
			const repeatedText = repeatedLoad.content.map((part) => part.type === "text" ? part.text : "").join("\n");
			if (!repeatedText.startsWith("Subagent already enabled.")) throw new Error("repeated load did not report its no-op");

			await resetHandler();
			if (JSON.stringify(activeTools) !== JSON.stringify(["read", "load_subagent"])) {
				throw new Error("tree navigation did not hide subagent: " + JSON.stringify(activeTools));
			}
			await loader.execute("load-after-tree", {}, new AbortController().signal);
			await resetHandler();
			if (JSON.stringify(activeTools) !== JSON.stringify(["read", "load_subagent"])) {
				throw new Error("compaction did not hide subagent: " + JSON.stringify(activeTools));
			}

			const calls = [];
			let expanded = false;
			const ctx = {
				cwd: process.cwd(),
				mode: "tui",
				hasUI: true,
				isProjectTrusted() { return true; },
				ui: {
					getToolsExpanded() { return expanded; },
					setToolsExpanded(value) { expanded = value; calls.push(value); },
					setWidget() {},
					requestRender() {},
					theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } },
				},
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; }, getSessionDir() { return process.cwd(); } },
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
			const registeredTools = new Map();
			const fakePi = new Proxy({
				events,
				registerTool(tool) { registeredTools.set(tool.name, tool); },
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
			const registeredTool = registeredTools.get("subagent");
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
				mode: "json",
				hasUI: false,
				isProjectTrusted() { return true; },
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; }, getSessionDir() { return process.cwd(); } },
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
