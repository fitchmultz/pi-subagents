import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { JournalFrames, NativeJournal, readOutputPage } from "../../src/shared/journal-reader.ts";
import { readNativeUsage } from "../../src/runs/shared/native-usage.ts";

const usage = { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, totalTokens: 26,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 7, total: 13 } };
function temporary(t: { after(fn: () => void): void }) {
	const root = fs.mkdtempSync(path.join(tmpdir(), "pi-subagents-journal-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

test("JSONL cursors commit complete validated records across one-byte Unicode chunks and keep torn tails", () => {
	const values: unknown[] = [], frames = new JournalFrames(() => true, ({ value }) => values.push(value), "live");
	const complete = Buffer.from('{"id":"🦄","ignored":{"text":"\\uD83E\\uDD84"}}\r\n');
	for (const byte of complete) frames.write(Buffer.from([byte]));
	frames.write(Buffer.from('{"id":"later"'));
	assert.equal(frames.finish(), complete.length);
	assert.deepEqual(values, [{ id: "🦄", ignored: { text: "🦄" } }]);
	frames.write(Buffer.from('}\n'));
	assert.equal(frames.finish(), complete.length + Buffer.byteLength('{"id":"later"}\n'));
	assert.deepEqual(values[1], { id: "later" });
	const skipped = new JournalFrames((path) => !path.length || path[0] === "id", () => assert.fail("malformed skipped data cannot commit"));
	skipped.write(Buffer.from('{"id":"x","ignored":{"bad":truX}}'));
	assert.throws(() => skipped.finish(), SyntaxError);
});

test("sealed inspection accepts a valid unterminated record without repair; strict accounting rejects malformed required records", (t) => {
	const root = temporary(t), file = path.join(root, "native.jsonl");
	const original = '{"type":"session","id":"child","version":3}\n{"type":"model_change","id":"m","parentId":null,"provider":"p","modelId":"m"}';
	fs.writeFileSync(file, original);
	assert.equal(new NativeJournal(file).configuration().model, "p/m");
	assert.equal(fs.readFileSync(file, "utf8"), original);
	assert.equal(new NativeJournal(file, "live").records.length, 1);
	fs.appendFileSync(file, '\n{"type":"custom","id":"broken","data":[1,]}\n');
	assert.throws(() => readNativeUsage(file, new Set()), SyntaxError);
});

test("strict/live JSONL reject non-object roots and invalid UTF-8 inside skipped payloads without committing their cursors", () => {
	const invalid = Buffer.concat([Buffer.from('{"ignored":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]);
	for (const policy of ["strict", "live"] as const) for (const bytes of [invalid, Buffer.from("[]\n"), Buffer.from("null\n"), Buffer.from('"scalar"\n')]) {
		const records: unknown[] = [], reader = new JournalFrames((path) => !path.length, ({ value }) => records.push(value), policy);
		reader.write(Buffer.from('{"id":"committed"}\n'));
		assert.throws(() => reader.write(bytes), SyntaxError);
		assert.deepEqual(records, [{}], "only the prior selected object was committed");
	}
});

test("output pages preserve Unicode at byte boundaries and do not read the preceding output", (t) => {
	const file = path.join(temporary(t), "output");
	fs.writeFileSync(file, "prefix\n🦄日本語\nend");
	const first = readOutputPage(file, { offset: 7, length: 5 });
	assert.equal(first.text, "🦄");
	const next = readOutputPage(file, { offset: first.nextOffset, length: 9 });
	assert.equal(next.text, "日本語");
	assert.equal(readOutputPage(file, { length: 4 }).text, "\nend");
});

test("a valid ignored individual value larger than Node's string ceiling preserves billing, configuration, baselines and source bytes under a 96 MiB heap", { timeout: 180_000 }, (t) => {
	const root = temporary(t), file = path.join(root, "native.jsonl"), fd = fs.openSync(file, "wx"), hash = createHash("sha256");
	const write = (value: string | Buffer) => { fs.writeSync(fd, value); hash.update(value); };
	const timestamp = "2026-01-01T00:00:00Z";
	write(JSON.stringify({ type: "session", version: 3, id: "child", cwd: root, timestamp }) + "\n");
	write(JSON.stringify({ type: "message", id: "inherited", parentId: null, timestamp, message: { role: "assistant", provider: "p", model: "old", content: [], usage } }) + "\n");
	write('{"type":"custom","id":"noise","parentId":"inherited","data":{"ignored":"');
	const block = Buffer.alloc(64 * 1024, 120);
	for (let index = 0; index < 8193; index++) write(block);
	write('"}}\n');
	for (const [id, parentId, role] of [["paid", "noise", "assistant"], ["abandoned", "inherited", "toolResult"], ["terminal", "paid", "assistant"]]) {
		write(JSON.stringify({ type: "message", id, parentId, timestamp, message: { role, provider: "p", model: "selected", responseModel: "actual", toolCallId: "tool", toolName: "child", isError: false, usage,
			content: [{ type: "text", text: id === "terminal" ? "Final 🦄 answer" : id }] } }) + "\n");
	}
	fs.closeSync(fd);
	const checksum = hash.digest("hex");
	const nativeModule = new URL("../../src/runs/shared/native-usage.ts", import.meta.url).href;
	const journalModule = new URL("../../src/shared/journal-reader.ts", import.meta.url).href;
	const historyModule = new URL("../../src/tui/agent-history.ts", import.meta.url).href;
	const check = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", `
		import assert from 'node:assert/strict'; import {createHash} from 'node:crypto'; import {createReadStream} from 'node:fs';
		import {snapshotNativeUsage,readNativeUsage} from ${JSON.stringify(nativeModule)};
		import {NativeJournal} from ${JSON.stringify(journalModule)}; import {NativeAgentHistory} from ${JSON.stringify(historyModule)};
		const file=process.argv[1];
		assert.deepEqual([...snapshotNativeUsage(file)],['child','inherited','noise','paid','abandoned','terminal']);
		const totals=readNativeUsage(file,new Set(['child','inherited']),['paid','terminal']);
		assert.deepEqual(totals.map(x=>[x.input,x.output,x.cost,x.turns]),[[3,5,13,1],[6,10,26,1]]);
		assert.deepEqual(totals.flatMap(x=>x.contributions.map(c=>c.id)),['child:paid','child:abandoned','child:terminal']);
		const history=new NativeAgentHistory();
		assert.equal(history.configuration(file).model,'p/selected');
		assert.equal(history.page(file,0,2).items.length,2);
		assert.equal(history.entry(file,'terminal').message.content[0].text,'Final 🦄 answer');
		const hash=createHash('sha256'); for await(const bytes of createReadStream(file)) hash.update(bytes);
		assert.equal(hash.digest('hex'),process.argv[2]); console.log('bounded native storage: exact counters/IDs/configuration/history, source unchanged, heap limit 96 MiB');
	` , file, checksum], { encoding: "utf8", timeout: 170_000, maxBuffer: 64 * 1024 });
	assert.equal(check.status, 0, check.stderr);
	t.diagnostic(check.stdout.trim());
	// A successor may append paid work to the same journal. The predecessor's
	// physical terminal entry, rather than a wall-clock cutoff, stays authoritative.
	fs.appendFileSync(file, JSON.stringify({ type: "usage", id: "successor", parentId: "terminal", usage, provider: "later", model: "later" }) + "\nnot JSON\n");
	assert.equal(readNativeUsage(file, new Set(["child", "inherited"]), [], { terminalEntryId: "terminal" })![0]!.input, 9);
	assert.throws(() => readNativeUsage(file, new Set()), SyntaxError);
});
