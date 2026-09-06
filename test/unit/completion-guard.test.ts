import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import {
	hasCompletedMutationToolCall,
	resolveCompletionPolicy,
} from "../../src/runs/shared/completion-guard.ts";
import { resolveCurrentPath } from "../../src/runs/shared/mutating-tool-guard.ts";

function assistantToolCall(name: string, args: Record<string, unknown> = {}, id?: string): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: args, ...(id ? { id } : {}) }],
	} as unknown as Message;
}

function toolResult(text: string, isError = false, toolCallId?: string, toolName?: string): Message {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		isError,
		...(toolCallId ? { toolCallId } : {}),
		...(toolName ? { toolName } : {}),
	} as unknown as Message;
}

test("only an explicit completion guard requires mutation; acceptance takes precedence", () => {
	assert.equal(resolveCompletionPolicy({ completionGuardEnabled: true, usesAcceptanceContract: true }), "acceptance-contract");
	assert.equal(resolveCompletionPolicy({ completionGuardEnabled: true, usesAcceptanceContract: false }), "mutation-guard");
	assert.equal(resolveCompletionPolicy({ completionGuardEnabled: false, usesAcceptanceContract: false }), "none");
});

test("edit and write tool calls require successful tool results to count as completed mutation", () => {
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("edit", { path: "a.ts" })]), false);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("edit", { path: "a.ts" }), toolResult("edited a.ts")]), true);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("write", { path: "a.ts" }), toolResult("permission denied", true)]), false);
});

test("native apply_edits counts only after a successful result", () => {
	const call = assistantToolCall("apply_edits", { path: "a.ts", rewrite: "updated" });
	assert.equal(hasCompletedMutationToolCall([call, toolResult("updated a.ts")]), true);
	assert.equal(hasCompletedMutationToolCall([call, toolResult("anchor missing", true)]), false);
});

test("bash activity paths ignore file descriptors and tolerate redirect whitespace", () => {
	assert.equal(resolveCurrentPath("bash", { command: "npm test > /tmp/check.log 2>&1" }), "/tmp/check.log");
	assert.equal(resolveCurrentPath("bash", { command: "npm test 2>&1" }), undefined);
});

test("successful mutating tool results count even when output mentions failure words", () => {
	assert.equal(hasCompletedMutationToolCall([
		assistantToolCall("edit", { path: "a.ts" }),
		toolResult("edited a.ts; tests failed later but the edit succeeded"),
	]), true);
	assert.equal(hasCompletedMutationToolCall([
		assistantToolCall("write", { path: "error.log" }),
		toolResult("wrote error.log; no error found"),
	]), true);
});

test("obvious mutating bash commands require successful tool results to count as completed mutation", () => {
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "mkdir -p src && cat > src/file.ts <<'EOF'\nhi\nEOF" }), toolResult("ok")]), true);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF' > src/file.ts\nhi\nEOF" }), toolResult("ok")]), true);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "python3 -c \"from pathlib import Path; Path('x').write_text('hi')\"" }), toolResult("ok")]), true);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "node script.js > generated.txt" }), toolResult("ok")]), true);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "echo 'a > b'" }), toolResult("ok")]), false);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "node -e \"console.log(a > b)\"" }), toolResult("ok")]), false);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "python3 <<'PY'\nprint('inspect only')\nPY" }), toolResult("ok")]), false);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "echo 'rm file'" }), toolResult("ok")]), false);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "printf \"mkdir x\"" }), toolResult("ok")]), false);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "git apply patch.diff" }), toolResult("ok")]), true);
	assert.equal(hasCompletedMutationToolCall([assistantToolCall("bash", { command: "patch -p0 < fix.patch" }), toolResult("ok")]), true);
});

test("completed mutation matching ignores earlier non-mutating tool results", () => {
	assert.equal(hasCompletedMutationToolCall([
		assistantToolCall("read", { path: "a.ts" }),
		assistantToolCall("edit", { path: "a.ts" }),
		toolResult("file contents"),
	]), false);
	assert.equal(hasCompletedMutationToolCall([
		assistantToolCall("read", { path: "a.ts" }),
		assistantToolCall("edit", { path: "a.ts" }),
		toolResult("file contents"),
		toolResult("edited a.ts"),
	]), true);
});

test("completed mutation matching uses toolCallId when parallel tool results finish out of order", () => {
	assert.equal(hasCompletedMutationToolCall([
		assistantToolCall("edit", { path: "a.ts" }, "edit-1"),
		assistantToolCall("read", { path: "a.ts" }, "read-1"),
		toolResult("file contents", false, "read-1", "read"),
		toolResult("edited a.ts", false, "edit-1", "edit"),
	]), true);
});
