import test, { after } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import { createEventBus, createExtensionRuntime, CustomMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import registerSubagentExtension from "../../src/extension/index.ts";
import { formatAsyncStartedMessage } from "../../src/runs/background/async-execution.ts";
import { buildSubagentResultIntercomPayload, formatSubagentResultReceipt, stripDetailsOutputsForIntercomReceipt } from "../../src/intercom/result-intercom.ts";
import type { SubagentExecutionResult } from "../../src/shared/types.ts";
import { renderSubagentResult } from "../../src/tui/render.ts";

const { loadExtensionFromFactory } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const runtime = createExtensionRuntime();
const extension = await loadExtensionFromFactory(registerSubagentExtension, process.cwd(), createEventBus(), runtime);
after(() => runtime.invalidate());
initTheme("dark", false);
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { setKeybindings } = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
setKeybindings(new KeybindingsManager());

function nativeTool(name: string, result: SubagentExecutionResult): ToolExecutionComponent {
	const tool = extension.tools.get(name)?.definition;
	assert.ok(tool, `${name} must use its registered renderer`);
	const component = new ToolExecutionComponent(name, "render-test", { agent: "worker" }, {}, tool, { requestRender() {} } as never, process.cwd());
	component.updateResult({ ...result, isError: result.isError ?? false });
	return component;
}

function renderedText(component: { render(width: number): string[] }, width: number): string {
	const lines = component.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), `rendered rows must fit ${width} columns`);
	return lines.map(stripVTControlCharacters).map((line) => line.trimEnd()).join("\n");
}

const unwrap = (text: string) => text.replace(/\s/g, "");

