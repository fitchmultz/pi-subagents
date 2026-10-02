import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ASYNC_DIR, SLASH_SUBAGENT_REQUEST_EVENT, SLASH_SUBAGENT_RESPONSE_EVENT } from "../../src/shared/types.ts";
import { PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT } from "../../src/slash/prompt-template-bridge.ts";
import { createSupervisorQuestion, QUESTIONS_DIR, saveQuestionOwner, saveQuestionContract } from "../../src/runs/shared/supervisor-questions.ts";
import { OWNED_RUN_ENTRY, saveForegroundRun } from "../../src/runs/shared/run-records.ts";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	SettingsManager,
	SessionManager,
	type AgentSession,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { createMockPi, createTempDir, removeTempDir } from "../support/helpers.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(projectRoot, "src/extension/index.ts");

async function withSdkSession(
	options: Pick<CreateAgentSessionOptions, "tools" | "excludeTools" | "sessionManager" | "settingsManager">,
	check: (session: AgentSession, events: ReturnType<typeof createEventBus>) => Promise<void> | void,
): Promise<void> {
	const agentDir = createTempDir("pi-subagent-sdk-tools-");
	const events = createEventBus();
	const resourceLoader = new DefaultResourceLoader({
		eventBus: events,
		cwd: projectRoot,
		agentDir,
		additionalExtensionPaths: [extensionPath],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: projectRoot,
		agentDir,
		resourceLoader,
		sessionManager: SessionManager.inMemory(projectRoot),
		model: getModel("openai", "gpt-4o-mini"),
		...options,
	});
	try {
		await session.bindExtensions({ mode: "print" });
		await check(session, events);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		removeTempDir(agentDir);
	}
}

function activeTool(session: AgentSession, name: string) {
	return session.agent.state.tools.find((tool) => tool.name === name);
}

