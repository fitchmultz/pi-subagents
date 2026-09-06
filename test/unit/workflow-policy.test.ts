import assert from "node:assert/strict";
import { addAbortListener } from "node:events";
import { describe, it } from "node:test";
import { renderChainTask } from "../../src/runs/shared/chain-outputs.ts";
import { materializeDynamicParallelStep } from "../../src/runs/shared/dynamic-fanout.ts";
import { isFailFastAbort } from "../../src/runs/shared/parallel-utils.ts";
import { completeWorkflowStep, runParallelTasks } from "../../src/runs/shared/workflow-policy.ts";

const success = { agent: "worker", output: "Evidence", exitCode: 0 };

describe("workflow policy", () => {
	it("bounds parallel work and returns input order, not completion order", async () => {
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const started: number[] = [];
		const pending = runParallelTasks({
			tasks: gates, concurrency: 2,
			runTask: async (gate, index) => { started.push(index); await gate.promise; return { ...success, output: String(index) }; },
			stoppedTask: () => { throw new Error("No task should stop"); },
		});
		assert.deepEqual(started, [0, 1]);
		gates[1].resolve();
		await new Promise(setImmediate);
		assert.deepEqual(started, [0, 1, 2]);
		gates[2].resolve();
		gates[0].resolve();
		assert.deepEqual((await pending).map((result) => result.output), ["0", "1", "2"]);
	});

	it("fail-fast interrupts running siblings with its own reason and skips queued work", async () => {
		const first = Promise.withResolvers<{ exitCode: number }>();
		const started: number[] = [];
		const pending = runParallelTasks({
			tasks: [0, 1, 2], concurrency: 2, failFast: true,
			runTask: async (_, index, signal) => {
				started.push(index);
				if (index === 0) return first.promise;
				return new Promise<{ exitCode: number }>((resolve) => {
					addAbortListener(signal, () => { assert.equal(isFailFastAbort(signal), true); resolve({ exitCode: -1 }); });
				});
			},
			stoppedTask: (_, index, reason) => { assert.equal(index, 2); assert.equal(reason, "fail-fast"); return { exitCode: -1 }; },
		});
		first.resolve({ exitCode: 1 });
		assert.deepEqual((await pending).map((result) => result.exitCode), [1, -1, -1]);
		assert.deepEqual(started, [0, 1]);
	});

	it("pause, detach and cancellation stop queued work without becoming fail-fast", async () => {
		for (const reason of ["interrupted", "detached", "cancelled"] as const) {
			const cancellation = new AbortController();
			const started: number[] = [];
			const results = await runParallelTasks({
				tasks: [0, 1], concurrency: 1, failFast: true, signal: cancellation.signal,
				runTask: async (_, index, failFastSignal) => {
					started.push(index);
					assert.equal(failFastSignal.aborted, false);
					if (reason === "cancelled") cancellation.abort();
					return { ...success, ...(reason === "cancelled" ? {} : { [reason]: true }) };
				},
				stoppedTask: (_, index, stopped) => { assert.equal(index, 1); assert.equal(stopped, reason); return { ...success, exitCode: -1 }; },
			});
			assert.deepEqual(started, [0]);
			assert.equal(results[1].exitCode, -1);
		}
	});

	it("retains successful sibling outputs but cannot advance from any stopped group", () => {
		for (const stopped of [{ exitCode: 1 }, { exitCode: -1 }, { exitCode: 0, interrupted: true }, { exitCode: 0, detached: true }, { exitCode: 124, timedOut: true }]) {
			const completion = completeWorkflowStep({ stepIndex: 0, stepCount: 2, previousOutput: "Before", parallel: true,
				results: [success, { ...success, ...stopped }], outputNames: ["evidence", "unfinished"] });
			assert.equal(completion.outputs.evidence.text, "Evidence");
			assert.equal(completion.outputs.unfinished, undefined);
			assert.equal(completion.previousOutput, "Before");
			assert.equal(completion.advance, false);
			assert.equal(completion.complete, false);
		}
		const mixed = completeWorkflowStep({ stepIndex: 0, stepCount: 1, previousOutput: "", results: [success, { ...success, exitCode: 1 }, { ...success, detached: true }] });
		assert.deepEqual(mixed.failedIndices, [1]);
		assert.equal(mixed.detachedIndex, 2);
	});

	it("a successful prefix is not a completed workflow", () => {
		const prefix = completeWorkflowStep({ stepIndex: 0, stepCount: 2, results: [success], previousOutput: "" });
		assert.equal(prefix.advance, true);
		assert.equal(prefix.complete, false);
		const last = completeWorkflowStep({ stepIndex: 1, stepCount: 2, results: [success], previousOutput: prefix.previousOutput });
		assert.equal(last.complete, true);
	});

	it("publishes dynamic collections only after every child and the aggregate schema succeed", () => {
		const step = { expand: { from: { output: "items", path: "/items" }, maxItems: 2 }, parallel: { agent: "worker", task: "{item}" }, collect: { as: "answers", outputSchema: { type: "array", minItems: 2 } } };
		const items = materializeDynamicParallelStep(step, { items: { agent: "producer", stepIndex: 0, text: "", structured: { items: ["a", "b"] } } }, 1).items;
		const complete = (results: Array<typeof success>, collect = step.collect) => completeWorkflowStep({ stepIndex: 1, stepCount: 2, results, previousOutput: "Before", dynamic: { step: { ...step, collect }, items } });
		assert.deepEqual((complete([success, success]).outputs.answers.structured as Array<{ key: string }>).map((item) => item.key), ["0", "1"]);
		for (const completion of [complete([success]), complete([success, { ...success, exitCode: 1 }]), complete([success, success], { ...step.collect, outputSchema: { type: "array", minItems: 3 } })]) {
			assert.equal(completion.advance, false);
			assert.equal(completion.outputs.answers, undefined);
			assert.equal(completion.previousOutput, "Before");
		}
		const empty = completeWorkflowStep({ stepIndex: 1, stepCount: 2, results: [], previousOutput: "Before", dynamic: { step: { ...step, collect: { as: "answers" } }, items: [] } });
		assert.equal(empty.complete, true);
		assert.deepEqual(empty.outputs.answers.structured, []);
	});

	it("renders all template inputs as literal data in one pass", () => {
		const literal = "$& $` $' {task} {previous} {outputs.unknown} {item.value}";
		const values = { originalTask: literal, previousOutput: literal, chainDir: literal,
			outputs: { evidence: { text: literal, agent: "worker", stepIndex: 0 } }, item: { name: "item", value: { value: literal } } };
		assert.equal(renderChainTask("{task}|{previous}|{outputs.evidence}|{chain_dir}|{item.value}", values), Array(5).fill(literal).join("|"));
		assert.equal(renderChainTask("Continue", { previousOutput: literal }), `Continue\n\n---\nPrevious step output:\n${literal}`);
		assert.equal(renderChainTask("{previous}", { item: { name: "previous", value: literal } }), literal);
	});
});