const theme = {
	fg(_name: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

function componentText(component: unknown): string {
	if (typeof component !== "object" || component === null) return "";
	if ("text" in component && typeof component.text === "string") return component.text;
	if ("children" in component && Array.isArray(component.children)) return component.children.map(componentText).filter(Boolean).join("\n");
	return "";
}

function result(agent: string, output: string) {
	return {
		agent,
		task: `${agent} task`,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		finalOutput: output,
	};
}

test("native async launch and revival cards collapse without changing their receipts", async (t) => {
	const id = "f5b4b221-5c64-4bc7-9862-70a35d94dc9b";
	const previousId = "622f1dc5-d645-4125-a903-c60e3a568208";
	for (const mode of ["single", "parallel", "chain", "revival"] as const) {
		await t.test(mode, () => {
			const headline = mode === "revival"
				? `Revived async subagent from ${previousId}.\nRun mapping: ${previousId} -> ${id}\nRevived run: ${id}\nAgent: worker\nSession: /tmp/saved-child.jsonl`
				: mode === "single" ? `Async: worker [${id}]` : `Async ${mode}: worker -> reviewer [${id}]`;
			const receipt: SubagentExecutionResult = {
				content: [{ type: "text", text: formatAsyncStartedMessage(headline) }],
				details: {
					mode: mode === "revival" ? "single" : mode, results: [], runId: id, asyncId: id, asyncDir: `/tmp/${id}`, context: "fork",
					...(mode === "revival" ? { managementControl: { state: "live", runId: id, capabilities: [], nextActions: [], revivedFromRunId: previousId } } : {}),
				},
			};
			const original = structuredClone(receipt);
			for (const name of ["delegate", "subagent", "agent_runs"]) {
				const component = nativeTool(name, receipt);
				for (const width of [120, 40, 80]) {
					const collapsed = renderedText(component, width);
					assert.ok(component.render(width).length <= 7, `${name} ${mode} should not display the instruction paragraphs`);
					assert.ok(collapsed.includes(id.slice(0, 8)), "the current run must remain identifiable, including after revival");
					assert.match(collapsed, /\[fork\]/);
					assert.doesNotMatch(collapsed, /sleep timers|polling loops|independent work/);
					assert.match(collapsed, /ctrl\+o/i);
					component.setExpanded(true);
					assert.ok(unwrap(renderedText(component, width)).includes(unwrap(receipt.content[0]!.text)), "native expansion retains the entire receipt");
					component.setExpanded(false);
					assert.equal(renderedText(component, width), collapsed, "native collapse restores the compact card");
				}
			}
			assert.deepEqual(receipt, original, "rendering must not edit model-visible content or details");
		});
	}
});

test("async start rendering does not hide errors or management reports", () => {
	const output = "Run: existing-run\nState: failed\nDiagnosis: runner could not start\nAction: inspect the saved log";
	for (const details of [
		{ mode: "single", results: [] },
		{ mode: "management", results: [], asyncId: "existing-run" },
	] as const) {
		const receipt = { content: [{ type: "text", text: output }], details } as SubagentExecutionResult;
		assert.equal(componentText(renderSubagentResult(receipt, { expanded: false }, theme as any)), output);
		assert.ok(unwrap(renderedText(nativeTool("agent_runs", receipt), 40)).includes(unwrap(output)));
	}
	const error: SubagentExecutionResult = {
		content: [{ type: "text", text: output }], isError: true,
		details: { mode: "single", results: [], asyncId: "existing-run" },
	};
	assert.equal(componentText(renderSubagentResult(error, { expanded: false }, theme as any)), output);
	const nativeError = nativeTool("delegate", { ...error, details: undefined as never });
	assert.ok(unwrap(renderedText(nativeError, 40)).includes(unwrap(output)), "thrown tool errors have no launch details");
});

test("native foreground and slash responses stay compact and expand every child response", async (t) => {
	for (const mode of ["single", "parallel", "chain"] as const) {
		await t.test(mode, () => {
			const results = (mode === "single" ? ["worker"] : ["worker", "reviewer"]).map((agent) => result(agent,
				`${agent} response: ${"café 中文 👩🏽‍💻 detailed findings. ".repeat(35)}\n\nEnd of ${agent} response.`,
			));
			const receipt: SubagentExecutionResult = {
				content: [{ type: "text", text: results.map((entry) => entry.finalOutput).join("\n\n") }],
				details: { mode, runId: "response-run", results },
			};
			const original = structuredClone(receipt);
			const slashRenderer = extension.messageRenderers.get("subagent-slash-result");
			assert.ok(slashRenderer);
			const components = [nativeTool("delegate", receipt), new CustomMessageComponent({
				role: "custom", customType: "subagent-slash-result", display: true, timestamp: 0,
				content: receipt.content, details: { requestId: `render-${mode}`, result: receipt },
			}, slashRenderer)];
			for (const component of components) {
				component.setExpanded(true);
				for (const width of [120, 40]) {
					const expanded = unwrap(renderedText(component, width));
					for (const entry of results) assert.ok(expanded.includes(unwrap(entry.finalOutput)), `expanded ${mode} must include ${entry.agent}'s full response`);
				}
				component.setExpanded(false);
				const wideRows = component.render(120).length;
				for (const width of [120, 40, 80]) {
					const collapsed = renderedText(component, width);
					assert.equal(component.render(width).length, wideRows, "compact rows must truncate at the actual width, not wrap a stdout-sized preview");
					assert.ok(wideRows <= 10);
					assert.doesNotMatch(collapsed, /End of .* response/);
					assert.match(collapsed, /ctrl\+o/i);
				}
			}
			assert.deepEqual(receipt, original);
		});
	}
});

test("foreground intercom receipts retain full metadata without claiming separately delivered responses are empty", () => {
	for (const mode of ["single", "parallel", "chain"] as const) {
		const payload = buildSubagentResultIntercomPayload({
			to: "parent", runId: "receipt-run", mode, source: "foreground",
			children: [{ agent: "worker", status: "completed", summary: "Full response is in the completion message." }],
		});
		const receipt: SubagentExecutionResult = {
			content: [{ type: "text", text: formatSubagentResultReceipt({ mode, runId: "receipt-run", payload }) }],
			details: stripDetailsOutputsForIntercomReceipt({ mode, runId: "receipt-run", chainAgents: mode === "chain" ? ["worker"] : undefined, results: [result("worker", payload.children[0]!.summary)] }, {
				delivered: true, to: payload.to, status: payload.status, summary: payload.summary,
			}),
		};
		const original = structuredClone(receipt);
		const component = nativeTool("delegate", receipt);
		assert.doesNotMatch(renderedText(component, 40), /no text output/);
		assert.match(renderedText(component, 40), /receipt details/);
		component.setExpanded(true);
		const expanded = renderedText(component, 40);
		assert.ok(unwrap(expanded).includes(unwrap(receipt.content[0]!.text)));
		assert.match(expanded, /worker task/, "expanding a receipt must retain the child metadata too");
		assert.doesNotMatch(expanded, /warning|no text output/);
		assert.deepEqual(receipt, original);
	}
});

test("native completed failure cards keep the error visible and expandable", () => {
	const error = `Needs attention: ${"the output could not be saved. ".repeat(30)}\nExact failure detail.`;
	for (const mode of ["single", "parallel"] as const) {
		const receipt: SubagentExecutionResult = {
			content: [{ type: "text", text: error }],
			details: { mode, results: [{ ...result("worker", ""), exitCode: 1, error }] },
		};
		const component = nativeTool("delegate", receipt);
		const collapsed = renderedText(component, 40);
		assert.match(collapsed, /✗/);
		assert.match(collapsed, /Needs attention/);
		assert.ok(component.render(40).length <= 8);
		component.setExpanded(true);
		assert.ok(unwrap(renderedText(component, 40)).includes(unwrap(error)));
	}
});

test("native fallback notifications truncate long preview lines and expand the full response", () => {
	const renderer = extension.messageRenderers.get("subagent-notify");
	assert.ok(renderer);
	for (const status of ["completed", "failed", "paused"]) {
		const summary = `Needs attention: ${"café 中文 👩🏽‍💻 notification detail. ".repeat(40)}\n\nLast notification detail.`;
		const message = {
			role: "custom" as const, customType: "subagent-notify", display: true, timestamp: 0,
			content: `Background task ${status}: **worker**\n\n${summary}\n\nSession file: /tmp/saved-child.jsonl`,
		};
		const original = structuredClone(message);
		const component = new CustomMessageComponent(message, renderer);
		for (const width of [120, 40, 80]) {
			const collapsed = renderedText(component, width);
			assert.ok(component.render(width).length <= 5, "one long source line must not fill the terminal");
			assert.match(collapsed, new RegExp(status));
			assert.match(collapsed, /Needs attention/);
			assert.doesNotMatch(collapsed, /Last notification detail/);
			assert.match(collapsed, /ctrl\+o/i);
			component.setExpanded(true);
			const expanded = unwrap(renderedText(component, width)).replaceAll("⎿", "");
			assert.ok(expanded.includes(unwrap(summary)));
			assert.ok(expanded.includes("/tmp/saved-child.jsonl"));
			component.setExpanded(false);
			assert.equal(renderedText(component, width), collapsed);
		}
		assert.deepEqual(message, original);
	}
});

test("empty-result management output preserves every line", () => {
	const output = `Runtime\n- cwd: /${"long/".repeat(40)}\n\nFilesystem\n- temp root: /tmp/pi-subagents-test`;
	const component = renderSubagentResult({
		content: [{ type: "text", text: output }],
		details: { mode: "single", results: [] },
	}, { expanded: false }, theme as any);

	assert.equal(componentText(component), output);
});

test("empty-result management output collapses long reports", () => {
	const output = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
	const result = {
		content: [{ type: "text", text: output }],
		details: { mode: "single", results: [] },
	};

	const compact = componentText(renderSubagentResult(result, { expanded: false }, theme as any));
	assert.match(compact, /line 12\n\+2 more · Ctrl\+O expands$/);
	assert.doesNotMatch(compact, /line 13/);
	assert.equal(componentText(renderSubagentResult(result, { expanded: true }, theme as any)), output);
});

test("single-line management output with a trailing newline stays compact", () => {
	const output = `${"long".repeat(100)}\n`;
	const component = renderSubagentResult({
		content: [{ type: "text", text: output }],
		details: { mode: "single", results: [] },
	}, { expanded: false }, theme as any);

	assert.ok(componentText(component).length < output.length);
});

test("compact parallel rendering shows each child model", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "parallel",
			results: [
				{ ...result("scout", "a"), model: "cursor/composer-2-5", progressSummary: { toolCount: 28, tokens: 18_000, durationMs: 51_300 } },
				{ ...result("researcher", "b"), model: "openai-codex/gpt-5.5:high", progressSummary: { toolCount: 24, tokens: 119_000, durationMs: 207_000 } },
			],
		},
	}, { expanded: false }, theme as any);

	const text = componentText(component);
	assert.match(text, /Agent 1\/2: scout · cursor\/composer-2-5 · 28 tool uses · 18k token/);
	assert.match(text, /Agent 2\/2: researcher · openai-codex\/gpt-5\.5:high · 24 tool uses · 119k token/);
});