describe("subagent lazy activation with SDK tool filters", () => {
	it("keeps controls active when an allowlist filters out their loader", async () => {
		for (const name of ["subagent", "agent_runs"]) await withSdkSession({ tools: [name] }, (session) => {
			assert.deepEqual(session.getAllTools().map((tool) => tool.name), [name]);
			assert.deepEqual(session.getActiveToolNames(), [name]);
		});
	});

	it("honors native fresh defaults and explicit selection without startup deactivation", async () => {
		for (const [options, expected] of [
			[{ tools: ["read", "load_subagent", "subagent"] }, ["load_subagent", "read", "subagent"]],
			[{ settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "load_subagent", "subagent"] }) }, ["delegate", "load_subagent", "read", "subagent"]],
		] as const) await withSdkSession(options, (session) => {
			assert.deepEqual(session.getActiveToolNames().sort(), expected);
		});
	});

	it("restores initial SDK saved activation without widening an explicit tool restriction", async () => {
		const saved = SessionManager.inMemory(projectRoot);
		await withSdkSession({ sessionManager: saved }, async (session) => {
			await activeTool(session, "load_subagent")!.execute("load-saved", {}, new AbortController().signal);
			// Native tool selection is persisted in system messages at a turn boundary.
			saved.appendMessage({ role: "system", content: "", timestamp: 0,
				toolsAdded: session.agent.state.tools.filter((tool) => ["subagent", "agent_runs"].includes(tool.name))
					.map(({ name, description, parameters }) => ({ name, description, parameters })) });
		});
		await withSdkSession({ sessionManager: saved }, async (session) => {
			assert.ok(activeTool(session, "subagent"), "official initial SDK resume must recover declared advanced tools");
			session.setActiveToolsByName(["read", "delegate", "load_subagent"]);
			await session.reload();
			assert.equal(activeTool(session, "subagent"), undefined, "reload retains native current selection rather than replaying our startup fallback");
		});
		await withSdkSession({ sessionManager: saved, tools: ["read", "load_subagent"] }, (session) => {
			assert.equal(activeTool(session, "subagent"), undefined);
			assert.equal(activeTool(session, "agent_runs"), undefined);
			assert.deepEqual(session.getActiveToolNames().sort(), ["load_subagent", "read"]);
		});
	});

	it("fails clearly when an allowlist or denylist filters out subagent", async () => {
		for (const options of [{ tools: ["load_subagent"] }, { excludeTools: ["subagent"] }]) {
			await withSdkSession(options, async (session) => {
				const loader = activeTool(session, "load_subagent");
				assert.ok(loader);
				await assert.rejects(
					loader.execute("load", {}, new AbortController().signal),
					/full tool is excluded from this session/,
				);
				assert.equal(session.getActiveToolNames().includes("subagent"), false);
			});
		}
	});

	it("exposes compact tools without strict sampling that rejects bounded integers on Anthropic", async () => {
		await withSdkSession({}, async (session) => {
			const delegate = activeTool(session, "delegate");
			assert.ok(delegate);
			assert.equal(delegate.constrainedSampling, undefined);
			assert.equal(activeTool(session, "agent_runs"), undefined);
			await activeTool(session, "load_subagent")!.execute("load-controls", { advanced: false }, new AbortController().signal);
			const runs = activeTool(session, "agent_runs");
			assert.ok(runs);
			assert.equal(runs.constrainedSampling, undefined);
			const profiles = await runs.execute("profiles", { action: "profiles" }, new AbortController().signal);
			assert.match(JSON.stringify(profiles.content), /Executable agents/);
			assert.equal(session.getActiveToolNames().includes("subagent"), false);
		});
	});

	it("delegates through the same executor and isolates a single writer on request", async () => {
		const repo = createTempDir("pi-compact-delegate-");
		const mock = createMockPi();
		mock.install();
		try {
			fs.mkdirSync(path.join(repo, ".pi/agents"), { recursive: true });
			fs.writeFileSync(path.join(repo, ".pi/agents/compact-probe.md"), "---\nname: compact-probe\ndescription: Compact tool test\nmodel: openai/gpt-6-astra\n---\nReturn the requested answer.\n");
			execFileSync("git", ["init", "-q", repo]);
			execFileSync("git", ["-C", repo, "add", "."]);
			execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
			await withSdkSession({}, async (session, events) => {
				const delegate = activeTool(session, "delegate");
				assert.ok(delegate);
				assert.equal(activeTool(session, "agent_runs"), undefined);
				const invalid = await delegate.execute("invalid", { agent: "__missing__", task: "Do not launch", cwd: repo }, new AbortController().signal);
				assert.equal(invalid.isError, true);
				assert.equal(activeTool(session, "agent_runs"), undefined);
				for (const route of ["delegate", "worktree", "subagent", "slash", "template"]) {
					const worktree = route === "worktree";
					mock.reset();
					mock.onCall({ output: "COMPACT_DONE" });
					if (route === "subagent") await activeTool(session, "load_subagent")!.execute("advanced", {}, new AbortController().signal);
					session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "agent_runs"));
					const params = { agent: "compact-probe", task: "Report completion", cwd: repo, async: false, ...(worktree ? { worktree: true } : {}), output: false };
					const result = route === "slash" || route === "template"
						? await new Promise((resolve, reject) => {
							const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`No ${route} response`)); }, 10_000);
							const unsubscribe = events.on(route === "slash" ? SLASH_SUBAGENT_RESPONSE_EVENT : PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (response) => { clearTimeout(timeout); unsubscribe(); resolve(response); });
							events.emit(route === "slash" ? SLASH_SUBAGENT_REQUEST_EVENT : PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
								route === "slash" ? { requestId: route, params } : { requestId: route, ...params, context: "fresh", model: "openai/gpt-6-astra" });
						})
						: await activeTool(session, route === "subagent" ? "subagent" : "delegate")!.execute(route, params, new AbortController().signal);
					assert.match(JSON.stringify(result), /COMPACT_DONE/);
					assert.ok(activeTool(session, "agent_runs"), "real launches expose controls before the next request");
					const callFile = fs.readdirSync(mock.dir).find((name) => name.startsWith("call-"));
					assert.ok(callFile);
					const call = JSON.parse(fs.readFileSync(path.join(mock.dir, callFile), "utf8"));
					assert.equal(call.cwd === fs.realpathSync(repo), !worktree);
					assert.equal(mock.callCount(), 1);
				}
			});
		} finally {
			mock.uninstall();
			removeTempDir(repo);
		}
	});

	it("compact and compatibility tools share durable questions, answers, ownership, and validation", async () => {
		await withSdkSession({}, async (session) => {
			const runId = `sdk-question-${Date.now()}`;
			saveQuestionOwner(runId, session.sessionManager.getSessionId());
			const question = createSupervisorQuestion({ runId, ownerTarget: "supervisor", agent: "worker", index: 0, childSessionId: "sdk-child", childTarget: "sdk-child-target", sessionFile: path.join(ASYNC_DIR, runId, "session.jsonl"), cwd: projectRoot, pid: process.pid, reason: "need_decision", message: "Which path?" });
			try {
				await activeTool(session, "load_subagent")!.execute("load", {}, new AbortController().signal);
				const compact = activeTool(session, "agent_runs")!;
				const compatible = activeTool(session, "subagent")!;
				const params = { action: "answer", id: runId, questionId: question.questionId, message: "Use the current path." };
				const first = await compact.execute("answer", params, new AbortController().signal);
				const repeated = await compatible.execute("repeat", params, new AbortController().signal);
				assert.deepEqual(first.details.questions, repeated.details.questions);
				for (const tool of [compact, compatible]) {
					const listed = await tool.execute("questions", { action: "questions", id: runId }, new AbortController().signal);
					assert.equal(listed.details.questions[0].state, "answer_pending");
					const conflict = await tool.execute("conflict", { ...params, message: "Use another path." }, new AbortController().signal);
					assert.equal("isError" in conflict && conflict.isError, true);
					assert.match(JSON.stringify(conflict.content), /different saved answer/);
					const missing = await tool.execute("missing", { ...params, questionId: undefined }, new AbortController().signal);
					assert.equal("isError" in missing && missing.isError, true);
					assert.match(JSON.stringify(missing.content), /questionId/);
					const blank = await tool.execute("blank", { ...params, message: " " }, new AbortController().signal);
					assert.equal("isError" in blank && blank.isError, true);
					assert.match(JSON.stringify(blank.content), /non-empty message/);
				}
				saveQuestionOwner(`${runId}-other`, "other-supervisor");
				const other = createSupervisorQuestion({ ...question, runId: `${runId}-other` });
				const wrongOwner = await compact.execute("wrong-owner", { ...params, id: other.runId, questionId: other.questionId }, new AbortController().signal);
				assert.equal("isError" in wrongOwner && wrongOwner.isError, true);
				assert.match(JSON.stringify(wrongOwner.content), /owning supervisor session/);
			} finally {
				fs.rmSync(path.join(QUESTIONS_DIR, runId), { recursive: true, force: true });
				fs.rmSync(path.join(QUESTIONS_DIR, `${runId}-other`), { recursive: true, force: true });
			}
		});
	});

	it("registered history and search retain owned paging, validated input and reload through both tool routes", async () => {
		const directory = createTempDir("pi-subagents-history-tools-");
		const parent = SessionManager.inMemory(projectRoot), child = SessionManager.create(projectRoot, directory);
		const runId = `history-${parent.getSessionId()}`;
		try {
			for (let number = 0; number < 140; number++) child.appendMessage({ role: "user", content: number === 10 ? "uniqueregisteredword saved evidence" : `Saved activity ${number}`, timestamp: Date.now() });
			const source = child.getSessionFile()!;
			saveQuestionOwner(runId, parent.getSessionId());
			saveQuestionContract(runId, 0, { task: "Read-only archive", sessionFile: source });
			saveForegroundRun({ runId, mode: "single", cwd: projectRoot, results: [{ agent: "worker", task: "Read-only archive", sessionFile: source, exitCode: 0, finalOutput: "Saved result", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] });
			parent.appendCustomEntry(OWNED_RUN_ENTRY, { runId, rootRunId: runId, ownerSessionId: parent.getSessionId(), source: "foreground", mode: "single", cwd: projectRoot, task: "Read-only archive", startedAt: Date.now(), children: [{ agent: "worker", index: 0, sessionFile: source }] });
			const before = fs.readFileSync(source);
			await withSdkSession({ sessionManager: parent }, async (session) => {
				await activeTool(session, "load_subagent")!.execute("load-history", {}, new AbortController().signal);
				for (const name of ["agent_runs", "subagent"]) {
					const tool = activeTool(session, name)!;
					let result;
					const deadline = Date.now() + 10_000;
					do {
						result = await tool.execute("history", { action: "history", id: runId, index: 0, limit: 10 }, new AbortController().signal);
						if (result.details.history?.freshness.state === "current") break;
						assert.ok(Date.now() < deadline, "registered history catches up without a filesystem fallback");
						await new Promise((resolve) => setTimeout(resolve, 10));
					} while (true);
					assert.equal(result.details.history.count, 140);
					assert.equal(result.details.history.entries.length, 10);
					assert.equal(result.details.history.freshness.authoritative, false);
					const earlier = await tool.execute("earlier", { action: "history", id: runId, index: 0, limit: 10, cursor: result.details.history.previousCursor }, new AbortController().signal);
					assert.notEqual(earlier.details.history.entries[0].id, result.details.history.entries[0].id);
					const search = await tool.execute("search", { action: "search", query: "uniqueregisteredword", limit: 1 }, new AbortController().signal);
					assert.equal(search.details.historySearch.matches.length, 1);
					assert.equal(search.details.historySearch.matches[0].runId, runId);
					const denied = await tool.execute("foreign", { action: "history", id: "not-owned", index: 0 }, new AbortController().signal);
					assert.equal(denied.isError, true);
					const invalid = await tool.execute("grammar", { action: "search", query: "word*" }, new AbortController().signal);
					assert.equal(invalid.isError, true);
					assert.match(JSON.stringify(invalid.content), /operators, punctuation, and prefixes/);
				}
				await session.reload();
				const restored = await activeTool(session, "agent_runs")!.execute("restored-search", { action: "search", id: runId, query: "uniqueregisteredword" }, new AbortController().signal);
				assert.equal(restored.details.historySearch.matches[0].runId, runId);
			});
			assert.deepEqual(fs.readFileSync(source), before, "browse transport never rewrites the native source");
		} finally {
			fs.rmSync(path.join(QUESTIONS_DIR, runId), { recursive: true, force: true });
			removeTempDir(directory);
		}
	});

	it("enables the available full tool through Pi's public active-tool API",  async () => {
		await withSdkSession({}, async (session) => {
			assert.equal(session.getActiveToolNames().includes("subagent"), false);
			const loader = activeTool(session, "load_subagent");
			assert.ok(loader);
			const result = await loader.execute("load", {}, new AbortController().signal);
			assert.match(JSON.stringify(result.content), /Subagent enabled/);
			assert.equal(session.getActiveToolNames().includes("subagent"), true);
			const repeated = await loader.execute("load-again", {}, new AbortController().signal);
			assert.match(JSON.stringify(repeated.content), /Subagent already enabled/);
			assert.equal(session.getActiveToolNames().filter(name => name === "subagent").length, 1);
		});
	});
});
