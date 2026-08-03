import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
	type RunnerSubagentStep,
	type ParallelStepGroup,
	type RunnerStep,
} from "../../src/runs/shared/parallel-utils.ts";

describe("isParallelGroup", () => {
	it("returns true for a parallel step group", () => {
		const step: ParallelStepGroup = {
			parallel: [
				{ agent: "a", task: "do stuff" },
				{ agent: "b", task: "do other stuff" },
			],
		};
		assert.equal(isParallelGroup(step), true);
	});

	it("returns false for a sequential step", () => {
		const step: RunnerSubagentStep = { agent: "a", task: "do stuff" };
		assert.equal(isParallelGroup(step), false);
	});

	it("returns false when parallel is not an array", () => {
		const step = { parallel: "not-an-array", agent: "a", task: "x" } as unknown as RunnerStep;
		assert.equal(isParallelGroup(step), false);
	});
});

describe("flattenSteps", () => {
	it("returns sequential steps unchanged", () => {
		const steps: RunnerStep[] = [
			{ agent: "a", task: "t1" },
			{ agent: "b", task: "t2" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 2);
		assert.equal(flat[0].agent, "a");
		assert.equal(flat[1].agent, "b");
	});

	it("expands parallel groups into individual steps", () => {
		const steps: RunnerStep[] = [
			{ agent: "scout", task: "find info" },
			{
				parallel: [
					{ agent: "reviewer-a", task: "review part 1" },
					{ agent: "reviewer-b", task: "review part 2" },
				],
			},
			{ agent: "summarizer", task: "combine" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 4);
		assert.deepEqual(
			flat.map((s) => s.agent),
			["scout", "reviewer-a", "reviewer-b", "summarizer"],
		);
	});

	it("handles empty steps array", () => {
		assert.deepEqual(flattenSteps([]), []);
	});

	it("handles empty parallel group", () => {
		const steps: RunnerStep[] = [
			{ agent: "before", task: "x" },
			{ parallel: [] },
			{ agent: "after", task: "y" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 2);
		assert.deepEqual(flat.map((s) => s.agent), ["before", "after"]);
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("mapConcurrent", () => {
	it("processes all items and preserves order", async () => {
		const items = [10, 20, 30, 40];
		const results = await mapConcurrent(items, 2, async (item) => item * 2);
		assert.deepEqual(results, [20, 40, 60, 80]);
	});

	it("starts workers immediately without exceeding the concurrency limit", async () => {
		let running = 0;
		let maxRunning = 0;
		const gate = deferred();
		const result = mapConcurrent([1, 2, 3, 4, 5, 6], 2, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await gate.promise;
			running--;
		});

		assert.equal(running, 2);
		gate.resolve();
		await result;
		assert.equal(maxRunning, 2);
	});

	it("handles empty input", async () => {
		const results = await mapConcurrent([], 4, async (item: number) => item);
		assert.deepEqual(results, []);
	});

	it("clamps non-positive limits to sequential execution", async () => {
		for (const limit of [0, -1]) {
			let running = 0;
			let maxRunning = 0;
			const gate = deferred();
			const result = mapConcurrent([1, 2, 3], limit, async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await gate.promise;
				running--;
			});

			assert.equal(running, 1);
			gate.resolve();
			await result;
			assert.equal(maxRunning, 1);
		}
	});

	it("propagates errors", async () => {
		await assert.rejects(
			() => mapConcurrent([1, 2, 3], 2, async (item) => {
				if (item === 2) throw new Error("boom");
				return item;
			}),
			/boom/,
		);
	});
});

describe("aggregateParallelOutputs", () => {
	it("aggregates successful outputs with headers", () => {
		const result = aggregateParallelOutputs([
			{ agent: "reviewer-a", output: "Looks good", exitCode: 0 },
			{ agent: "reviewer-b", output: "Needs fixes", exitCode: 0 },
		]);
		assert.ok(result.includes("=== Parallel Task 1 (reviewer-a) ==="));
		assert.ok(result.includes("Looks good"));
		assert.ok(result.includes("=== Parallel Task 2 (reviewer-b) ==="));
		assert.ok(result.includes("Needs fixes"));
	});

	it("marks failed tasks", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "partial output", exitCode: 1 },
		]);
		assert.ok(result.includes("FAILED (exit code 1)"));
	});

	it("marks empty output", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "", exitCode: 0 },
		]);
		assert.ok(result.includes("EMPTY OUTPUT"));
	});

	it("treats whitespace-only output as empty", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "   \n  ", exitCode: 0 },
		]);
		assert.ok(result.includes("EMPTY OUTPUT"));
	});

	it("marks skipped tasks (exitCode=-1) distinctly from failed", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "done", exitCode: 0 },
			{ agent: "agent-b", output: "(skipped — fail-fast)", exitCode: -1 },
		]);
		assert.ok(result.includes("SKIPPED"), "skipped task should show SKIPPED");
		assert.ok(!result.includes("FAILED"), "skipped task should not show FAILED");
	});
});

describe("MAX_PARALLEL_CONCURRENCY", () => {
	it("is 4", () => {
		assert.equal(MAX_PARALLEL_CONCURRENCY, 4);
	});
});
