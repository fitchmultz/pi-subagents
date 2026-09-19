import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
const { buildPiArgs } = await import(process.env.PI_ARGS_TEST_MODULE
	? pathToFileURL(resolve(process.env.PI_ARGS_TEST_MODULE)).href
	: "../../src/runs/shared/pi-args.ts");

const host = process.env.PI_CONTEXT_TEST_PACKAGE_ROOT ?? dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);

for (const scenario of ["saved", "symlink", "trailing-slash", "missing", "different"] as const) test(`native CLI session cwd: ${scenario}`, async (t) => {
	const evidence = process.env.PI_INTERCOM_TEST_EVIDENCE_DIR;
	if (evidence) mkdirSync(evidence, { recursive: true });
	const root = realpathSync(mkdtempSync(join(evidence ?? tmpdir(), "pi-same-cwd-cli-")));
	const sessionFile = join(root, "saved.jsonl");
	const output = join(root, "observed.json");
	mkdirSync(join(root, "agent"));
	mkdirSync(join(root, "launch"));
	const timestamp = "2026-09-18T00:00:00Z";
	const bytes = [
		{ type: "session", version: 3, id: "same-cwd-fixture", timestamp, cwd: root },
		{ type: "model_change", id: "model", parentId: null, timestamp, provider: "faux", modelId: "faux-1" },
		{ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp, thinkingLevel: "off" },
		{ type: "message", id: "user", parentId: "thinking", timestamp, message: { role: "user", content: "Saved history", timestamp: 0 } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	if (scenario !== "missing") writeFileSync(sessionFile, bytes);
	const alias = join(root, "alias");
	if (scenario === "symlink") symlinkSync(root, alias, "dir");
	const cwd = scenario === "different" ? join(root, "launch") : scenario === "symlink" ? alias : scenario === "trailing-slash" ? `${root}/` : root;
	const extension = join(root, "observer.ts");
	writeFileSync(extension, `import { writeFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
export default function (pi) {
	const faux = fauxProvider();
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(${JSON.stringify(output)}, JSON.stringify({ cwd: ctx.cwd, id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }));
		ctx.shutdown();
	});
	pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(join(root, "calls.txt"))}, String(faux.state.callCount)));
}`);
	function launch() {
		const built = buildPiArgs({ baseArgs: ["--mode", "rpc", "--offline", "--no-prompt-templates", "--no-themes"],
			task: "No model request", sessionEnabled: true, sessionFile, cwd,
			inheritProjectContext: false, inheritSkills: false, extensions: [extension], projectTrust: "no-approve" });
		const child = spawnSync(process.execPath, [join(host, JSON.parse(readFileSync(join(host, "package.json"), "utf8")).bin.pi), ...built.args], {
			// Production callers spawn in the requested cwd. The saved case additionally proves native header restoration.
			cwd: scenario === "saved" ? join(root, "launch") : cwd, input: "", encoding: "utf8", timeout: 15_000,
			env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
				PI_CODING_AGENT_DIR: join(root, "agent"), PI_PACKAGE_DIR: host, PI_OFFLINE: "1", ...built.env },
		});
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		assert.equal(built.args.includes("--session-cwd"), false);
		assert.equal(readFileSync(join(root, "calls.txt"), "utf8"), "0");
		return JSON.parse(readFileSync(output, "utf8"));
	}
	const observed = launch();
	assert.equal(observed.cwd, scenario === "different" ? cwd : root);
	assert.equal(observed.file, sessionFile);
	if (scenario === "missing") {
		assert.ok(observed.id);
		assert.equal(existsSync(sessionFile), false, "native Pi defers new-file persistence until an assistant message");
		// Persist synthetic history through the native SDK, without making a model request.
		// The CLI above is the initial-launch regression; subsequent launches exercise the resulting real file.
		const { SessionManager } = await import(pathToFileURL(join(host, "dist/index.js")).href);
		const sdkEntry = pathToFileURL(join(host, "dist/index.js"));
		const aiRoot = dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)!);
		const { fauxAssistantMessage } = await import(pathToFileURL(join(aiRoot, "dist/index.js")).href);
		const session = SessionManager.open(sessionFile, undefined, root);
		session.appendModelChange("faux", "faux-1");
		session.appendThinkingLevelChange("off");
		session.appendMessage(fauxAssistantMessage("Synthetic saved history; no model request"));
		const savedBytes = readFileSync(sessionFile, "utf8");
		assert.equal(JSON.parse(savedBytes.split("\n")[0]).cwd, root);
		for (let attempt = 0; attempt < 2; attempt++) {
			assert.deepEqual(launch(), { cwd: root, id: session.getSessionId(), file: sessionFile });
			assert.equal(readFileSync(sessionFile, "utf8"), savedBytes, "created session identity/history must survive resume unchanged");
		}
	} else {
		assert.equal(observed.id, "same-cwd-fixture");
		assert.equal(readFileSync(sessionFile, "utf8"), bytes, "native resume must preserve saved history");
	}
	t.diagnostic(`Host: ${host}; synthetic resume evidence: ${root}`);
});