test("compact chain rendering uses workflow graph spans for dynamic fanout results", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets"), result("reviewer", "a"), result("reviewer", "b"), result("writer", "final")],
			workflowGraph: {
				runId: "render-dynamic",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "completed",
						stepIndex: 1,
						children: [
							{ id: "step-1-item-a", kind: "agent", agent: "reviewer", label: "Review A", status: "completed", flatIndex: 1, stepIndex: 1 },
							{ id: "step-1-item-b", kind: "agent", agent: "reviewer", label: "Review B", status: "completed", flatIndex: 2, stepIndex: 1 },
						],
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "completed", flatIndex: 3, stepIndex: 2 },
				],
			},
		},
	}, { expanded: false }, theme as any);

	const text = componentText(component);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Agent 1\/2: reviewer/);
	assert.match(text, /Agent 2\/2: reviewer/);
	assert.match(text, /Step 3: writer/);
});

test("compact chain rendering shows failed zero-child dynamic fanout groups", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "failed" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets")],
			workflowGraph: {
				runId: "render-empty-dynamic-failed",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "failed",
						stepIndex: 1,
						children: [],
						error: "No review targets materialized",
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "pending", stepIndex: 2 },
				],
			},
		},
	}, { expanded: false }, theme as any);

	const text = componentText(component);
	assert.match(text, /step 1\/3/);
	assert.doesNotMatch(text, /step 3\/3/);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Step 2: Review targets .* failed/);
	assert.match(text, /No review targets materialized/);
	assert.match(text, /Step 3: writer .* pending/);
});

