import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cancelSupervisorQuestion, claimQuestionRevival, createSupervisorQuestion, listSupervisorQuestions, readQuestionState, recordQuestionDelivery, saveQuestionAnswer, saveQuestionOwner } from "../../src/runs/shared/supervisor-questions.ts";
import { ReplyTracker } from "../../src/pi-intercom/reply-tracker.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-supervisor-question-"));
	saveQuestionOwner("run-1", "owner-session", root);
	const question = createSupervisorQuestion({ runId: "run-1", ownerTarget: "owner-target", agent: "worker", index: 0, childSessionId: "child-session", childTarget: "child-target", sessionFile: path.join(root, "session.jsonl"), cwd: root, pid: process.pid, reason: "need_decision", message: "Which API?" }, root);
	return { root, question };
}

test("questions and immutable answers survive fresh reads, reject conflicting duplicates, and claim one revival", () => {
	const { root, question } = fixture();
	try {
		assert.equal(listSupervisorQuestions("owner-session", "run", root)[0]?.state, "awaiting_input");
		assert.deepEqual(listSupervisorQuestions("other-session", undefined, root), []);
		assert.throws(() => listSupervisorQuestions("owner-session", "../run", root), /Invalid run/);
		assert.throws(() => saveQuestionAnswer(question, " ", root), /non-empty/);
		const first = saveQuestionAnswer(question, "Use stable.", root);
		assert.deepEqual(saveQuestionAnswer(question, "Use stable.", root), first);
		assert.throws(() => saveQuestionAnswer(question, "Use experimental.", root), /different saved answer/);
		assert.equal(readQuestionState(question, root).state, "answer_pending");
		const firstClaim = claimQuestionRevival(question, root);
		assert.equal(firstClaim.claimed, true);
		assert.deepEqual(claimQuestionRevival(question, root), { claimed: false, runId: firstClaim.runId });
		recordQuestionDelivery(question, { kind: "revive", runId: firstClaim.runId, deliveredAt: 100 }, root);
		assert.equal(listSupervisorQuestions("owner-session", "run-1", root)[0]?.state, "answered");
		assert.equal(fs.statSync(path.join(root, "run-1", "questions", question.questionId, "answer.json")).mode & 0o777, 0o600);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("migrated questions keep an old waiter working and survive deletion of temporary storage", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-question-migration-"));
	try {
		const moduleUrl = new URL("../../src/runs/shared/supervisor-questions.ts", import.meta.url).href;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import path from "node:path";
			const q = await import(${JSON.stringify(moduleUrl)});
			const legacy = path.join(process.env.PI_SUBAGENT_TEMP_ROOT, "supervisor-questions");
			const input = { ownerTarget: "owner", agent: "worker", index: 0, childSessionId: "child", childTarget: "child", sessionFile: path.join(process.env.HOME, "child.jsonl"), cwd: process.env.HOME, pid: process.pid, reason: "need_decision", message: "Which API?" };
			q.saveQuestionOwner("migration-owned", "owner", legacy);
			const question = q.createSupervisorQuestion({ ...input, runId: "migration-owned" }, legacy);
			q.saveQuestionOwner("migration-foreign", "another-parent", legacy);
			q.createSupervisorQuestion({ ...input, runId: "migration-foreign" }, legacy);
			assert.equal(q.listSupervisorQuestions("owner").length, 1);
			q.saveQuestionAnswer(question, "Stable API");
			assert.equal(q.readQuestionState(question, legacy).answer.message, "Stable API");
			q.recordQuestionDelivery(question, { kind: "live", runId: question.runId, deliveredAt: Date.now() }, legacy);
			assert.equal(q.listSupervisorQuestions("owner")[0].state, "answered");
			fs.rmSync(process.env.PI_SUBAGENT_TEMP_ROOT, { recursive: true, force: true });
			assert.equal(q.listSupervisorQuestions("owner")[0]?.state, "answered", "answered questions must survive temporary storage cleanup");
		`], { env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime") }, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cancelled supervisor questions cannot silently revive", () => {
	const { root, question } = fixture();
	try {
		cancelSupervisorQuestion(question, root);
		assert.equal(readQuestionState(question, root).state, "cancelled");
		assert.throws(() => saveQuestionAnswer(question, "Continue", root), /cancelled/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("ordinary asks expire but a durable supervisor question remains replyable after lunch", () => {
	const tracker = new ReplyTracker(120_000);
	const from = { id: "child", name: "worker", cwd: "/tmp", model: "test" };
	tracker.recordIncomingMessage(from, { id: "ordinary", timestamp: 1, expectsReply: true, content: { text: "Hi?" } }, 1);
	tracker.recordIncomingMessage(from, { id: "durable", timestamp: 1, expectsReply: true, content: { text: "Subagent needs a supervisor decision.\nQuestion ID: durable" } }, 1);
	assert.deepEqual(tracker.listPending(3_600_000).map((entry) => entry.message.id), ["durable"]);
	assert.equal(tracker.resolveReplyTarget({}, 3_600_000).message.id, "durable");
	tracker.markReplied("durable");
	assert.deepEqual(tracker.listPending(3_600_000), []);
});
