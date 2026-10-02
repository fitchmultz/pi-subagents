import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFileCoalescer } from "../../src/shared/file-coalescer.ts";

describe("createFileCoalescer", () => {
	it("coalesces duplicate schedule calls per file", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const events: string[] = [];
		const coalescer = createFileCoalescer((file) => events.push(file), 50);
		assert.equal(coalescer.schedule("a.json"), true);
		assert.equal(coalescer.schedule("a.json"), false);
		t.mock.timers.tick(49);
		assert.deepEqual(events, []);
		t.mock.timers.tick(1);
		assert.deepEqual(events, ["a.json"]);
		assert.equal(coalescer.schedule("a.json"), true);
		t.mock.timers.tick(50);
		assert.deepEqual(events, ["a.json", "a.json"]);
	});

	it("allows different files to schedule independently", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const events: string[] = [];
		const coalescer = createFileCoalescer((file) => events.push(file), 50);
		coalescer.schedule("a.json");
		coalescer.schedule("b.json");
		t.mock.timers.tick(50);
		assert.deepEqual(events.sort(), ["a.json", "b.json"]);
	});

	it("clear cancels all pending handlers", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const events: string[] = [];
		const coalescer = createFileCoalescer((file) => events.push(file), 50);
		coalescer.schedule("a.json");
		coalescer.schedule("b.json");
		coalescer.clear();
		t.mock.timers.tick(50);
		assert.deepEqual(events, []);
		assert.equal(coalescer.schedule("a.json"), true, "clear also releases the dedupe key");
		t.mock.timers.tick(50);
		assert.deepEqual(events, ["a.json"]);
	});
});