test("expanded chain rendering uses workflow graph spans for dynamic fanout results", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets"), result("reviewer", "a"), result("reviewer", "b"), result("writer", "final")],
			workflowGraph: {
				runId: "render-dynamic-expanded",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "completed",
						stepIndex: 1,
						children: [
							{ id: "step-1-item-a", kind: "agent", agent: "reviewer", label: "Review A", status: "completed", flatIndex: 1, stepIndex: 1 },
							{ id: "step-1-item-b", kind: "agent", agent: "reviewer", label: "Review B", status: "completed", flatIndex: 2, stepIndex: 1 },
						],
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "completed", flatIndex: 3, stepIndex: 2 },
				],
			},
		},
	}, { expanded: true }, theme as any);

	const text = componentText(component);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Agent 1\/2: reviewer/);
	assert.match(text, /Agent 2\/2: reviewer/);
	assert.match(text, /Step 3: writer/);
});

test("static sequential and static parallel chain rendering keep existing labels", () => {
	const sequential = componentText(renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "writer"],
			totalSteps: 2,
			results: [result("scout", "a"), result("writer", "b")],
		},
	}, { expanded: false }, theme as any));
	assert.match(sequential, /Step 1: scout/);
	assert.match(sequential, /Step 2: writer/);

	const parallel = componentText(renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "[reviewer+auditor]", "writer"],
			totalSteps: 3,
			results: [result("scout", "a"), result("reviewer", "b"), result("auditor", "c"), result("writer", "d")],
		},
	}, { expanded: false }, theme as any));
	assert.match(parallel, /Step 1: scout/);
	assert.match(parallel, /Agent 1\/2: reviewer/);
	assert.match(parallel, /Agent 2\/2: auditor/);
	assert.match(parallel, /Step 3: writer/);
});
