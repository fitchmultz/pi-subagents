import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../src/shared/types.ts";
import { events } from "../support/helpers.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-reviewed-output-"));
const previous = { agent: process.env.PI_CODING_AGENT_DIR, temp: process.env.PI_SUBAGENT_TEMP_ROOT };
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const { SessionManager } = await import("../../src/shared/native-session.ts");
const { restoreOwnedRuns, ownedRunView } = await import("../../src/runs/shared/run-records.ts");
const { ASYNC_DIR } = await import("../../src/shared/types.ts");
const { getRunMetadataDir } = await import("../../src/runs/shared/supervisor-questions.ts");
const { resolveEffectiveAcceptance } = await import("../../src/runs/shared/acceptance-contract.ts");
const { evaluateAcceptanceReport } = await import("../../src/runs/shared/acceptance-evaluation.ts");
after(() => {
	if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
	if (previous.temp === undefined) delete process.env.PI_SUBAGENT_TEMP_ROOT; else process.env.PI_SUBAGENT_TEMP_ROOT = previous.temp;
	fs.rmSync(root, { recursive: true, force: true });
});
const report = { criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Reviewed the final report" }] };
const legacyReport = `FINAL_REVIEWED_REPORT\n\n\`\`\`acceptance-report\n${JSON.stringify(report)}\n\`\`\``;

for (const scenario of ["prose", "legacy-tool", "typed-tool", "failed-tool", "unfinished-followup", "missing-session", "missing-end", "immutable-review"] as const) {
	it(`legacy terminal recovery keeps reviewed output with trustworthy provenance: ${scenario}`, async () => {
		const cwd = path.join(root, scenario);
		fs.mkdirSync(cwd);
		const parent = SessionManager.create(cwd, path.join(cwd, "parents"));
		parent.appendMessage(events.assistantMessage("Parent work").message);
		const child = SessionManager.create(cwd, path.join(cwd, "children"));
		const startedAt = Date.now();
		child.appendMessage(events.assistantMessage("INITIAL_DRAFT").message);
		if (scenario.endsWith("tool")) {
			const value = scenario === "legacy-tool" ? { report: legacyReport } : { answer: "FINAL_REVIEWED_REPORT", report };
			child.appendMessage({ ...events.assistantMessage("").message, stopReason: "toolUse", content: [{ type: "toolCall", id: "final-report", name: "structured_output", arguments: { value } }] });
			child.appendMessage({ role: "toolResult", toolCallId: "final-report", toolName: "structured_output", content: [{ type: "text", text: "Submission checked" }], isError: scenario === "failed-tool", timestamp: Date.now() });
		} else child.appendMessage(events.assistantMessage("FINAL_REVIEWED_REPORT").message);
		if (scenario === "unfinished-followup") child.appendMessage({ role: "user", content: "Revise that report before finishing", timestamp: Date.now() });
		const endedAt = Date.now();
		await delay(5);
		child.appendMessage({ role: "user", content: "A later unrelated continuation", timestamp: Date.now() });
		child.appendMessage(events.assistantMessage("LATER_UNRELATED_ANSWER").message);
		const sessionFile = child.getSessionFile()!;
		const id = `legacy-reviewed-${scenario}`, dir = path.join(ASYNC_DIR, id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "output-0.log"), "INITIAL_DRAFT\n");
		fs.writeFileSync(path.join(dir, "output-0.log.finalization-1.log"), "UNBOUND_REVIEW_LOG\n");
		let acceptance;
		if (scenario === "immutable-review") {
			acceptance = evaluateAcceptanceReport({ acceptance: resolveEffectiveAcceptance({ explicit: { criteria: ["Review the final report"] } }), output: legacyReport });
			acceptance.finalization = { mode: "self-review-loop", status: "completed", maxTurns: 1,
				turns: [{ turn: 1, prompt: "Review", status: acceptance.status, rawOutput: legacyReport, report, runtimeChecks: [], verifyRuns: [] }] };
		}
		if (scenario === "missing-session" || scenario === "immutable-review") fs.rmSync(sessionFile);
		const terminalTime = scenario === "missing-end" ? {} : { endedAt };
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: id, sessionId: parent.getSessionFile(), mode: "single", state: "complete", cwd, startedAt, ...terminalTime, lastUpdate: Date.now(), sessionFile,
			steps: [{ agent: "worker", status: "complete", sessionFile, exitCode: 0, startedAt, ...terminalTime, acceptance }] }));
		const state = { ownedRuns: new Map(), foregroundRuns: new Map(), asyncJobs: new Map() } as SubagentState;
		const ctx = { cwd, sessionManager: parent } as ExtensionContext;
		restoreOwnedRuns(state, ctx, { strict: true });
		const expected = ["failed-tool", "unfinished-followup", "missing-session", "missing-end"].includes(scenario) ? "" : "FINAL_REVIEWED_REPORT";
		const view = ownedRunView(state.ownedRuns!.get(id)!, state);
		assert.equal(view.children[0]!.result?.finalOutput, expected);
		const resultPath = path.join(getRunMetadataDir(id), "result.json");
		const frozen = fs.readFileSync(resultPath);
		assert.equal(JSON.parse(frozen.toString()).results[0].output, expected);
		fs.rmSync(dir, { recursive: true });
		restoreOwnedRuns(state, ctx, { strict: true });
		assert.equal(ownedRunView(state.ownedRuns!.get(id)!, state).children[0]!.result?.finalOutput, expected);
		assert.deepEqual(fs.readFileSync(resultPath), frozen, "reopening cannot replace the original run's answer with a later continuation");
	});
}
