import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import type { ForegroundResumeRun, OwnedRun, SubagentState } from "../../src/shared/types.ts";

it("bounds ambiguous run previews without losing history or exact and unique-prefix lookup", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-ambiguity-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousTempRoot = process.env.PI_SUBAGENT_TEMP_ROOT;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
	try {
		const { resolveOwnedRun } = await import("../../src/runs/shared/run-records.ts");
		const { resolveRememberedForegroundRun } = await import("../../src/runs/foreground/foreground-control.ts");
		const { resolveAsyncRunLocation } = await import("../../src/runs/background/async-resume.ts");
		const { resolveSubagentRunId } = await import("../../src/runs/background/run-id-resolver.ts");
		const state: SubagentState = {
			baseCwd: root, currentSessionId: "parent", asyncJobs: new Map(), ownedRuns: new Map(), foregroundRuns: new Map(),
			cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null,
			watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
		};
		const asyncDirRoot = path.join(root, "runs"), resultsDir = path.join(root, "results");
		fs.mkdirSync(asyncDirRoot);
		fs.mkdirSync(resultsDir);
		const resolvers = [
			(id: string) => resolveOwnedRun(state, id)?.runId,
			(id: string) => resolveRememberedForegroundRun(id, state)?.runId,
			(id: string) => resolveAsyncRunLocation({ id }, asyncDirRoot, resultsDir).resolvedId,
			(id: string) => resolveSubagentRunId(id, { state, asyncDirRoot, resultsDir })?.id,
		];
		const add = (id: string, index: number) => {
			const owned: OwnedRun = { runId: id, rootRunId: id, ownerSessionId: "parent", source: "foreground", mode: "single", cwd: root, task: "Saved assignment", startedAt: index, children: [] };
			const foreground: ForegroundResumeRun = { runId: id, mode: "single", cwd: root, updatedAt: index, children: [] };
			state.ownedRuns!.set(id, owned);
			state.foregroundRuns!.set(id, foreground);
			fs.writeFileSync(path.join(resultsDir, `${id}.json`), JSON.stringify({ id, output: `Saved result ${index}` }));
		};
		const ids = Array.from({ length: 2000 }, (_, index) => `a${String(index).padStart(4, "0")}-0000-0000-0000-000000000000`);
		for (const [index, id] of ids.entries()) {
			add(id, index);
			if (index !== 999 && index !== 1999) continue;
			for (const resolve of resolvers) {
				assert.throws(() => resolve("a"), (error: unknown) => {
					assert.ok(error instanceof Error);
					assert.ok(error.message.length < 600, `ambiguity expanded to ${error.message.length} characters`);
					assert.match(error.message, new RegExp(`${index + 1} matches`));
					assert.match(error.message, /showing 5/);
					assert.match(error.message, /longer prefix or full run id/);
					assert.ok(error.message.includes(ids[0]!));
					assert.ok(!error.message.includes(ids[5]!));
					return true;
				});
				assert.equal(resolve(id), id, "exact IDs outside the preview remain accessible");
				assert.equal(resolve(id.slice(0, -1)), id, "unique prefixes outside the preview remain accessible");
			}
		}
		add("a", 2000);
		for (const resolve of resolvers) assert.equal(resolve("a"), "a", "exact IDs take precedence over thousands of prefix matches");
		assert.equal(resolveOwnedRun(state, "latest")?.runId, "a");
		assert.equal(resolveRememberedForegroundRun("last", state)?.runId, "a");
		assert.equal(state.ownedRuns!.size, 2001);
		assert.equal(state.foregroundRuns!.size, 2001);
		assert.equal(fs.readdirSync(resultsDir).length, 2001);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(resultsDir, `${ids[1999]}.json`), "utf8")), { id: ids[1999], output: "Saved result 1999" });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousTempRoot === undefined) delete process.env.PI_SUBAGENT_TEMP_ROOT;
		else process.env.PI_SUBAGENT_TEMP_ROOT = previousTempRoot;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
