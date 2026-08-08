import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeParallelGroups } from "../../src/runs/background/parallel-groups.ts";
import { sanitizeNestedPath } from "../../src/runs/shared/nested-path.ts";

describe("persisted run metadata normalization", () => {
	it("keeps only nonnegative integer nested step indexes", () => {
		assert.deepEqual(sanitizeNestedPath([
			{ runId: "a", stepIndex: -1 },
			{ runId: "b", stepIndex: 1.5 },
			{ runId: "c", stepIndex: 2 },
		]), [{ runId: "a" }, { runId: "b" }, { runId: "c", stepIndex: 2 }]);
	});

	it("drops overlapping and duplicate logical parallel groups", () => {
		assert.deepEqual(normalizeParallelGroups([
			{ start: 0, count: 2, stepIndex: 0 },
			{ start: 1, count: 2, stepIndex: 1 },
			{ start: 3, count: 1, stepIndex: 0 },
			{ start: 3, count: 1, stepIndex: 2 },
		], 4, 3), [
			{ start: 0, count: 2, stepIndex: 0 },
			{ start: 3, count: 1, stepIndex: 2 },
		]);
	});
});
