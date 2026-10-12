import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { spawnSync, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  claimQuestionRevival,
  createSupervisorQuestion,
  listSupervisorQuestions,
  listRunQuestions,
  readQuestionOwner,
  readQuestionContract,
  readQuestionState,
  recordQuestionDelivery,
  saveQuestionAnswer,
  saveQuestionContract,
  saveQuestionOwner,
} from "../../src/runs/shared/supervisor-questions.ts";
import { json, assertDefined } from "../support/assertions.ts";
import type { SavedLaunchConfig } from "../../src/shared/types.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-supervisor-question-"));
  saveQuestionOwner("run-1", "owner-session", root);
  const question = createSupervisorQuestion(
    {
      runId: "run-1",
      ownerTarget: "owner-target",
      agent: "worker",
      index: 0,
      childSessionId: "child-session",
      childTarget: "child-target",
      sessionFile: path.join(root, "session.jsonl"),
      cwd: root,
      pid: process.pid,
      reason: "need_decision",
      message: "Which API?",
    },
    root,
  );
  return { root, question };
}

test("owner reads preserve values with snapshot-sized scratch and a 64 KiB ceiling", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "run-1", "question-owner.json"),
    read = fs.readSync;
  const scratch: number[] = [];
  t.mock.method(
    fs,
    "readSync",
    (fd: number, bytes: Buffer, offset: number, length: number, position: number | null) => {
      scratch.push(bytes.length);
      return read(fd, bytes, offset, length, position);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const owner = '{"sessionId":"owner-🦄"}';
  fs.writeFileSync(file, owner);
  assert.deepEqual(readQuestionOwner("run-1", root), { sessionId: "owner-🦄" });
  assert.deepEqual(scratch, [Buffer.byteLength(owner)], "scratch is bounded by the fd snapshot");
  fs.writeFileSync(file, '{"sessionId":"owner"}'.padEnd(70_000));
  assert.deepEqual(readQuestionOwner("run-1", root), { sessionId: "owner" });
  assert.equal(scratch.at(-1), 65_536, "larger owner reads retain the chunk ceiling");
});

