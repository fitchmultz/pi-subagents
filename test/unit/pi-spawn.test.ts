import assert from "node:assert/strict";
import { test } from "node:test";
import { getPiSpawnCommand } from "../../src/runs/shared/pi-spawn.ts";

test("Pi launches through PATH without a shell or argument rewriting", () => {
	const args = ["--mode", "json", 'Task: review "quotes" & pipes | unchanged'];
	assert.deepEqual(getPiSpawnCommand(args), { command: "pi", args });
});
