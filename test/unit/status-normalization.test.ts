import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "../../src/runs/background/parallel-groups.ts";
import { sanitizeNestedPath } from "../../src/runs/shared/nested-path.ts";

describe("persisted run metadata normalization", () => {
	it("keeps only nonnegative integer nested step indexes", () => {
		assert.deepEqual(sanitizeNestedPath([
			{ runId: "a", stepIndex: -1 },
			{ runId: "b", stepIndex: 1.5 },
			{ runId: "c", stepIndex: 2 },
		]), [{ runId: "a" }, { runId: "b" }, { runId: "c", stepIndex: 2 }]);
	});

	it("keeps empty logical groups at child boundaries without accepting invalid counts", () => {
		const groups = [
			{ start: 0, count: 0, stepIndex: 0 },
			{ start: 0, count: 2, stepIndex: 1 },
			{ start: 2, count: 0, stepIndex: 2 },
			{ start: 2, count: 1, stepIndex: 3 },
			{ start: 3, count: 0, stepIndex: 4 },
		];
		const normalized = normalizeParallelGroups([
			...groups,
			{ start: 1, count: 0, stepIndex: 2 }, // Inside another group's children, not a boundary.
			{ start: 3, count: 0, stepIndex: 4 }, // Duplicate logical group.
			{ start: 4, count: 0, stepIndex: 4 }, // Beyond the last child boundary.
			...[-1, 0.5, NaN, Infinity, "0"].map((count) => ({ start: 3, count, stepIndex: 4 })),
		], 3, 5);
		assert.deepEqual(normalized, groups);
		assert.deepEqual([0, 1, 2].map((index) => flatToLogicalStepIndex(index, 5, normalized)), [1, 1, 3]);
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