test("owner-scoped questions trust validated embedded ownership before opening foreign state", (t) => {
  const { root, question } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const foreign = { ...question, questionId: "foreign", ownerSessionId: "other-session" },
    foreignDir = path.join(root, question.runId, "questions", foreign.questionId),
    selectedDir = path.join(root, question.runId, "questions", question.questionId),
    ownerFile = path.join(root, question.runId, "question-owner.json");
  fs.mkdirSync(foreignDir);
  fs.writeFileSync(path.join(foreignDir, "question.json"), JSON.stringify(foreign));
  for (const file of ["answer.json", "delivery.json", "revival.json", "cancelled.json"]) {
    fs.writeFileSync(path.join(foreignDir, file), "{");
  }
  saveQuestionAnswer(question, "Selected answer.", root);
  const open = fs.openSync,
    opened: string[] = [];
  t.mock.method(fs, "openSync", (...args: Readonly<Parameters<typeof fs.openSync>>) => {
    opened.push(String(args[0]));
    return Reflect.apply(open, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal(listSupervisorQuestions("owner-session", "run-1", root)[0]?.state, "answer_pending");
  assert.deepEqual(
    opened.filter((file) => file.startsWith(foreignDir)),
    [path.join(foreignDir, "question.json")],
    "foreign state is not opened, even when corrupt",
  );
  assert.equal(opened.filter((file) => file.startsWith(selectedDir)).length, 5);
  for (const metadata of [undefined, "{", '{"sessionId":"other-session"}']) {
    if (metadata === undefined) {
      fs.unlinkSync(ownerFile);
    } else {
      fs.writeFileSync(ownerFile, metadata);
    }
    assert.equal(
      listSupervisorQuestions("owner-session", "run-1", root)[0]?.questionId,
      question.questionId,
    );
  }
  assert.throws(() => listRunQuestions(path.join(root, "run-1")), SyntaxError);
  assert.throws(() => listSupervisorQuestions("other-session", "run-1", root), SyntaxError);
  for (const file of ["answer.json", "delivery.json", "revival.json", "cancelled.json"]) {
    fs.writeFileSync(path.join(selectedDir, file), "{");
    assert.throws(() => listSupervisorQuestions("owner-session", "run-1", root), SyntaxError);
    fs.unlinkSync(path.join(selectedDir, file));
  }
  fs.writeFileSync(
    path.join(foreignDir, "question.json"),
    JSON.stringify({ ...foreign, ownerSessionId: 7 }),
  );
  assert.throws(
    () => listSupervisorQuestions("owner-session", "run-1", root),
    /Invalid supervisor question/,
    "even foreign question records must validate before their owner is used",
  );
  fs.writeFileSync(path.join(foreignDir, "question.json"), JSON.stringify(foreign));
  recordQuestionDelivery(question, { kind: "live", runId: question.runId, deliveredAt: 100 }, root);
  assert.equal(listSupervisorQuestions("owner-session", "run-1", root)[0]?.state, "answered");
});

test("questions and immutable answers survive fresh reads, reject conflicting duplicates, and claim one revival", () => {
  const { root, question } = fixture();
  try {
    assert.equal(listSupervisorQuestions("owner-session", "run", root)[0]?.state, "awaiting_input");
    assert.deepEqual(listSupervisorQuestions("other-session", undefined, root), []);
    assert.throws(() => listSupervisorQuestions("owner-session", "../run", root), /Invalid run/);
    assert.throws(() => saveQuestionAnswer(question, " ", root), /non-empty/);
    const first = saveQuestionAnswer(question, "Use stable.", root);
    assert.deepEqual(saveQuestionAnswer(question, "Use stable.", root), first);
    assert.throws(
      () => saveQuestionAnswer(question, "Use experimental.", root),
      /different saved answer/,
    );
    assert.equal(readQuestionState(question, root).state, "answer_pending");
    const firstClaim = claimQuestionRevival(question, root);
    assert.equal(firstClaim.claimed, true);
    assert.deepEqual(claimQuestionRevival(question, root), {
      claimed: false,
      runId: firstClaim.runId,
    });
    recordQuestionDelivery(
      question,
      { kind: "revive", runId: firstClaim.runId, deliveredAt: 100 },
      root,
    );
    assert.equal(listSupervisorQuestions("owner-session", "run-1", root)[0]?.state, "answered");
    assert.equal(
      fs.statSync(path.join(root, "run-1", "questions", question.questionId, "answer.json")).mode &
        0o777,
      0o600,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrated questions keep an old waiter working and survive deletion of temporary storage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-question-migration-"));
  try {
    const moduleUrl = new URL("../../src/runs/shared/supervisor-questions.ts", import.meta.url)
      .href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
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
			fs.mkdirSync(path.join(legacy, "broken-foreign"), { recursive: true });
			fs.writeFileSync(path.join(legacy, "broken-foreign", "question-owner.json"), "{");
			assert.equal(q.listOwnedRunQuestions("owner", "migration-owned").length, 1, "exact UI access migrates the known legacy run");
			assert.equal(q.listOwnedRunQuestions("owner", "migration-foreign").length, 0);
			assert.equal(q.listSupervisorQuestions("owner").length, 1);
			assert.throws(() => q.migrateSupervisorQuestions("owner", "broken-foreign"), SyntaxError, "targeted corrupt metadata remains a failure");
			fs.mkdirSync(path.join(q.QUESTIONS_DIR, "broken-question", "questions", "question"), { recursive: true });
			fs.writeFileSync(path.join(q.QUESTIONS_DIR, "broken-question", "questions", "question", "question.json"), "{");
			assert.equal(q.listSupervisorQuestions("owner").length, 1, "unrelated malformed questions do not hide the healthy owner's question");
			assert.throws(() => q.listSupervisorQuestions("owner", "broken-question"), SyntaxError);
			q.saveQuestionAnswer(question, "Stable API");
			assert.equal(q.readQuestionState(question, legacy).answer.message, "Stable API");
			q.recordQuestionDelivery(question, { kind: "live", runId: question.runId, deliveredAt: Date.now() }, legacy);
			assert.equal(q.listSupervisorQuestions("owner")[0].state, "answered");
			fs.rmSync(process.env.PI_SUBAGENT_TEMP_ROOT, { recursive: true, force: true });
			assert.equal(q.listSupervisorQuestions("owner")[0]?.state, "answered", "answered questions must survive temporary storage cleanup");
		`,
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          PI_CODING_AGENT_DIR: path.join(root, "agent"),
          PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native selection is projected without rewriting frozen launch or racing owner updates", () => {
  const { root, question } = fixture();
  try {
    const launch: SavedLaunchConfig = {
      agent: {
        name: "worker",
        description: "Worker",
        systemPromptMode: "append",
        inheritProjectContext: false,
        inheritSkills: false,
        systemPrompt: "saved",
        source: "user",
        filePath: "worker.md",
      },
      model: "provider/original",
      thinking: "low",
      modelCandidates: ["provider/original"],
      artifacts: false,
      share: false,
      systemPrompt: "saved",
      skills: [],
      cwd: root,
      context: "fresh",
      output: false,
      outputMode: "inline",
    };
    const outputSchema = {
      type: "object",
      properties: {
        messages: { type: "string" },
        summary: { const: "x".repeat(9000) },
        output: { type: "string" },
        ["long".repeat(1250)]: { type: "boolean" },
      },
      required: ["messages"],
    };
    const frozenLaunch = { ...launch, outputSchema };
    saveQuestionContract(
      question.runId,
      0,
      { launch: frozenLaunch, outputSchema, sessionFile: question.sessionFile, pid: 123 },
      root,
    );
    fs.writeFileSync(
      question.sessionFile,
      [
        { type: "session", version: 3, id: "child", cwd: root, timestamp: "2026-01-01T00:00:00Z" },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          provider: "provider",
          modelId: "current",
          timestamp: "2026-01-01T00:01:00Z",
        },
        {
          type: "thinking_level_change",
          id: "thinking",
          parentId: "model",
          thinkingLevel: "high",
          timestamp: "2026-01-01T00:02:00Z",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const file = path.join(root, question.runId, "contracts", "0.json");
    const legacy = json(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...legacy, recordVersion: 2 }));
    fs.truncateSync(question.sessionFile, fs.statSync(question.sessionFile).size - 1);
    const recovered = readQuestionContract(question.runId, 0, root);
    assertDefined(recovered);
    assert.equal(recovered.launch?.model, "provider/current");
    assert.equal(
      recovered.launch.thinking,
      "low",
      "legacy recovery cannot publish a native thinking change without LF",
    );
    assert.deepEqual(json(fs.readFileSync(file, "utf8")).effectiveConfiguration, {
      model: "provider/current",
      modelRecordedAt: Date.parse("2026-01-01T00:01:00Z"),
    });
    fs.appendFileSync(question.sessionFile, "\n");
    saveQuestionContract(
      question.runId,
      0,
      {
        effectiveConfiguration: { model: "provider/current", thinking: "high" },
        terminalLeafId: "thinking",
      },
      root,
    );
    const before = fs.readFileSync(file, "utf8");
    // Ordinary controls use the captured native selection, even after a
    // successor changes the journal or its locator becomes unreadable.
    fs.unlinkSync(question.sessionFile);
    fs.mkdirSync(question.sessionFile);
    const projected = readQuestionContract(question.runId, 0, root);
    assertDefined(projected);
    assert.equal(projected.launch?.model, "provider/current");
    assert.equal(projected.launch.thinking, "high");
    assert.equal(projected.launch.output, false);
    assert.equal(projected.launch.agent.inheritSkills, false);
    assert.deepEqual(projected.outputSchema, outputSchema);
    assert.deepEqual(
      projected.launch.outputSchema,
      outputSchema,
      "continuation's frozen schema is complete even when its properties use transcript/output field names",
    );
    assert.equal(fs.readFileSync(file, "utf8"), before);
    saveQuestionContract(question.runId, 0, { pid: 456, updatedAt: 10 }, root);
    const afterOwnerUpdate = fs.readFileSync(file, "utf8");
    const created = createSupervisorQuestion(
      { ...question, pid: process.pid, message: "Keep current model?" },
      root,
    );
    assert.equal(created.launch?.model, "provider/current");
    assert.equal(created.pid, process.pid);
    assert.equal(fs.readFileSync(file, "utf8"), afterOwnerUpdate);
    assert.deepEqual(json(afterOwnerUpdate).launch, frozenLaunch);
    assert.deepEqual(json(afterOwnerUpdate).effectiveConfiguration, {
      model: "provider/current",
      thinking: "high",
    });
    assert.equal(readQuestionContract(question.runId, 0, root)?.pid, 456);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contracts without a launch do not read discarded native configuration", () => {
  const { root, question } = fixture();
  try {
    saveQuestionContract(question.runId, 0, { task: "Legacy assignment", sessionFile: root }, root);
    assert.equal(
      readQuestionContract(question.runId, 0, root)?.task,
      "Legacy assignment",
      "a transcript that cannot be read is irrelevant without a launch to project",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent migrated and old waiters agree on one immutable answer and revival claim", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-question-contention-"));
  const moduleUrl = new URL("../../src/runs/shared/supervisor-questions.ts", import.meta.url).href;
  const env = {
    ...process.env,
    HOME: root,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"),
  };
  const setup = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
		import fs from 'node:fs';
		const q = await import(${JSON.stringify(moduleUrl)});
		q.saveQuestionOwner('contended', 'parent', q.LEGACY_QUESTIONS_DIR);
		const question = q.createSupervisorQuestion({ runId: 'contended', ownerTarget: 'parent', agent: 'worker', index: 0, childSessionId: 'child', childTarget: 'child', sessionFile: ${JSON.stringify(path.join(root, "child.jsonl"))}, cwd: process.env.HOME, pid: process.pid, reason: 'need_decision', message: 'Which?' }, q.LEGACY_QUESTIONS_DIR);
		q.migrateSupervisorQuestions('parent');
		fs.writeFileSync(${JSON.stringify(path.join(root, "question.json"))}, JSON.stringify(question));
	`,
    ],
    { env, encoding: "utf8" },
  );
  try {
    assert.equal(setup.status, 0, setup.stderr);
    const contend = (legacy: boolean) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
				import fs from 'node:fs';
				const q = await import(${JSON.stringify(moduleUrl)});
				const question = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "question.json"))}, 'utf8'));
				const root = ${legacy ? "q.LEGACY_QUESTIONS_DIR" : "q.QUESTIONS_DIR"};
				const { syncBuiltinESMExports } = await import('node:module');
				const link = fs.linkSync;
				const handled = new Set();
				const wait = (file) => { const until = Date.now() + 5000; while (!fs.existsSync(file)) { if (Date.now() > until) throw new Error('Claim barrier timed out: ' + file); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } };
				fs.linkSync = (source, target) => {
					const kind = target.endsWith('/answer.json') ? 'answer' : target.endsWith('/revival.json') ? 'revival' : undefined;
					if (!kind || handled.has(kind)) return link(source, target);
					handled.add(kind);
					const barrier = ${JSON.stringify(root)} + '/' + kind;
					if (${legacy}) {
						fs.writeFileSync(barrier + '-old-ready', ''); wait(barrier + '-new-claimed');
						try { return link(source, target); } finally { fs.writeFileSync(barrier + '-old-attempted', ''); }
					}
					wait(barrier + '-old-ready');
					const result = link(source, target); fs.writeFileSync(barrier + '-new-claimed', ''); wait(barrier + '-old-attempted');
					return result;
				};
				syncBuiltinESMExports();
				try { q.saveQuestionAnswer(question, ${JSON.stringify(legacy ? "Old waiter" : "New parent")}, root); } catch (error) { if (!String(error).includes('different saved answer')) throw error; }
				q.claimQuestionRevival(question, root);
			`,
          ],
          { env, stdio: "pipe" },
        );
        child.on("error", reject);
        child.on("close", resolve);
      });
    assert.deepEqual(await Promise.all([contend(true), contend(false)]), [0, 0]);
    const verify = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
			import assert from 'node:assert/strict'; import fs from 'node:fs';
			const q = await import(${JSON.stringify(moduleUrl)});
			const question = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "question.json"))}, 'utf8'));
			q.migrateSupervisorQuestions('parent');
			const legacy = q.readQuestionState(question, q.LEGACY_QUESTIONS_DIR);
			const current = q.readQuestionState(question);
			assert.deepEqual(current.answer, legacy.answer);
			assert.deepEqual(current.revival, legacy.revival);
			fs.rmSync(q.LEGACY_QUESTIONS_DIR, { recursive: true });
			assert.deepEqual(q.readQuestionState(question).answer, legacy.answer);
			assert.deepEqual(q.readQuestionState(question).revival, legacy.revival);
		`,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(verify.status, 0, verify.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
