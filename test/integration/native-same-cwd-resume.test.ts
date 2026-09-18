import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

const host = process.env.PI_CONTEXT_TEST_PACKAGE_ROOT ?? dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);

test("ordinary native CLI resumes in the saved cwd without requiring a fork-only override", (t) => {
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
	writeFileSync(sessionFile, bytes);
	const extension = join(root, "observer.ts");
	writeFileSync(extension, `import { writeFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
export default function (pi) {
	const faux = fauxProvider();
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(${JSON.stringify(output)}, JSON.stringify({ cwd: ctx.cwd, id: ctx.sessionManager.getSessionId() }));
		ctx.shutdown();
	});
	pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(join(root, "calls.txt"))}, String(faux.state.callCount)));
}`);
	const built = buildPiArgs({ baseArgs: ["--mode", "rpc", "--offline", "--no-prompt-templates", "--no-themes"],
		task: "No model request", sessionEnabled: true, sessionFile, cwd: root,
		inheritProjectContext: false, inheritSkills: false, extensions: [extension], projectTrust: "no-approve" });
	assert.equal(built.args.includes("--session-cwd"), false);
	const child = spawnSync(process.execPath, [join(host, "dist/cli.js"), ...built.args], {
		cwd: join(root, "launch"), input: "", encoding: "utf8", timeout: 15_000,
		env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
			PI_CODING_AGENT_DIR: join(root, "agent"), PI_PACKAGE_DIR: host, PI_OFFLINE: "1", ...built.env },
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { cwd: root, id: "same-cwd-fixture" });
	assert.equal(readFileSync(sessionFile, "utf8"), bytes, "native resume must preserve saved history");
	assert.equal(readFileSync(join(root, "calls.txt"), "utf8"), "0");
	t.diagnostic(`Host: ${host}; synthetic resume evidence: ${root}`);
});
