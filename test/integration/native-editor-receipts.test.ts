import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createMutationCompletionTracker } from "../../src/runs/shared/mutating-tool-guard.ts";

const editor = process.env.PI_EDITOR_RECEIPT_TEST_ROOT;
test("actual editor receipts reach the mutation guard through native tool events", { skip: !editor, timeout: 30_000 }, async (t) => {
	const sdkRoot = process.env.PI_EDITOR_RECEIPT_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
	const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
	const sdk = await import(sdkEntry.href);
	const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)!);
	const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
	const { default: registerEditor } = await import(pathToFileURL(path.join(editor!, "extensions/apply-edits.ts")).href);
	const evidenceRoot = process.env.PI_EDITOR_RECEIPT_EVIDENCE_DIR;
	if (evidenceRoot) fs.mkdirSync(evidenceRoot, { recursive: true });
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(evidenceRoot ?? os.tmpdir(), "native-editor-receipts-")));
	for (const file of ["a", "b", "c"]) fs.writeFileSync(path.join(cwd, file), "before\n");
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ provider: "editor-receipt-fixture" });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [(pi) => registerEditor({ ...pi, registerTool(tool) {
			pi.registerTool({ ...tool, async execute(id, params, signal, update, ctx) {
				if (tool.name !== "write_files" || params.files.length !== 3) return tool.execute(id, params, signal, update, ctx);
				const cancellation = new AbortController();
				return tool.execute(id, params, cancellation.signal, (progress) => {
					update?.(progress);
					if (progress.content.some((part) => part.type === "text" && part.text.startsWith("Completed 1/"))) cancellation.abort();
				}, ctx);
			} });
		} })] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
	const { session } = await sdk.createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: manager });
	const errors = [], receipts = [];
	const tracker = createMutationCompletionTracker();
	await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
	session.subscribe((event) => {
		if (event.type === "tool_execution_start") tracker.recordToolStart({ id: event.toolCallId, toolName: event.toolName, args: event.args });
		if (event.type === "message_end" && event.message.role === "toolResult") receipts.push({ message: event.message, tracked: tracker.recordToolResult(event.message) });
	});
	t.after(async () => { await session.abort(); session.dispose(); if (!evidenceRoot) fs.rmSync(cwd, { recursive: true, force: true }); });
	const calls = [
		["preview_patch", { input: "*** Begin Patch\n*** Add File: planned\n+never\n*** End Patch" }],
		["write_files", { files: [{ path: "a", content: "preview\n", mode: "replace" }], preview: true }],
		["write_files", { files: ["a", "b", "c"].map((file) => ({ path: file, content: "after\n", mode: "replace" })) }],
		["write_files", { files: [{ path: "a", content: "after\n", mode: "replace" }] }],
		["replace_text", { files: [{ path: "c", edits: [{ oldText: "before", newText: "changed" }] }] }],
		["apply_patch", { input: "*** Begin Patch\n*** Add File: added\n+verified\n*** End Patch" }],
	];
	faux.setResponses([...calls.map(([name, args]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" })), fauxAssistantMessage("Fixture complete")]);
	await session.prompt("Execute the controlled editor fixtures");
	assert.deepEqual(errors, []);
	assert.equal(receipts.length, 6);
	assert.deepEqual(receipts.map((receipt) => receipt.tracked?.completedMutation), [false, false, true, false, true, true]);
	assert.equal(receipts[2].message.isError, true, "native error hook preserves the real partial-publication error");
	assert.deepEqual(receipts[2].message.details.modifiedFiles, [path.join(cwd, "a")]);
	assert.deepEqual(receipts[2].message.details.files.map((file) => file.status), ["applied", "failed", "unattempted"]);
	assert.equal(receipts[3].message.details.files[0].status, "unchanged");
	assert.equal(fs.existsSync(path.join(cwd, "planned")), false);
	assert.equal(fs.readFileSync(path.join(cwd, "b"), "utf8"), "before\n");
	assert.equal(fs.readFileSync(path.join(cwd, "added"), "utf8"), "verified\n");
	const consumer = new URL("../../src/runs/shared/mutating-tool-guard.ts", import.meta.url);
	fs.writeFileSync(path.join(cwd, "evidence.json"), JSON.stringify({ sdkRoot, editor,
		editorCommit: execFileSync("git", ["-C", editor!, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		consumerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		consumerSha256: createHash("sha256").update(fs.readFileSync(consumer)).digest("hex"), receipts }, null, 2));
	t.diagnostic(`Actual native editor receipt evidence: ${cwd}`);
});
