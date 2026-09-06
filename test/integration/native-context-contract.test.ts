import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/shared/pi-args.ts";

it("native Pi suppresses inherited project files without dropping selected context", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-context-contract-"));
	const packageRoot = process.env.PI_CONTEXT_TEST_PACKAGE_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	try {
		fs.writeFileSync(path.join(root, "AGENTS.md"), "NATIVE_PROJECT_SENTINEL");
		const observer = path.join(root, "observe.ts");
		// Observe the real resource loader and prompt builder, then stop before any model request.
		fs.writeFileSync(observer, `import { writeFileSync } from "node:fs";
export default function(pi) {
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(process.env.CONTEXT_PROBE_OUTPUT, ctx.getSystemPrompt());
		ctx.shutdown();
	});
}`);
		for (const inheritProjectContext of [false, true]) {
			const output = path.join(root, `prompt-${inheritProjectContext}.txt`);
			const built = buildPiArgs({ baseArgs: ["--mode", "rpc", "--no-prompt-templates", "--no-themes"], task: "Do not invoke a model",
				sessionEnabled: false, inheritProjectContext, inheritSkills: false, systemPrompt: "EXPLICIT_SELECTED_CONTEXT", extensions: [observer], projectTrust: "approve" });
			const env = { ...process.env, ...built.env, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1", CONTEXT_PROBE_OUTPUT: output };
			try {
				const child = spawnSync(process.execPath, [path.join(packageRoot, "dist/cli.js"), ...built.args], { cwd: root, env, input: "", encoding: "utf8", timeout: 15_000 });
				assert.equal(child.status, 0, child.stderr);
				const prompt = fs.readFileSync(output, "utf8");
				assert.equal(prompt.includes("NATIVE_PROJECT_SENTINEL"), inheritProjectContext);
				assert.ok(prompt.includes("EXPLICIT_SELECTED_CONTEXT"));
			} finally {
				cleanupTempDir(built.tempDir);
			}
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
