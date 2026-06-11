import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseAsyncResultFileContent, readAsyncResultFile, readAsyncResultFileIfExists } from "../../src/runs/background/async-result-file.ts";

describe("async result file decoder", () => {
	it("decodes current successful result files without changing nested metadata", () => {
		const data = parseAsyncResultFileContent(JSON.stringify({
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
		}), "/tmp/async-1.json");

		assert.equal(data.terminalState, "complete");
		assert.equal(data.id, "async-1");
		assert.equal(data.results?.[0]?.agent, "a");
		assert.deepEqual(data.results?.[0]?.children, [{ id: "nested-a", state: "complete" }]);
		assert.deepEqual(data.nestedChildren, [{ id: "top-nested", state: "complete" }]);
	});

	it("normalizes partial result files to failed while preserving summary-only data", () => {
		const data = parseAsyncResultFileContent(JSON.stringify({
			id: "partial-result",
			summary: "runner disappeared",
		}), "/tmp/partial-result.json");

		assert.equal(data.terminalState, "failed");
		assert.equal(data.summary, "runner disappeared");
		assert.equal(data.results, undefined);
	});

	it("normalizes state-only terminal result files for legacy compatibility", () => {
		assert.equal(parseAsyncResultFileContent(JSON.stringify({ state: "complete" })).terminalState, "complete");
		assert.equal(parseAsyncResultFileContent(JSON.stringify({ state: "failed" })).terminalState, "failed");
	});

	it("normalizes paused result files from state or zero exit code", () => {
		assert.equal(parseAsyncResultFileContent(JSON.stringify({ success: false, state: "paused" })).terminalState, "paused");
		assert.equal(parseAsyncResultFileContent(JSON.stringify({ state: "paused" })).terminalState, "paused");
		assert.equal(parseAsyncResultFileContent(JSON.stringify({ exitCode: 0 })).terminalState, "paused");
	});

	it("reports malformed JSON and non-object files with consistent path diagnostics", () => {
		assert.throws(
			() => parseAsyncResultFileContent("{bad-json", "/tmp/bad.json"),
			/Failed to parse async result file '\/tmp\/bad\.json':/,
		);
		assert.throws(
			() => parseAsyncResultFileContent("[]", "/tmp/array.json"),
			/Failed to parse async result file '\/tmp\/array\.json': expected a JSON object\./,
		);
		assert.throws(
			() => parseAsyncResultFileContent(JSON.stringify({ results: {} }), "/tmp/bad-results.json"),
			/Invalid async result file '\/tmp\/bad-results\.json': results must be an array\./,
		);
		assert.throws(
			() => parseAsyncResultFileContent(JSON.stringify({ results: [null] }), "/tmp/bad-child.json"),
			/Invalid async result file '\/tmp\/bad-child\.json': results\[0\] must be an object\./,
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
