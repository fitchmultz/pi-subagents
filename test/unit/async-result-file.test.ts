import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readAsyncResultFile, readAsyncResultFileIfExists } from "../../src/runs/background/async-result-file.ts";

function readFixture(content: string, name = "result.json") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-result-decoder-"));
	try {
		const file = path.join(root, name);
		fs.writeFileSync(file, content);
		return readAsyncResultFile(file);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("async result file decoder", () => {
	it("decodes current successful result files without changing nested metadata", () => {
		const data = readFixture(JSON.stringify({
			id: "async-1",
			runId: "run-1",
			agent: "parallel:a+b",
			mode: "parallel",
			success: true,
			state: "complete",
			summary: "done",
			results: [
				{ agent: "a", output: "A", success: true, children: [{ id: "nested-a", state: "complete" }] },
				{ agent: "b", output: "B", success: true },
			],
			nestedChildren: [{ id: "top-nested", state: "complete" }],
		}), "async-1.json");

		assert.equal(data.terminalState, "complete");
		assert.equal(data.id, "async-1");
		assert.equal(data.results?.[0]?.agent, "a");
		assert.deepEqual(data.results?.[0]?.children, [{ id: "nested-a", state: "complete" }]);
		assert.deepEqual(data.nestedChildren, [{ id: "top-nested", state: "complete" }]);
	});

	it("normalizes partial result files to failed while preserving summary-only data", () => {
		const data = readFixture(JSON.stringify({
			id: "partial-result",
			summary: "runner disappeared",
		}), "partial-result.json");

		assert.equal(data.terminalState, "failed");
		assert.equal(data.summary, "runner disappeared");
		assert.equal(data.results, undefined);
	});

	it("normalizes state-only terminal result files for legacy compatibility", () => {
		assert.equal(readFixture(JSON.stringify({ state: "complete" })).terminalState, "complete");
		assert.equal(readFixture(JSON.stringify({ state: "failed" })).terminalState, "failed");
	});

	it("normalizes paused result files from state or zero exit code", () => {
		assert.equal(readFixture(JSON.stringify({ success: false, state: "paused" })).terminalState, "paused");
		assert.equal(readFixture(JSON.stringify({ state: "paused" })).terminalState, "paused");
		assert.equal(readFixture(JSON.stringify({ exitCode: 0 })).terminalState, "paused");
	});

	it("reports malformed JSON and non-object files with consistent path diagnostics", () => {
		assert.throws(
			() => readFixture("{bad-json", "bad.json"),
			/Failed to read async result file '.*\/bad\.json': Invalid JSON file/,
		);
		assert.throws(
			() => readFixture("[]", "array.json"),
			/Failed to read async result file '.*\/array\.json': Invalid JSON file .*\/array\.json: SyntaxError: Owner records must be objects/,
		);
		assert.throws(
			() => readFixture(JSON.stringify({ results: {} }), "bad-results.json"),
			/Invalid async result file '.*\/bad-results\.json': results must be an array\./,
		);
		assert.throws(
			() => readFixture(JSON.stringify({ results: [null] }), "bad-child.json"),
			/Invalid async result file '.*\/bad-child\.json': results\[0\] must be an object\./,
		);
	});

	it("reads files and returns undefined for missing optional files", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-result-decoder-"));
		try {
			const resultPath = path.join(root, "result.json");
			fs.writeFileSync(resultPath, JSON.stringify({ id: "from-file", success: true }), "utf-8");

			assert.equal(readAsyncResultFile(resultPath).terminalState, "complete");
			assert.equal(readAsyncResultFileIfExists(path.join(root, "missing.json")), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
