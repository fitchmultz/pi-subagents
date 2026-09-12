import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus, makeAgent } from "../support/helpers.ts";

const root = fs.mkdtempSync(path.join(process.env.PI_AGENT_VIEW_EVIDENCE_DIR ?? os.tmpdir(), "native-streaming-"));
const fixture = fileURLToPath(new URL("../fixtures/native-feedback-child.mjs", import.meta.url));
const env = { ...process.env };
after(() => { process.env = env; });
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const bin = path.join(root, "bin"); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o700 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.PI_FEEDBACK_SCENARIO = "streaming";
const { runSync } = await import("../../src/runs/foreground/execution.ts");
const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
const { saveQuestionOwner } = await import("../../src/runs/shared/supervisor-questions.ts");
const { RESULTS_DIR } = await import("../../src/shared/types.ts");
async function until(check: () => boolean) { const end = Date.now() + 10_000; while (!check()) { assert.ok(Date.now() < end); await delay(10); } }

for (const background of [false, true]) test(`real native JSON deltas produce readable pre-end text in ${background ? "background status" : "foreground progress"}`, async (t) => {
	const id = `stream-${background ? "bg" : "fg"}`, cwd = path.join(root, id), release = path.join(cwd, "release"); fs.mkdirSync(cwd);
	process.env.PI_FEEDBACK_RELEASE_FILE = release;
	saveQuestionOwner(id, "fixture-owner");
	const agent = makeAgent("worker", { model: "feedback-fixture/faux-1", output: false, extensions: [] });
	const receipt = () => JSON.parse(fs.readFileSync(`${release}.json`, "utf8"));
	const texts: string[] = [];
	let done: Promise<unknown>;
	t.after(async () => { fs.writeFileSync(release, "released"); if (background) await until(() => fs.existsSync(path.join(RESULTS_DIR, `${id}.json`))); else await done; });
	if (background) {
		const started = executeAsyncSingle(id, { agent: "worker", task: "Stream both blocks", agentConfig: agent, ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: "fixture-owner" }, sessionFile: path.join(cwd, "session.jsonl"), shareEnabled: false, maxSubagentDepth: 1 });
		const statusPath = path.join(started.details.asyncDir!, "status.json");
		await until(() => {
			if (!fs.existsSync(statusPath)) return false;
			const text = JSON.parse(fs.readFileSync(statusPath, "utf8")).steps?.[0]?.streamingText;
			if (text) texts.push(text);
			return text?.includes("Second live text");
		});
		done = until(() => fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)));
	} else {
		done = runSync(cwd, [agent], "worker", "Stream both blocks", { runId: id, sessionFile: path.join(cwd, "session.jsonl"), onUpdate: (update) => {
			const text = update.details.progress?.[0]?.streamingText;
			if (text) texts.push(text);
		} });
		await until(() => texts.some((text) => text.includes("Second live text")));
	}
	assert.ok(receipt().events.some((event) => event.type === "message_update"));
	assert.equal(receipt().events.some((event) => event.type === "message_end" && event.role === "assistant"), false, "the text is visible before the authoritative final message");
	assert.ok(texts.some((text) => text.includes("First live text block.\n\nSecond live text")), "multiple native text blocks must remain readable");
	fs.writeFileSync(release, "released");
	await done;
	if (background) {
		const result = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`), "utf8")); assert.equal(result.success, true);
	}
});
